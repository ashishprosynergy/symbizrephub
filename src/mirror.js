'use strict';
/**
 * A full copy of Symbiz's Zoho CRM records that Rep Hub works with, kept in
 * Rep Hub's own database and refreshed every night.
 *
 * Zoho is still the master: Rep Hub reads from it and writes to it as before.
 * This copy is the insurance. If Zoho can't be reached, a record is deleted
 * there by mistake, or the account is ever lost, every member, ring, call,
 * meeting, event and registration is still here, with every field, and goes
 * out in the backup. A record that disappears from Zoho is never removed
 * from the copy; it is marked with the date it went missing.
 */
const cfg = require('./config');
const zoho = require('./lib/zoho');
const { query, q } = require('./db');

const M = cfg.modules;
const MODULES = [M.RING, M.GROUP_MEMBER, M.CONTACT, M.ACTIVITY, M.MEETING, M.EVENT, M.REGISTRATION, M.REGION,
  'Leads', 'Accounts', 'Attendance_N'];
// Field types COQL can't select
const SKIP = /^(subform|multiselectlookup|fileupload|imageupload|profileimage|multi_module_lookup|consent_lookup)$/i;

async function fieldsOf(module) {
  const out = await zoho.request('/settings/fields', { query: { module } });
  return (out?.fields || []).filter(f => f.api_name && !SKIP.test(f.data_type || '')).map(f => f.api_name);
}

/** Every record, every field: COQL takes 50 fields at a time, so ask in groups
    and put each record back together. A group Zoho refuses is split until the
    field it doesn't like is found and left out. */
async function readAll(module, fields) {
  const byId = new Map(), skipped = [];
  const ask = async group => {
    const cols = ['id', ...group.filter(f => f !== 'id')];
    try {
      const rows = await zoho.coqlPaged(`select ${cols.join(', ')} from ${module} where id is not null limit 200`, { gentle: true });
      rows.forEach(r => byId.set(r.id, Object.assign(byId.get(r.id) || {}, r)));
    } catch (e) {
      if (group.length === 1) { skipped.push(group[0]); return; }
      const half = Math.ceil(group.length / 2);
      await ask(group.slice(0, half)); await ask(group.slice(half));
    }
  };
  for (let i = 0; i < fields.length; i += 45) await ask(fields.slice(i, i + 45));
  return { rows: [...byId.values()], skipped };
}

async function mirrorModule(module) {
  const started = new Date();
  const fields = await fieldsOf(module);
  const { rows, skipped } = await readAll(module, fields);
  for (const r of rows) {
    await query(`INSERT INTO zoho_mirror (module, id, data, modified, seen_at, missing_since)
      VALUES ($1, $2, $3, $4, now(), NULL)
      ON CONFLICT (module, id) DO UPDATE SET data = EXCLUDED.data, modified = EXCLUDED.modified, seen_at = now(), missing_since = NULL`,
      [module, String(r.id), JSON.stringify(r), r.Modified_Time || null]);
  }
  // Gone from Zoho since the last copy: kept, and marked — never deleted here
  const gone = rows.length
    ? await query('UPDATE zoho_mirror SET missing_since = now() WHERE module = $1 AND seen_at < $2 AND missing_since IS NULL RETURNING id', [module, started])
    : [];
  return { module, records: rows.length, fields: fields.length - skipped.length, skipped, missingNow: gone.length };
}

/** Copy every module, as far as time allows; returns what was done */
async function runMirror({ budgetMs = 13 * 60 * 1000 } = {}) {
  const t0 = Date.now(), results = [];
  for (const m of MODULES) {
    if (Date.now() - t0 > budgetMs) { results.push({ module: m, error: 'not reached this run' }); continue; }
    try { results.push(await mirrorModule(m)); }
    catch (e) { results.push({ module: m, error: String(e.message || e).slice(0, 300) }); }
  }
  const summary = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), results };
  await q.setSetting('zoho_mirror_last', JSON.stringify(summary)).catch(() => {});
  return summary;
}

/* ── Live: changes copied as they happen, not just overnight ──
   Every change Rep Hub makes in Zoho, and every change Zoho tells us about
   (records edited or deleted directly in Zoho), goes on this queue; the
   record is then read back from Zoho with every field and saved here. */
async function queueChange(module, ids, op = 'update') {
  for (const id of (ids || []).filter(Boolean)) {
    await query(`INSERT INTO zoho_mirror_queue (module, id, op, at, tries) VALUES ($1, $2, $3, now(), 0)
      ON CONFLICT (module, id) DO UPDATE SET op = EXCLUDED.op, at = now(), tries = 0`, [module, String(id), op]).catch(() => {});
  }
}
async function saveRecord(module, rec) {
  await query(`INSERT INTO zoho_mirror (module, id, data, modified, seen_at, missing_since) VALUES ($1, $2, $3, $4, now(), NULL)
    ON CONFLICT (module, id) DO UPDATE SET data = EXCLUDED.data, modified = EXCLUDED.modified, seen_at = now(), missing_since = NULL`,
    [module, String(rec.id), JSON.stringify(rec), rec.Modified_Time || null]);
}
async function processQueue({ budgetMs = 6000, limit = 200 } = {}) {
  const t0 = Date.now();
  const items = await query('SELECT module, id, op, tries FROM zoho_mirror_queue WHERE tries < 5 ORDER BY at LIMIT $1', [limit]).catch(() => []);
  let saved = 0, deleted = 0, failed = 0;
  for (const it of items) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      if (it.op === 'delete') {
        // Gone from Zoho: kept here, marked
        await query('UPDATE zoho_mirror SET missing_since = COALESCE(missing_since, now()) WHERE module = $1 AND id = $2', [it.module, it.id]);
        deleted++;
      } else {
        const rec = await zoho.getRecord(it.module, it.id);       // every field
        if (rec) { await saveRecord(it.module, rec); saved++; }
        else { await query('UPDATE zoho_mirror SET missing_since = COALESCE(missing_since, now()) WHERE module = $1 AND id = $2', [it.module, it.id]); deleted++; }
      }
      await query('DELETE FROM zoho_mirror_queue WHERE module = $1 AND id = $2', [it.module, it.id]);
    } catch (e) {
      failed++;
      await query('UPDATE zoho_mirror_queue SET tries = tries + 1 WHERE module = $1 AND id = $2', [it.module, it.id]).catch(() => {});
    }
  }
  const left = (await query('SELECT COUNT(*)::int AS n FROM zoho_mirror_queue WHERE tries < 5').catch(() => [{ n: 0 }]))[0].n;
  if (saved || deleted) await q.setSetting('zoho_mirror_live_last', new Date().toISOString()).catch(() => {});
  return { saved, deleted, failed, left };
}

/* ── Zoho's notifications: Zoho tells Rep Hub the moment a record changes ──
   Needs its own permission (ZohoCRM.notifications.ALL), connected from
   Settings with a Self Client code, kept apart from the main connection. */
const NOTIFY_KEY = 'zoho_notify_refresh_token';
let notifyToken = { access: null, expiresAt: 0 };
async function notifyAccess() {
  if (notifyToken.access && Date.now() < notifyToken.expiresAt - 60000) return notifyToken.access;
  const refresh = (await q.getSetting(NOTIFY_KEY))?.value;
  if (!refresh) throw new Error('Live updates are not connected');
  const params = new URLSearchParams({ refresh_token: refresh, client_id: cfg.zoho.clientId, client_secret: cfg.zoho.clientSecret, grant_type: 'refresh_token' });
  const res = await fetch(`${cfg.zoho.accountsDomain}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) throw new Error(`Zoho sign-in for live updates failed${body.error ? ': ' + body.error : ''}. Connect it again.`);
  notifyToken = { access: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return notifyToken.access;
}
async function connectNotify(code) {
  const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.zoho.clientId, client_secret: cfg.zoho.clientSecret, code: String(code || '').trim() });
  const res = await fetch(`${cfg.zoho.accountsDomain}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!body.refresh_token) {
    throw new Error(body.error === 'invalid_code' ? 'That code has expired or was already used — make a new one.'
      : body.error === 'invalid_client' ? 'The code was made under a different Zoho client than Rep Hub uses.' : `Zoho said: ${body.error || res.status}.`);
  }
  await q.setSetting(NOTIFY_KEY, body.refresh_token);
  notifyToken = { access: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
}
const LIVE_MODULES = () => MODULES.filter(m => m !== 'Attendance_N');
/** Ask Zoho to tell us about changes (again): a watch lasts a day, so it is renewed nightly and whenever it is close to running out */
async function ensureWatch(site, { force = false } = {}) {
  if (!(await q.getSetting(NOTIFY_KEY))?.value) return { connected: false };
  let w = null; try { w = JSON.parse((await q.getSetting('zoho_watch'))?.value || 'null'); } catch { w = null; }
  if (!force && w && w.until && new Date(w.until).getTime() - Date.now() > 3 * 3600 * 1000) return { connected: true, renewed: false, until: w.until };
  const secret = (w && w.secret) || require('crypto').randomBytes(16).toString('hex');
  const channel = (w && w.channel) || String(Date.now()).slice(-9);
  const until = new Date(Date.now() + 23 * 3600 * 1000);
  const expiry = until.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const res = await fetch(`${cfg.zoho.apiDomain}/crm/v8/actions/watch`, {
    method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${await notifyAccess()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ watch: [{ channel_id: channel, events: LIVE_MODULES().map(m => `${m}.all`), channel_expiry: expiry,
      token: secret, notify_url: `${String(site).replace(/\/$/, '')}/api/zoho/notify` }] }),
  });
  const body = await res.json().catch(() => ({}));
  const ok = res.ok && body.watch && body.watch.every(x => String(x.code || x.status).toUpperCase() === 'SUCCESS');
  const state = { channel, secret, until: ok ? until.toISOString() : (w && w.until) || null, at: new Date().toISOString(),
    error: ok ? null : JSON.stringify(body.watch || body).slice(0, 400) };
  await q.setSetting('zoho_watch', JSON.stringify(state));
  if (!ok) throw new Error(`Zoho would not set up live updates: ${state.error}`);
  return { connected: true, renewed: true, until: state.until };
}
/** A notification from Zoho: which records changed, and how */
async function onNotify(body) {
  let w = null; try { w = JSON.parse((await q.getSetting('zoho_watch'))?.value || 'null'); } catch { w = null; }
  if (!w || !body || body.token !== w.secret) return { ok: false };
  const op = /delete/i.test(body.operation || '') ? 'delete' : 'update';
  await queueChange(body.module, body.ids || [], op);
  await q.setSetting('zoho_notify_last', new Date().toISOString()).catch(() => {});
  return { ok: true, queued: (body.ids || []).length };
}

async function mirrorStatus() {
  let last = null; try { last = JSON.parse((await q.getSetting('zoho_mirror_last'))?.value || 'null'); } catch { last = null; }
  const counts = await query(`SELECT module, COUNT(*)::int AS n, COUNT(missing_since)::int AS missing, MAX(seen_at) AS last
    FROM zoho_mirror GROUP BY module ORDER BY module`).catch(() => []);
  let watch = null; try { watch = JSON.parse((await q.getSetting('zoho_watch'))?.value || 'null'); } catch { watch = null; }
  const queued = (await query('SELECT COUNT(*)::int AS n FROM zoho_mirror_queue WHERE tries < 5').catch(() => [{ n: 0 }]))[0].n;
  return { last, modules: counts, live: {
    connected: !!(await q.getSetting(NOTIFY_KEY))?.value, until: watch && watch.until, error: watch && watch.error,
    lastNotice: (await q.getSetting('zoho_notify_last'))?.value || null, lastSaved: (await q.getSetting('zoho_mirror_live_last'))?.value || null, queued } };
}

module.exports = { runMirror, mirrorStatus, MODULES, readAll, queueChange, processQueue, connectNotify, ensureWatch, onNotify };

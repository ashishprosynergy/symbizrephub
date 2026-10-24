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
      const rows = await zoho.coqlPaged(`select ${cols.join(', ')} from ${module} where id is not null limit 200`);
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

async function mirrorStatus() {
  let last = null; try { last = JSON.parse((await q.getSetting('zoho_mirror_last'))?.value || 'null'); } catch { last = null; }
  const counts = await query(`SELECT module, COUNT(*)::int AS n, COUNT(missing_since)::int AS missing, MAX(seen_at) AS last
    FROM zoho_mirror GROUP BY module ORDER BY module`).catch(() => []);
  return { last, modules: counts };
}

module.exports = { runMirror, mirrorStatus, MODULES, readAll };

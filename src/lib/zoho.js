'use strict';
/**
 * Zoho CRM client.
 *
 * Auth model: ONE self-client OAuth grant owned by the organisation.
 * Reps never hold Zoho credentials and never consume a Zoho seat —
 * every request from the app funnels through this single client.
 *
 * Zoho limits are CONCURRENCY based (simultaneous in-flight calls),
 * not requests-per-minute, so we cap in-flight requests rather than
 * throttling by clock. Enterprise allows 20 concurrent; we stay under.
 */

const cfg = require('../config');

const API = () => `${cfg.zoho.apiDomain}/crm/v8`;
const ACCOUNTS = () => cfg.zoho.accountsDomain;

/* ─────────── token cache ─────────── */
let token = { access: null, expiresAt: 0 };
let refreshInFlight = null;
let rejectedAccess = null;   // a token Zoho just refused, so the shared copy is not reused

/**
 * The token is also kept in the database, shared by every running copy of
 * the function. Each copy used to fetch its own on start-up: opening the app
 * fires a dozen calls at once, so a dozen fresh copies each waited on Zoho's
 * token endpoint — which Zoho also rate limits — before doing any work.
 */
const SHARED_KEY = 'zoho_access_token';
async function loadShared() {
  try {
    const { setting } = require('../db');
    const t = JSON.parse(await setting(SHARED_KEY, 'null'));
    if (t && t.access && t.access !== rejectedAccess && Date.now() < t.expiresAt - 60_000) return t;
  } catch (_) { /* no database: just refresh */ }
  return null;
}
function saveShared(t) {
  try { require('../db').q.setSetting(SHARED_KEY, JSON.stringify(t)).catch(() => {}); } catch (_) {}
}

async function getAccessToken() {
  // 60s safety margin so a token never expires mid-request
  if (token.access && Date.now() < token.expiresAt - 60_000) return token.access;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const shared = await loadShared();
    if (shared) { token = shared; return token.access; }

    const params = new URLSearchParams({
      refresh_token: cfg.zoho.refreshToken,
      client_id: cfg.zoho.clientId,
      client_secret: cfg.zoho.clientSecret,
      grant_type: 'refresh_token',
    });
    const res = await fetch(`${ACCOUNTS()}/oauth/v2/token?${params}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new ZohoError('Token refresh failed', res.status, body);
    }
    token = {
      access: body.access_token,
      expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
    };
    saveShared(token);
    return token.access;
  })();

  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

class ZohoError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;
    this.body = body;
  }
}

/* ─────────── concurrency gate ─────────── */
let active = 0;
const waiting = [];
function acquire() {
  if (active < cfg.zoho.maxConcurrent) { active++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) { active++; next(); }
}

/* ─────────── core request ─────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(path, { method = 'GET', body, query, _attempt = 0, _inner = false } = {}) {
  // Anything that changes Zoho makes cached answers out of date. COQL reads
  // are POSTs too, so they are let through.
  const writing = method !== 'GET' && path !== '/coql';
  if (writing && !_inner) {
    await clearCache();
    // Cleared again once the change is in Zoho, so no copy of the function
    // can keep an answer it read while the change was being made
    try { return await request(path, { method, body, query, _attempt, _inner: true }); }
    finally { await clearCache(); }
  }
  await acquire();
  try {
    const url = new URL(`${API()}${path}`);
    if (query) Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const access = await getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${access}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;            // no content
    if (res.status === 304) return { data: [] };     // not modified

    const text = await res.text();
    const json = text ? safeJSON(text) : null;

    // 401 → token rejected; force refresh once and retry
    if (res.status === 401 && _attempt === 0) {
      rejectedAccess = access;
      token = { access: null, expiresAt: 0 };
      release();
      return request(path, { method, body, query, _attempt: 1 });
    }

    // 429 / 5xx → exponential backoff
    if ((res.status === 429 || res.status >= 500) && _attempt < cfg.zoho.maxRetries) {
      const wait = Math.min(2 ** _attempt * 500 + Math.random() * 300, 8000);
      release();
      await sleep(wait);
      return request(path, { method, body, query, _attempt: _attempt + 1 });
    }

    if (!res.ok) {
      const why = [json && json.code, json && json.message].filter(Boolean).join(': ');
      throw new ZohoError(`Zoho ${method} ${path} failed (${res.status}${why ? ' ' + why : ''})`, res.status, json);
    }
    return json;
  } finally {
    // release only if this frame still holds the slot
    if (_attempt === 0 || active > 0) { try { release(); } catch (_) {} }
  }
}

function safeJSON(t) { try { return JSON.parse(t); } catch { return { raw: t }; } }

/* ─────────── record operations ─────────── */

async function getRecords(module, { fields, page = 1, perPage = 200, criteria, sortBy, sortOrder } = {}) {
  const q = { page, per_page: Math.min(perPage, 200) };
  if (fields) q.fields = Array.isArray(fields) ? fields.join(',') : fields;
  if (sortBy) { q.sort_by = sortBy; q.sort_order = sortOrder || 'asc'; }
  const path = criteria ? `/${module}/search` : `/${module}`;
  if (criteria) q.criteria = criteria;
  const out = await request(path, { query: q });
  return out?.data || [];
}

/** Walk every page of a module. Guards against runaway loops. */
async function getAllRecords(module, opts = {}) {
  const all = [];
  for (let page = 1; page <= (opts.maxPages || 25); page++) {
    const batch = await getRecords(module, { ...opts, page });
    all.push(...batch);
    if (batch.length < (opts.perPage || 200)) break;
  }
  return all;
}

async function getRecord(module, id) {
  const out = await request(`/${module}/${id}`);
  return out?.data?.[0] || null;
}

/**
 * COQL — SQL-ish querying. Far cheaper than pulling a module and
 * filtering in memory. Max 200 rows per call; caller pages via offset.
 */
/**
 * Recent answers, briefly. Opening the app asks the same questions several
 * times over (nearly every call first looks up the user's rings), and each
 * trip to Zoho is the slowest part of any request. Any write clears it, so a
 * change made here shows straight away.
 */
const cache = new Map();
// Two minutes: long enough that moving between screens never waits on Zoho,
// short enough that a change made directly in Zoho shows soon. Anything Rep
// Hub writes clears it at once (see request()).
const cacheMs = () => parseInt(process.env.ZOHO_CACHE_SECONDS ?? '120', 10) * 1000;
/* The same answers, shared by every running copy of the function. Opening
   the app fires a dozen requests at once and Netlify spreads them over
   several copies, each with an empty memory: each asked Zoho the same slow
   questions. Now the first copy's answer is kept in the database for the
   others (a few milliseconds to read, against seconds from Zoho). */
const crypto = require('crypto');
const keyOf = q => crypto.createHash('sha1').update(q).digest('hex');
async function sharedGet(q, ttl) {
  try {
    const { one } = require('../db');
    const row = await one('SELECT body, at FROM zoho_cache WHERE key = $1', [keyOf(q)]);
    if (row && Date.now() - new Date(row.at).getTime() < ttl) return JSON.parse(row.body);
  } catch (_) { /* no database or no table yet: ask Zoho */ }
  return null;
}
function sharedPut(q, rows) {
  try {
    const { query } = require('../db');
    query(`INSERT INTO zoho_cache (key, body, at) VALUES ($1, $2, now())
      ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, at = now()`, [keyOf(q), JSON.stringify(rows)]).catch(() => {});
    // Now and then, drop answers nobody has asked for in an hour
    if (Math.random() < 0.05) query("DELETE FROM zoho_cache WHERE at < now() - interval '1 hour'").catch(() => {});
  } catch (_) {}
}
/** Forget every saved answer, here and for the other copies. Returns when the shared copy is gone. */
function clearCache() {
  cache.clear();
  if (cacheMs() <= 0) return Promise.resolve();
  try { return require('../db').query('DELETE FROM zoho_cache').catch(() => {}); } catch (_) { return Promise.resolve(); }
}
/* One copy asks Zoho; the others wait for its answer. When the whole team
   opens the app together, dozens of copies start at once with nothing saved
   yet, and all asking Zoho the same question would hit its limit on how many
   requests it takes at a time. A short-lived row in the database says
   "someone is fetching this"; it lapses after 15 seconds if that copy dies. */
async function claimFetch(q) {
  try {
    const { query } = require('../db'), k = 'lock:' + keyOf(q);
    // A plain insert: the row already being there (another copy holds it) is the answer "no"
    const claim = () => query("INSERT INTO zoho_cache (key, body, at) VALUES ($1, '', now())", [k])
      .then(() => [k], e => { if (/duplicate|unique|23505/i.test(`${e.code} ${e.message}`)) return []; throw e; });
    if ((await claim()).length) return true;
    const old = await query('SELECT at FROM zoho_cache WHERE key = $1', [k]);
    if (!old.length || Date.now() - new Date(old[0].at).getTime() > 15000) {
      await query('DELETE FROM zoho_cache WHERE key = $1', [k]);
      return (await claim()).length > 0;
    }
    return false;
  } catch (_) { return true; }      // no database: just ask Zoho
}
function releaseFetch(q) {
  try { require('../db').query('DELETE FROM zoho_cache WHERE key = $1', ['lock:' + keyOf(q)]).catch(() => {}); } catch (_) {}
}
async function waitShared(q, ttl, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 250));
    const got = await sharedGet(q, ttl);
    if (got) return got;
  }
  return null;                       // it never came: ask Zoho ourselves
}
const inflight = new Map();      // the same question asked twice at once goes to Zoho once

/**
 * Every row, not just the first 200.
 *
 * Zoho hands back at most 200 rows per query. A query written "limit 200"
 * used to stop there silently, so lists with more (members in 20 rings,
 * every membership link) came back short — and short by a different amount
 * each time, which is why totals wandered. Such queries are now paged, in a
 * fixed order (by id, unless the query sorts itself), until a short page.
 * Pages are fetched a few at a time so long lists stay quick.
 */
const PAGE = 200, MAX_ROWS = 10000, WAVE = 4;
/* `gentle`: one page at a time with a short pause between, for the overnight
   copy of whole modules. Four pages at once there took Zoho's room for COQL,
   and people using the app saw "Zoho POST /coql failed" while it ran. */
/* A field renamed or deleted in Zoho made every query naming it fail, and
   with it whole screens ("column given seems to be invalid": Meeting_Date_Time,
   29 Oct 2026). Now that one column is left out and the query asked again, so
   the app keeps working with one blank field while someone fixes the name. */
const droppedColumns = new Set();
async function coqlOnce(q, tries = 0) {
  let sq = q;
  for (const c of droppedColumns) sq = withoutColumn(sq, c);
  try {
    return await request('/coql', { method: 'POST', body: { select_query: sq } });
  } catch (e) {
    const col = e.status === 400 && e.body && e.body.code === 'INVALID_QUERY' && e.body.details && e.body.details.column_name;
    if (!col || col === 'id' || tries >= 5 || withoutColumn(sq, col) === sq) throw e;
    console.warn(`[zoho] Zoho has no field ${col} any more; leaving it out until the app is updated`);
    droppedColumns.add(col);
    return coqlOnce(q, tries + 1);
  }
}
/** "select a, b, c from X …" without column b (only in the select list) */
function withoutColumn(sq, col) {
  const m = sq.match(/^(\s*select\s+)([\s\S]*?)(\s+from\s[\s\S]*)$/i);
  if (!m) return sq;
  const cols = m[2].split(',').map(s => s.trim()).filter(Boolean);
  const kept = cols.filter(c => c !== col);
  return kept.length && kept.length < cols.length ? m[1] + kept.join(', ') + m[3] : sq;
}

async function coqlPaged(selectQuery, { gentle = false } = {}) {
  const m = selectQuery.match(/\blimit\s+200\s*$/i);
  const one = async q => (await coqlOnce(q))?.data || [];
  if (!m) return one(selectQuery);
  const base = selectQuery.slice(0, m.index).trimEnd();
  const ordered = /\border\s+by\b/i.test(base) ? base : `${base} order by id`;
  const page = offset => one(`${ordered} limit ${offset}, ${PAGE}`);
  const rows = await page(0);
  let offset = PAGE, done = rows.length < PAGE;
  while (!done && offset < MAX_ROWS) {
    if (gentle) await sleep(400);
    const offsets = Array.from({ length: gentle ? 1 : WAVE }, (_, i) => offset + i * PAGE).filter(o => o < MAX_ROWS);
    const pages = await Promise.all(offsets.map(page));
    for (const p of pages) { rows.push(...p); if (p.length < PAGE) { done = true; break; } }
    offset += offsets.length * PAGE;
  }
  const seen = new Set();
  return rows.filter(r => !r || !r.id || (seen.has(r.id) ? false : seen.add(r.id)));
}

async function coql(selectQuery) {
  const ttl = cacheMs();
  if (ttl <= 0) return coqlPaged(selectQuery);
  const hit = cache.get(selectQuery);
  if (hit && Date.now() - hit.at < ttl) return structuredClone(hit.rows);
  if (!inflight.has(selectQuery)) {
    inflight.set(selectQuery, (async () => {
      let shared = await sharedGet(selectQuery, ttl);
      // Another copy is already asking Zoho the same thing: wait for its answer
      if (!shared && !(await claimFetch(selectQuery))) shared = await waitShared(selectQuery, ttl);
      const rows = shared || await coqlPaged(selectQuery).finally(() => releaseFetch(selectQuery));
      if (!shared) sharedPut(selectQuery, rows);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      cache.set(selectQuery, { at: Date.now(), rows: structuredClone(rows) });
      return rows;
    })().finally(() => inflight.delete(selectQuery)));
  }
  return structuredClone(await inflight.get(selectQuery));
}

/** Zoho accepts a maximum of 100 records per insert/update call. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* Every record Rep Hub writes to Zoho is also copied into our own database
   (the live copy): queued here, read back with every field shortly after */
function copyLive(module, ids, op) {
  try { return require('../mirror').queueChange(module, ids, op).catch(() => {}); } catch (_) { return Promise.resolve(); }
}
const idsOf = results => results.map(r => r && r.details && r.details.id).filter(Boolean);

async function insertRecords(module, records, { trigger = [] } = {}) {
  const results = [];
  for (const group of chunk(records, 100)) {
    const out = await request(`/${module}`, { method: 'POST', body: { data: group, trigger } });
    results.push(...(out?.data || []));
  }
  await copyLive(module, idsOf(results));
  return results;
}

async function updateRecords(module, records, { trigger = [] } = {}) {
  const results = [];
  for (const group of chunk(records, 100)) {
    const out = await request(`/${module}`, { method: 'PUT', body: { data: group, trigger } });
    results.push(...(out?.data || []));
  }
  await copyLive(module, idsOf(results).length ? idsOf(results) : records.map(r => r.id));
  return results;
}

async function upsertRecords(module, records, duplicateCheckFields) {
  const results = [];
  for (const group of chunk(records, 100)) {
    const out = await request(`/${module}/upsert`, {
      method: 'POST',
      body: { data: group, duplicate_check_fields: duplicateCheckFields },
    });
    results.push(...(out?.data || []));
  }
  await copyLive(module, idsOf(results));
  return results;
}

async function deleteRecord(module, id) {
  const out = await request(`/${module}/${id}`, { method: 'DELETE' });
  await copyLive(module, [id], 'delete');
  return out;
}

/**
 * Composite request — bundles up to 5 sub-requests into ONE API call.
 * Used to flush an offline queue without burning a call per item.
 */
async function composite(subRequests) {
  const results = [];
  for (const group of chunk(subRequests, 5)) {
    const out = await request('/__composite_requests', {
      method: 'POST',
      body: {
        __composite_requests: group.map((r, i) => ({
          sequence_number: i + 1,
          method: r.method,
          uri: r.uri,
          body: r.body,
        })),
      },
    });
    results.push(...(out?.__composite_requests || []));
  }
  return results;
}

/** Health probe used by /healthz and the setup script. */
let lastPing = { at: 0, value: null };
async function ping() {
  // The sign-in screen checks this every time it shows; once every few
  // minutes is plenty to know Zoho is connected.
  if (lastPing.value && Date.now() - lastPing.at < 5 * 60_000) return lastPing.value;
  const out = await request('/org');
  lastPing = { at: Date.now(), value: out?.org?.[0]?.company_name || 'connected' };
  return lastPing.value;
}

/** A file on a record's Attachments list (the filled-in exit interview form) */
async function attachFile(module, id, filename, content, type = 'application/pdf') {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  const res = await fetch(`${API()}/${module}/${id}/Attachments`, {
    method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${await getAccessToken()}` }, body: form });
  const json = safeJSON(await res.text());
  const r = json && json.data && json.data[0];
  if (!res.ok || !r || (r.code && r.code !== 'SUCCESS')) {
    throw new ZohoError(`Zoho did not take the attachment (${(r && r.message) || (json && json.message) || res.status})`, res.status, json);
  }
  return r.details && r.details.id;
}

module.exports = {
  ZohoError,
  attachFile,
  getAccessToken,
  request,
  getRecords,
  getAllRecords,
  getRecord,
  coql,
  coqlPaged,          // straight to Zoho, no shared cache: for whole-module copies
  insertRecords,
  updateRecords,
  upsertRecords,
  deleteRecord,
  composite,
  ping,
  chunk,
  clearCache,
  _resetTokenForTests: () => { token = { access: null, expiresAt: 0 }; lastPing = { at: 0, value: null }; },
};

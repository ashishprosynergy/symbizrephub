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

async function getAccessToken() {
  // 60s safety margin so a token never expires mid-request
  if (token.access && Date.now() < token.expiresAt - 60_000) return token.access;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
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

async function request(path, { method = 'GET', body, query, _attempt = 0 } = {}) {
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

    if (!res.ok) throw new ZohoError(`Zoho ${method} ${path} failed`, res.status, json);
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
async function coql(selectQuery) {
  const out = await request('/coql', { method: 'POST', body: { select_query: selectQuery } });
  return out?.data || [];
}

/** Zoho accepts a maximum of 100 records per insert/update call. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertRecords(module, records, { trigger = [] } = {}) {
  const results = [];
  for (const group of chunk(records, 100)) {
    const out = await request(`/${module}`, { method: 'POST', body: { data: group, trigger } });
    results.push(...(out?.data || []));
  }
  return results;
}

async function updateRecords(module, records, { trigger = [] } = {}) {
  const results = [];
  for (const group of chunk(records, 100)) {
    const out = await request(`/${module}`, { method: 'PUT', body: { data: group, trigger } });
    results.push(...(out?.data || []));
  }
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
  return results;
}

async function deleteRecord(module, id) {
  return request(`/${module}/${id}`, { method: 'DELETE' });
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
async function ping() {
  const out = await request('/org');
  return out?.org?.[0]?.company_name || 'connected';
}

module.exports = {
  ZohoError,
  getAccessToken,
  request,
  getRecords,
  getAllRecords,
  getRecord,
  coql,
  insertRecords,
  updateRecords,
  upsertRecords,
  deleteRecord,
  composite,
  ping,
  chunk,
  _resetTokenForTests: () => { token = { access: null, expiresAt: 0 }; },
};

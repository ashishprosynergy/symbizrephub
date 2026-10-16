'use strict';
/**
 * Member addresses → map positions, for the member map Mel asked for.
 *
 * Zoho has Latitude/Longitude fields on Contacts but they are empty, so each
 * address is looked up once and kept in the geocodes table:
 *   - US addresses go to the US Census geocoder in one batch (free, no key)
 *   - anything it can't place (Canada, odd spellings) goes to OpenStreetMap's
 *     Nominatim, one a second as its rules require
 * An address that can't be found is remembered too, and tried again after a
 * month rather than on every load.
 */
const cfg = require('../config');

const CA = new Set(['ON', 'QC', 'NS', 'NB', 'MB', 'BC', 'PE', 'SK', 'AB', 'NL', 'NT', 'YT', 'NU',
  'ONTARIO', 'QUEBEC', 'NOVA SCOTIA', 'NEW BRUNSWICK', 'MANITOBA', 'BRITISH COLUMBIA', 'SASKATCHEWAN', 'ALBERTA']);
const RETRY_MISSES_AFTER = 30 * 86400000;

/** One key per address, so the same house is never looked up twice. */
function keyOf(a) {
  return [a.street, a.city, a.state, a.zip].map(s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')).join('|');
}
const hasAddress = a => !!(String(a.street || '').trim() && (String(a.city || '').trim() || String(a.zip || '').trim()));

/** Which addresses still need a position. cache: Map(key → row) */
function missing(addresses, cache) {
  const now = Date.now(), seen = new Set(), out = [];
  addresses.forEach(a => {
    if (!hasAddress(a)) return;
    const k = keyOf(a);
    if (seen.has(k)) return;
    seen.add(k);
    const hit = cache.get(k);
    if (hit && (hit.lat != null || now - new Date(hit.created_at).getTime() < RETRY_MISSES_AFTER)) return;
    out.push({ ...a, key: k });
  });
  return out;
}

const csvCell = s => `"${String(s ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
/** Split one line of the Census reply, which quotes every field. */
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** US Census batch geocoder: up to 10,000 addresses in one upload. */
async function censusBatch(list) {
  if (!list.length) return new Map();
  const csv = list.map((a, i) => [i, a.street, a.city, a.state, a.zip].map(csvCell).join(',')).join('\n');
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', 'Public_AR_Current');
  const url = process.env.CENSUS_GEOCODER_URL || 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
  const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Census geocoder answered ${res.status}`);
  const found = new Map();
  (await res.text()).split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const c = parseCsvLine(line);
    // id, input, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lon,lat", tiger id, side
    if (c[2] !== 'Match' || !c[5]) return;
    const [lng, lat] = c[5].split(',').map(Number);
    const a = list[Number(c[0])];
    if (a && isFinite(lat) && isFinite(lng)) found.set(a.key, { lat, lng });
  });
  return found;
}

/** OpenStreetMap Nominatim, for what the Census can't place. One a second. */
async function nominatim(a) {
  const base = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
  const params = new URLSearchParams({ format: 'json', limit: '1', street: a.street || '', city: a.city || '',
    state: a.state || '', postalcode: a.zip || '', countrycodes: CA.has(String(a.state || '').toUpperCase()) ? 'ca' : 'us,ca' });
  const res = await fetch(`${base}?${params}`, { headers: { 'User-Agent': `SymbizRepHub/1.0 (${cfg.appUrl || 'symbizrep.netlify.app'})` },
    signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0] ? { lat: Number(rows[0].lat), lng: Number(rows[0].lon) } : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Look up every address not yet placed, within the time given.
 * addresses: [{street, city, state, zip}]
 */
async function geocodeMissing(addresses, { budgetMs = 60000 } = {}) {
  const { q } = require('../db');
  const started = Date.now();
  const cache = new Map((await q.allGeocodes()).map(r => [r.address_key, r]));
  const todo = missing(addresses, cache);
  if (!todo.length) return { looked: 0, found: 0, left: 0 };

  const us = todo.filter(a => !CA.has(String(a.state || '').toUpperCase()));
  let found = new Map();
  try { found = await censusBatch(us); } catch (e) { console.error('[geocode] census:', e.message); }
  for (const [k, p] of found) await q.saveGeocode(k, p.lat, p.lng, 'census');

  let rest = todo.filter(a => !found.has(a.key)), done = 0;
  for (const a of rest) {
    if (Date.now() - started > budgetMs) break;
    let p = null;
    try { p = await nominatim(a); } catch (e) { /* tried; noted below */ }
    await q.saveGeocode(a.key, p ? p.lat : null, p ? p.lng : null, p ? 'osm' : 'none');
    if (p) found.set(a.key, p);
    done++;
    await sleep(1100);
  }
  return { looked: us.length + done, found: found.size, left: rest.length - done };
}

module.exports = { keyOf, hasAddress, missing, geocodeMissing, parseCsvLine };

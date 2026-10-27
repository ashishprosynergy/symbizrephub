'use strict';
/**
 * Google Drive: where the nightly backup is kept, outside Rep Hub and outside
 * Zoho, for years. Two ways to connect a Symbiz Google account:
 *
 *  - Apps Script (no Google Cloud project, nothing to pay for): a short script
 *    in the Symbiz account receives each night's file and saves it. Rep Hub
 *    gives the script, with a secret key in it, from Access & security → Backup.
 *  - Google sign-in (OAuth), when GOOGLE_CLIENT_ID/SECRET are set up.
 *
 * Kept for years without piling up: every file for 90 days, one a week for
 * two years, then one a month forever. Or every file, if chosen.
 */
const crypto = require('crypto');
const cfg = require('../config');
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const KEY = 'gdrive';                 // { mode, refresh|url, email, folderId|folderUrl, last }

const configured = () => !!(cfg.google.clientId && cfg.google.clientSecret);
async function state() {
  const { q } = require('../db');
  try { return JSON.parse((await q.getSetting(KEY))?.value || 'null'); } catch { return null; }
}
async function save(s) { const { q } = require('../db'); await q.setSetting(KEY, JSON.stringify(s)); }
async function keepPolicy() { const { setting } = require('../db'); return (await setting('backup_keep', 'smart')) === 'all' ? 'all' : 'smart'; }

/* ── What to keep: the same rule here and in the Apps Script ──
   Oldest first. Under 90 days: every file. 90 days to 2 years: the first of
   each week. Older: the first of each month. Returns the files to delete. */
function toDelete(files, now = Date.now()) {
  const day = 864e5, weeks = new Set(), months = new Set(), out = [];
  files.slice().sort((a, b) => a.t - b.t).forEach(x => {
    const age = (now - x.t) / day;
    if (age <= 90) return;
    if (age <= 730) { const w = Math.floor(x.t / (7 * day)); if (!weeks.has(w)) { weeks.add(w); return; } }
    else { const d = new Date(x.t), m = d.getUTCFullYear() * 12 + d.getUTCMonth(); if (!months.has(m)) { months.add(m); return; } }
    out.push(x);
  });
  return out;
}

/* ── Apps Script ── */
async function scriptKey() {
  const { q, setting } = require('../db');
  let k = await setting('gdrive_script_key', '');
  if (!k) { k = crypto.randomBytes(18).toString('hex'); await q.setSetting('gdrive_script_key', k); }
  return k;
}
async function scriptSource() {
  const k = await scriptKey();
  return `// Rep Hub backups: saves each night's backup file in a "Rep Hub backups" folder in this Drive.
// Paste into a new project at script.google.com, then Deploy → New deployment → Web app
// (Execute as: Me, Who has access: Anyone). The key below is what Rep Hub sends; keep it private.
const KEY = '${k}';
const FOLDER = 'Rep Hub backups';

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.key !== KEY) return reply({ ok: false, error: 'Wrong key' });
    const folder = getFolder();
    const me = Session.getEffectiveUser().getEmail();
    if (b.action === 'ping') return reply({ ok: true, folderUrl: folder.getUrl(), email: me });
    const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), 'application/gzip', b.name));
    const removed = b.keep === 'all' ? 0 : tidy(folder);
    return reply({ ok: true, id: file.getId(), folderUrl: folder.getUrl(), email: me, removed: removed });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function getFolder() {
  const found = DriveApp.getFoldersByName(FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER);
}

// Every file for 90 days, then one a week for two years, then one a month for good
function tidy(folder) {
  const day = 864e5, now = Date.now(), files = [], weeks = {}, months = {};
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); files.push({ f: f, t: f.getDateCreated().getTime() }); }
  files.sort(function (a, b) { return a.t - b.t; });
  let removed = 0;
  files.forEach(function (x) {
    const age = (now - x.t) / day;
    if (age <= 90) return;
    if (age <= 730) { const w = Math.floor(x.t / (7 * day)); if (!weeks[w]) { weeks[w] = 1; return; } }
    else { const d = new Date(x.t), m = d.getUTCFullYear() * 12 + d.getUTCMonth(); if (!months[m]) { months[m] = 1; return; } }
    x.f.setTrashed(true); removed++;
  });
  return removed;
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
}
async function callScript(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  const text = await res.text();
  let out = null; try { out = JSON.parse(text); } catch { out = null; }
  if (!out) {
    // Google's own "Access denied" page: the web app is not open to Rep Hub
    if (res.status === 403 || /Access denied/i.test(text)) {
      throw new Error('Google said "Access denied". In the script: Deploy → Manage deployments → Edit (pencil) → Who has access: Anyone → Version: New version → Deploy. If "Anyone" is not offered, the Google Workspace admin has turned it off.');
    }
    throw new Error(/accounts\.google\.com|ServiceLogin|Sign in/i.test(text)
      ? 'Google asked for a sign-in. In the deployment, set "Who has access" to "Anyone", then copy the new web app URL.'
      : `The script did not answer as expected (${res.status}). Check it was deployed as a Web app.`);
  }
  if (!out.ok) throw new Error(out.error === 'Wrong key' ? 'The script has a different key. Copy the script from Rep Hub again and redeploy.' : `The script said: ${out.error}`);
  return out;
}
async function connectScript(url) {
  const u = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/exec$/.test(u)) {
    throw new Error('Paste the Web app URL from the deployment: it starts https://script.google.com/macros/s/ and ends /exec');
  }
  const out = await callScript(u, { key: await scriptKey(), action: 'ping' });
  await save({ mode: 'script', url: u, email: out.email || '', folderUrl: out.folderUrl || null, last: null });
  return { email: out.email, folderUrl: out.folderUrl };
}

/* ── Google sign-in ── */
function authUrl(redirectUri, stateToken) {
  const p = new URLSearchParams({ client_id: cfg.google.clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state: stateToken });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}
async function exchange(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
  const body = await res.json().catch(() => ({}));
  if (!body.refresh_token) throw new Error(`Google did not give Rep Hub access${body.error ? ': ' + (body.error_description || body.error) : ''}`);
  let email = '';
  try { email = JSON.parse(Buffer.from(String(body.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch (_) { /* fine */ }
  await save({ mode: 'oauth', refresh: body.refresh_token, email, folderId: null, last: null });
  return { email };
}
let access = { token: null, until: 0 };
async function token() {
  if (access.token && Date.now() < access.until - 60000) return access.token;
  const s = await state();
  if (!s || !s.refresh) throw new Error('Google Drive is not connected');
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: s.refresh, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret, grant_type: 'refresh_token' }) });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) throw new Error(`Google Drive sign-in failed${body.error ? ': ' + body.error : ''}. Connect it again in Access & security → Backup.`);
  access = { token: body.access_token, until: Date.now() + (body.expires_in || 3600) * 1000 };
  return access.token;
}
async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${await token()}`, ...(opts.headers || {}) } });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Drive: ${(body.error && body.error.message) || res.status}`);
  return body;
}
async function folder() {
  const s = await state();
  if (s.folderId) {
    try { const f = await api(`https://www.googleapis.com/drive/v3/files/${s.folderId}?fields=id,trashed`); if (f && !f.trashed) return s.folderId; }
    catch (_) { /* gone: make a new one */ }
  }
  const made = await api('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rep Hub backups', mimeType: 'application/vnd.google-apps.folder' }) });
  await save({ ...s, folderId: made.id });
  return made.id;
}
async function tidyOAuth(folderId) {
  const files = []; let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const page = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,createdTime)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`);
    (page && page.files || []).forEach(f => files.push({ id: f.id, t: Date.parse(f.createdTime) }));
    pageToken = page && page.nextPageToken;
  } while (pageToken);
  let removed = 0;
  for (const f of toDelete(files)) { await api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); removed++; }
  return removed;
}

/** Save one backup file, then thin out the old ones (unless every file is kept) */
async function upload(name, content, type = 'application/gzip') {
  const s = await state();
  if (!s) throw new Error('Google Drive is not connected');
  const keep = await keepPolicy();
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let id, removed = 0, folderUrl = s.folderUrl || null;
  if (s.mode === 'script') {
    const out = await callScript(s.url, { key: await scriptKey(), name, data: buf.toString('base64'), keep });
    id = out.id; removed = out.removed || 0; folderUrl = out.folderUrl || folderUrl;
  } else {
    const folderId = await folder();
    const boundary = 'rephub' + Date.now();
    const meta = JSON.stringify({ name, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
      buf, Buffer.from(`\r\n--${boundary}--`)]);
    const file = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    id = file.id;
    if (keep !== 'all') { try { removed = await tidyOAuth(folderId); } catch (_) { /* a tidy-up, never a failure */ } }
  }
  const now = await state();
  await save({ ...now, folderUrl, last: { at: new Date().toISOString(), name, size: buf.length, ok: true, removed } });
  return { id, name, size: buf.length, removed };
}
async function noteFailure(error) {
  const s = await state(); if (!s) return;
  await save({ ...s, last: { at: new Date().toISOString(), ok: false, error: String(error).slice(0, 300) } });
}
async function status() {
  const s = await state();
  const connected = !!(s && (s.refresh || s.url));
  return { configured: configured(), connected, mode: s && s.mode || (s && s.refresh ? 'oauth' : null), email: s && s.email, last: s && s.last,
    folderUrl: s && (s.folderUrl || (s.folderId ? `https://drive.google.com/drive/folders/${s.folderId}` : null)), keep: await keepPolicy() };
}
async function disconnect() { const { q } = require('../db'); await q.setSetting(KEY, ''); access = { token: null, until: 0 }; }

module.exports = { configured, authUrl, exchange, upload, status, disconnect, noteFailure, scriptSource, connectScript, toDelete };

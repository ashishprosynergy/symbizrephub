'use strict';
/**
 * Google Drive: where the nightly backup is kept, outside Rep Hub and outside
 * Zoho. A Symbiz Google account connects once from Settings → Backup; Rep Hub
 * then keeps a "Rep Hub backups" folder in that Drive, adds a file every
 * night and removes files older than 90 days.
 *
 * Asks only for drive.file: Rep Hub can see and change the files it made
 * itself, and nothing else in the Drive.
 */
const cfg = require('../config');
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const KEY = 'gdrive';                 // { refresh, email, folderId, last }
const KEEP_DAYS = 90;

const configured = () => !!(cfg.google.clientId && cfg.google.clientSecret);
async function state() {
  const { q } = require('../db');
  try { return JSON.parse((await q.getSetting(KEY))?.value || 'null'); } catch { return null; }
}
async function save(s) { const { q } = require('../db'); await q.setSetting(KEY, JSON.stringify(s)); }

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
  await save({ refresh: body.refresh_token, email, folderId: null, last: null });
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
  if (!body.access_token) throw new Error(`Google Drive sign-in failed${body.error ? ': ' + body.error : ''}. Connect it again in Settings → Backup.`);
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
/** Put one file in the folder, then clear out anything past 90 days */
async function upload(name, content, type = 'application/gzip') {
  const folderId = await folder();
  const boundary = 'rephub' + Date.now();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--`)]);
  const file = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,webViewLink', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  let removed = 0;
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and createdTime < '${cutoff}'`);
    const old = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=200`);
    for (const f of (old && old.files) || []) { await api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); removed++; }
  } catch (_) { /* clearing out is a tidy-up, never a failure */ }
  const s = await state();
  await save({ ...s, last: { at: new Date().toISOString(), name, size: content.length, ok: true, removed } });
  return { id: file.id, name, size: content.length, removed };
}
async function noteFailure(error) {
  const s = await state(); if (!s) return;
  await save({ ...s, last: { at: new Date().toISOString(), ok: false, error: String(error).slice(0, 300) } });
}
async function status() {
  const s = await state();
  return { configured: configured(), connected: !!(s && s.refresh), email: s && s.email, last: s && s.last,
    folderUrl: s && s.folderId ? `https://drive.google.com/drive/folders/${s.folderId}` : null, keepDays: KEEP_DAYS };
}
async function disconnect() { const { q } = require('../db'); await q.setSetting(KEY, ''); access = { token: null, until: 0 }; }

module.exports = { configured, authUrl, exchange, upload, status, disconnect, noteFailure };

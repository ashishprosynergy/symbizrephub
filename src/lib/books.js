'use strict';
/**
 * Zoho Books: approved rep expenses become bills, with the receipt attached.
 *
 * Runs when the office sends a batch to accounting, and again from the
 * 15-minute job for anything not finished in time. Each bill is numbered
 * RH-<expense id> and looked up before it is made, so a retry, a timeout or
 * two runs overlapping can never produce the same bill twice.
 */
const cfg = require('../config');

const configured = () => !!cfg.books.orgId;

/* ─────────── token, shared through the database like the CRM one ─────────── */
let token = { access: null, expiresAt: 0 };
let rejected = null;
const SHARED_KEY = 'zoho_books_access_token';

async function accessToken() {
  if (token.access && Date.now() < token.expiresAt - 60_000) return token.access;
  const { setting, q } = require('../db');
  try {
    const t = JSON.parse(await setting(SHARED_KEY, 'null'));
    if (t && t.access && t.access !== rejected && Date.now() < t.expiresAt - 60_000) { token = t; return t.access; }
  } catch (_) { /* refresh below */ }

  const params = new URLSearchParams({
    refresh_token: cfg.books.refreshToken, client_id: cfg.books.clientId,
    client_secret: cfg.books.clientSecret, grant_type: 'refresh_token',
  });
  const res = await fetch(`${cfg.books.accountsDomain}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Zoho Books sign-in failed${body.error ? ': ' + body.error : ''}. Check ZOHO_BOOKS_REFRESH_TOKEN.`);
  }
  token = { access: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  q.setSetting(SHARED_KEY, JSON.stringify(token)).catch(() => {});
  return token.access;
}

async function call(path, { method = 'GET', query = {}, json, form, _retry } = {}) {
  const url = new URL(cfg.books.apiBase + path);
  url.searchParams.set('organization_id', cfg.books.orgId);
  Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const access = await accessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${access}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !_retry) {
    rejected = access; token = { access: null, expiresAt: 0 };
    return call(path, { method, query, json, form, _retry: true });
  }
  if (!res.ok || (body.code !== undefined && body.code !== 0)) {
    const err = new Error(body.message || `Zoho Books ${method} ${path} failed (${res.status})`);
    err.code = body.code; err.status = res.status;
    throw err;
  }
  return body;
}

/* ─────────── lookups, remembered for the run ─────────── */
let accounts = null;
async function accountId(name) {
  if (!accounts) {
    const out = await call('/chartofaccounts', { query: { filter_by: 'AccountType.Active', per_page: 200 } });
    accounts = (out.chartofaccounts || []).map(a => ({ id: a.account_id, name: a.account_name, type: a.account_type }));
  }
  const want = String(name || '').trim().toLowerCase();
  const hit = accounts.find(a => a.name.trim().toLowerCase() === want);
  return hit ? hit.id : null;
}

const vendors = new Map();
async function vendorId(name) {
  const key = String(name).trim().toLowerCase();
  if (vendors.has(key)) return vendors.get(key);
  const found = await call('/contacts', { query: { contact_name: String(name).trim(), contact_type: 'vendor' } });
  let c = (found.contacts || []).find(x => String(x.contact_name).trim().toLowerCase() === key);
  if (!c) {
    const made = await call('/contacts', { method: 'POST', json: { contact_name: String(name).trim(), contact_type: 'vendor' } });
    c = made.contact;
  }
  vendors.set(key, c.contact_id);
  return c.contact_id;
}

/** Zoho Books takes these for bill attachments; HEIC and others are refused. */
const ATTACHABLE = /^(image\/(jpe?g|png|gif|bmp)|application\/pdf)$/i;

/**
 * Make (or find) the bill for one expense and attach its receipt.
 * Returns { billId, note } — note explains anything left undone.
 */
async function billFor(x, { payee = 'rep', fallbackAccount = '', approvedBy = '', receipt = null } = {}) {
  const number = `RH-${x.id}`;
  const existing = await call('/bills', { query: { bill_number: number } });
  const already = (existing.bills || []).find(b => b.bill_number === number);
  if (already) return { billId: already.bill_id, note: 'already in Zoho Books' };

  const merchant = String(x.vendor || '').trim();
  const payeeName = payee === 'vendor' && merchant ? merchant : x.rep_name;
  if (!payeeName) throw new Error('No rep name or vendor to bill');

  const acct = (await accountId(x.category)) || (fallbackAccount ? await accountId(fallbackAccount) : null);
  if (!acct) {
    throw new Error(`No expense account called "${x.category}"${fallbackAccount ? ` or "${fallbackAccount}"` : ''} in Zoho Books. ` +
      'Add one, or set the default account in Rep Hub settings.');
  }

  const day = d => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
  const line = [x.category, merchant, x.description].filter(Boolean).join(' — ');
  const made = await call('/bills', { method: 'POST', json: {
    vendor_id: await vendorId(payeeName),
    bill_number: number,
    reference_number: `Rep Hub E${x.id}`,
    date: day(x.entry_date),
    line_items: [{ account_id: acct, description: `${line} (rep: ${x.rep_name})`.slice(0, 2000), rate: Number(x.amount), quantity: 1 }],
    notes: [`Rep expense from Rep Hub.`, `Rep: ${x.rep_name}.`, merchant ? `Paid to: ${merchant}.` : '',
            approvedBy ? `Approved by ${approvedBy}.` : ''].filter(Boolean).join(' ').slice(0, 1000),
  } });
  const billId = made.bill.bill_id;

  let note = '';
  if (!receipt) note = 'no receipt to attach';
  else if (!ATTACHABLE.test(receipt.type)) note = `receipt is ${receipt.type}, which Zoho Books will not take — attach it by hand`;
  else {
    try {
      const form = new FormData();
      form.append('attachment', new Blob([receipt.content], { type: receipt.type }), receipt.filename);
      await call(`/bills/${billId}/attachment`, { method: 'POST', form });
    } catch (e) {
      note = `bill made, but the receipt did not attach: ${e.message}`;
    }
  }
  return { billId, note };
}

/** Receipt bytes from the data URL kept in Postgres. */
function receiptFrom(row, x) {
  const m = row && String(row.receipt_data || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const content = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  const type = row.receipt_type || m[1] || 'application/octet-stream';
  return { content, type, filename: row.receipt_name || `receipt-E${x.id}` };
}

/**
 * Work through queued expenses until done or out of time.
 * Serverless requests are cut off after ~10s, so stop early and leave the
 * rest for the scheduled job rather than be killed half-way through a bill.
 */
async function makeBills({ budgetMs = 7000, limit = 25, includeFailed = false } = {}) {
  if (!configured()) return { configured: false, made: 0, failed: 0, left: 0 };
  const { q, setting } = require('../db');
  const started = Date.now();
  const payee = await setting('booksPayee', 'rep');
  const fallbackAccount = await setting('booksAccount', '');
  const users = await q.everyUser();
  const nameOf = id => (users.find(u => u.id === id) || {}).name || '';

  const todo = await q.billsToMake(limit, includeFailed);
  let made = 0, failed = 0;
  for (const x of todo) {
    if (Date.now() - started > budgetMs) break;
    try {
      const receipt = x.receipt_name ? receiptFrom(await q.receiptFor(x.id), x) : null;
      const out = await billFor(x, { payee, fallbackAccount, approvedBy: nameOf(x.approved_by), receipt });
      await q.setExpenseBill(x.id, out.billId, out.note && /did not attach|will not take/.test(out.note) ? out.note : null);
      made++;
    } catch (e) {
      await q.setExpenseBill(x.id, null, e.message.slice(0, 500));
      failed++;
    }
  }
  const left = (await q.billsToMake(500, false)).length;
  return { configured: true, made, failed, left };
}

/** For the settings screen: is it connected, and what can it see? */
async function status() {
  if (!configured()) return { configured: false };
  try {
    const org = await call(`/organizations/${cfg.books.orgId}`);
    accounts = null;
    await accountId('');
    return { configured: true, connected: true, organization: org.organization?.name || null,
             expenseAccounts: accounts.filter(a => /expense/i.test(a.type)).map(a => a.name).sort() };
  } catch (e) {
    return { configured: true, connected: false, error: e.message };
  }
}

module.exports = { configured, makeBills, status, billFor,
  _resetForTests: () => { token = { access: null, expiresAt: 0 }; accounts = null; vendors.clear(); } };

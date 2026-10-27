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

/* ─────────── token, shared through the database like the CRM one ─────────── */
let token = { access: null, expiresAt: 0 };
let rejected = null;
const SHARED_KEY = 'zoho_books_access_token';
const REFRESH_KEY = 'zoho_books_refresh_token';

/** The env var wins; otherwise the one saved when an admin connected Books. */
async function refreshToken() {
  if (cfg.books.refreshToken) return cfg.books.refreshToken;
  const { setting } = require('../db');
  return setting(REFRESH_KEY, '');
}
const configured = async () => !!cfg.books.orgId && !!(await refreshToken());

/**
 * Swap a Self Client grant code (scope ZohoBooks.fullaccess.all) for a
 * refresh token and keep it. Checks it can see the organisation first, so a
 * code from the wrong Zoho login is refused rather than saved.
 */
async function connect(code) {
  const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.books.clientId,
    client_secret: cfg.books.clientSecret, code: String(code || '').trim() });
  const res = await fetch(`${cfg.books.accountsDomain}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!body.refresh_token) {
    const why = body.error === 'invalid_code' ? 'That code has expired or was already used — make a new one.'
      : body.error === 'invalid_client' ? 'The code was made under a different Zoho client than Rep Hub uses.'
      : `Zoho said: ${body.error || res.status}.`;
    throw new Error(why);
  }
  const { q } = require('../db');
  token = { access: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  try { await call(`/organizations/${cfg.books.orgId}`); }
  catch (e) { token = { access: null, expiresAt: 0 }; throw new Error(`Signed in, but that login cannot open the Symbiz Network books: ${e.message}`); }
  await q.setSetting(REFRESH_KEY, body.refresh_token);
  await q.setSetting(SHARED_KEY, JSON.stringify(token));
  return true;
}

async function disconnect() {
  const { q } = require('../db');
  await q.setSetting(REFRESH_KEY, '');
  await q.setSetting(SHARED_KEY, 'null');
  token = { access: null, expiresAt: 0 };
}

async function accessToken() {
  if (token.access && Date.now() < token.expiresAt - 60_000) return token.access;
  const { setting, q } = require('../db');
  try {
    const t = JSON.parse(await setting(SHARED_KEY, 'null'));
    if (t && t.access && t.access !== rejected && Date.now() < t.expiresAt - 60_000) { token = t; return t.access; }
  } catch (_) { /* refresh below */ }

  const params = new URLSearchParams({
    refresh_token: await refreshToken(), client_id: cfg.books.clientId,
    client_secret: cfg.books.clientSecret, grant_type: 'refresh_token',
  });
  const res = await fetch(`${cfg.books.accountsDomain}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Zoho Books sign-in failed${body.error ? ': ' + body.error : ''}. Reconnect Zoho Books in Settings.`);
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
/** Every page of the chart: Symbiz has more active accounts than one page holds. */
async function loadAccounts() {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const out = await call('/chartofaccounts', { query: { filter_by: 'AccountType.Active', per_page: 200, page } });
    (out.chartofaccounts || []).forEach(a => all.push({ id: a.account_id, name: a.account_name, code: a.account_code || '', type: a.account_type }));
    if (!(out.page_context && out.page_context.has_more_page)) break;
  }
  return all;
}
/** An account by its exact name, or by the code at the front of it ("5310 …" finds code 5310). */
async function accountId(name) {
  if (!accounts) accounts = await loadAccounts();
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const hit = accounts.find(a => a.name.trim().toLowerCase() === want);
  if (hit) return hit.id;
  const code = (want.match(/^(\d{3,6})\b/) || [])[1];
  const byCode = code && accounts.filter(a => String(a.code) === code);
  return byCode && byCode.length === 1 ? byCode[0].id : null;
}

/* ── Vendors: Symbiz's own list in Books, so a receipt from "SHEETZ #123"
   lands on the "Sheetz" vendor already there instead of making a new one. ── */
let vendorList = null, vendorListAt = 0;
async function listVendors() {
  if (vendorList && Date.now() - vendorListAt < 10 * 60000) return vendorList;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const out = await call('/contacts', { query: { contact_type: 'vendor', filter_by: 'Status.Active', per_page: 200, page } });
    (out.contacts || []).forEach(c => all.push({ id: c.contact_id, name: String(c.contact_name || '').trim() }));
    if (!(out.page_context && out.page_context.has_more_page)) break;
  }
  vendorList = all.filter(v => v.name); vendorListAt = Date.now();
  return vendorList;
}
// "Sheetz #0421, Inc." and "sheetz" are the same shop
const norm = s => String(s || '').toLowerCase().replace(/#\s*\d+/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(inc|llc|ltd|co|corp|company|the|store)\b/g, ' ').replace(/\s+/g, ' ').trim();
function matchVendor(list, name) {
  const want = norm(name);
  if (!want) return null;
  return list.find(v => v.name.toLowerCase() === String(name).trim().toLowerCase())
    || list.find(v => norm(v.name) === want)
    || list.filter(v => norm(v.name) && (want.startsWith(norm(v.name) + ' ') || norm(v.name).startsWith(want + ' ')))
           .sort((a, b) => norm(b.name).length - norm(a.name).length)[0]
    || null;
}
async function vendorId(name) {
  const list = await listVendors();
  const hit = matchVendor(list, name);
  if (hit) return hit.id;
  const made = await call('/contacts', { method: 'POST', json: { contact_name: String(name).trim(), contact_type: 'vendor' } });
  list.push({ id: made.contact.contact_id, name: String(name).trim() });
  return made.contact.contact_id;
}

/** Zoho Books takes these for bill attachments; HEIC and others are refused. */
const ATTACHABLE = /^(image\/(jpe?g|png|gif|bmp)|application\/pdf)$/i;

/**
 * Make (or find) the bill for one expense and attach its receipt.
 * Returns { billId, note } — note explains anything left undone.
 */
/* The rep is who Symbiz pays back, so the rep is the vendor on every bill.
   Their Rep Hub name carries the member number ("Dave Mullet #0412"); the
   Books vendor is just the name, and an existing one is used when there is. */
const repName = n => String(n || '').replace(/\s*#\s*\d+\s*$/, '').trim();

async function billFor(x, { payee = 'rep', fallbackAccount = '', accountMap = {}, approvedBy = '', receipt = null } = {}) {
  const number = `RH-${x.id}`;
  const existing = await call('/bills', { query: { bill_number: number } });
  const already = (existing.bills || []).find(b => b.bill_number === number);
  if (already) return { billId: already.bill_id, note: 'already in Zoho Books' };

  const merchant = String(x.vendor || '').trim();
  const payeeName = payee === 'vendor' && merchant ? merchant : (repName(x.rep_name) || merchant);
  if (!payeeName) throw new Error('No rep name or vendor to bill');

  const mapped = accountMap[x.category];
  const acct = (mapped && await accountId(mapped)) || (await accountId(x.category))
    || (fallbackAccount ? await accountId(fallbackAccount) : null);
  if (!acct) {
    throw new Error(`No Zoho Books account for "${x.category}"${mapped ? ` (looked for "${mapped}")` : ''}. ` +
      'Pick one in Rep Hub Access & security → Zoho Books.');
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
/* ── Hours: one bill per rep per week (Monday to Sunday), a line for each
   entry, at the rep's hourly rate set in Settings. A bill for every single
   hour would bury the books. ── */
const DEFAULT_HOURS_ACCOUNT = '5200 Regional Representatives';
const day10 = d => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
function weekOf(d) {
  const t = new Date(day10(d) + 'T12:00:00Z');
  const back = (t.getUTCDay() + 6) % 7;                 // days since Monday
  const mon = new Date(t.getTime() - back * 864e5);
  return { start: mon.toISOString().slice(0, 10), end: new Date(mon.getTime() + 6 * 864e5).toISOString().slice(0, 10) };
}
async function hourlyRates() {
  const { setting } = require('../db');
  let map = {}; try { map = JSON.parse(await setting('repHourlyRates', '{}')) || {}; } catch (_) { map = {}; }
  const def = Number(await setting('defaultHourlyRate', '')) || 0;
  return { map, def, rateFor: id => (Number(map[id]) > 0 ? Number(map[id]) : def) };
}
/** Group hours entries into rep-weeks */
function hourWeeks(rows) {
  const by = new Map();
  rows.forEach(r => {
    const w = weekOf(r.entry_date), k = `${r.user_id}|${w.start}`;
    if (!by.has(k)) by.set(k, { userId: r.user_id, rep: r.rep_name, week: w, rows: [] });
    by.get(k).rows.push(r);
  });
  return [...by.values()];
}
async function hoursBillFor(g, { rate, accountMap = {}, approvedBy = '' }) {
  // Numbered by the first entry in it, so a retry finds the bill it already made
  const ids = g.rows.map(r => Number(r.id)).sort((a, b) => a - b);
  const number = `RH-H${ids[0]}`;
  const existing = await call('/bills', { query: { bill_number: number } });
  const already = (existing.bills || []).find(b => b.bill_number === number);
  if (already) return { billId: already.bill_id };
  const name = repName(g.rep);
  if (!(rate > 0)) throw new Error(`No hourly rate set for ${name || 'this rep'}. Set it in Access & security → Zoho Books → Hourly rates, then press Make bills now.`);
  const wanted = accountMap.Hours || DEFAULT_HOURS_ACCOUNT;
  const acct = (await accountId(wanted)) || (await accountId(DEFAULT_HOURS_ACCOUNT));
  if (!acct) throw new Error(`No Zoho Books account "${wanted}" for hours. Pick one in Access & security → Zoho Books.`);
  const hours = g.rows.reduce((s, r) => s + Number(r.hours), 0);
  const nice = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const last = g.rows.map(r => day10(r.entry_date)).sort().pop();
  const made = await call('/bills', { method: 'POST', json: {
    vendor_id: await vendorId(name),
    bill_number: number,
    reference_number: `Rep Hub hours, week of ${g.week.start}`,
    date: last,
    line_items: g.rows.slice().sort((a, b) => day10(a.entry_date).localeCompare(day10(b.entry_date))).map(r => ({
      account_id: acct, rate, quantity: Number(r.hours),
      description: `${nice(day10(r.entry_date))} · ${r.category}${r.description ? ' — ' + r.description : ''}`.slice(0, 2000) })),
    notes: [`Rep hours from Rep Hub, week of ${nice(g.week.start)}–${nice(g.week.end)}.`, `${name}: ${hours} hours at $${rate.toFixed(2)} an hour.`,
      approvedBy ? `Approved by ${approvedBy}.` : ''].filter(Boolean).join(' ').slice(0, 1000),
  } });
  return { billId: made.bill.bill_id, hours };
}

async function makeBills({ budgetMs = 7000, limit = 25, includeFailed = false } = {}) {
  if (!(await configured())) return { configured: false, made: 0, failed: 0, left: 0 };
  const { q, setting } = require('../db');
  const started = Date.now();
  // Always the rep: they are the one paid back (the shop is on the bill's line)
  const payee = 'rep';
  const fallbackAccount = await setting('booksAccount', DEFAULT_FALLBACK);
  const accountMap = await accountMapSetting();
  const users = await q.everyUser();
  const nameOf = id => (users.find(u => u.id === id) || {}).name || '';

  const todo = await q.billsToMake(limit, includeFailed);
  let made = 0, failed = 0;
  for (const x of todo) {
    if (Date.now() - started > budgetMs) break;
    try {
      const receipt = x.receipt_name ? receiptFrom(await q.receiptFor(x.id), x) : null;
      const out = await billFor(x, { payee, fallbackAccount, accountMap, approvedBy: nameOf(x.approved_by), receipt });
      await q.setExpenseBill(x.id, out.billId, out.note && /did not attach|will not take/.test(out.note) ? out.note : null);
      made++;
    } catch (e) {
      await q.setExpenseBill(x.id, null, e.message.slice(0, 500));
      failed++;
    }
  }
  // Then the hours, a rep-week at a time
  const rates = await hourlyRates();
  let hoursMade = 0;
  for (const g of hourWeeks(await q.timeBillsToMake(1000, includeFailed))) {
    if (Date.now() - started > budgetMs) break;
    const ids = g.rows.map(r => r.id);
    try {
      const out = await hoursBillFor(g, { rate: rates.rateFor(g.userId), accountMap, approvedBy: nameOf(g.rows[0].approved_by) });
      await q.setTimeBill(ids, out.billId, null);
      made++; hoursMade++;
    } catch (e) {
      await q.setTimeBill(ids, null, e.message.slice(0, 500));
      failed++;
    }
  }
  const left = (await q.billsToMake(500, false)).length + hourWeeks(await q.timeBillsToMake(1000, false)).length;
  return { configured: true, made, hoursBills: hoursMade, failed, left };
}

/** For the settings screen: is it connected, and what can it see? */
async function status() {
  if (!(await configured())) return { configured: false, fromEnv: !!cfg.books.refreshToken };
  try {
    const org = await call(`/organizations/${cfg.books.orgId}`);
    accounts = null;
    await accountId('');
    return { configured: true, connected: true, fromEnv: !!cfg.books.refreshToken,
             organization: org.organization?.name || null, accountMap: await accountMapSetting(),
             expenseAccounts: accounts.filter(a => /expense/i.test(a.type)).map(a => a.name).sort() };
  } catch (e) {
    return { configured: true, connected: false, fromEnv: !!cfg.books.refreshToken, error: e.message };
  }
}

/* Which Books account each Rep Hub category is billed to. Defaults follow
   Symbiz's chart of accounts: reps are contractors, reimbursed for mileage
   and everything else. The office can change any of them in Settings. */
const DEFAULT_FALLBACK = '5310 Contractor Reimbursements - Other';
const DEFAULT_ACCOUNTS = {
  Mileage: '5300 Contractor Reimbursements - Mileage',
  Meals: DEFAULT_FALLBACK, Lodging: DEFAULT_FALLBACK, 'Event supplies': DEFAULT_FALLBACK,
  Printing: DEFAULT_FALLBACK, Other: DEFAULT_FALLBACK,
  Hours: '5200 Regional Representatives',
};
async function accountMapSetting() {
  const { setting } = require('../db');
  let saved = {};
  try { saved = JSON.parse(await setting('booksAccountMap', '{}')) || {}; } catch (_) { /* keep defaults */ }
  return { ...DEFAULT_ACCOUNTS, ...saved };
}

/** Vendor names for the expense form's suggestions. */
async function vendorNames() {
  if (!(await configured())) return [];
  return (await listVendors()).map(v => v.name).sort((a, b) => a.localeCompare(b));
}

/**
 * Every unpaid invoice past its due date (Mel: members over 60 days in A/R).
 * Books hands back 200 a page; Symbiz has a few hundred at most.
 */
async function overdueInvoices() {
  const out = [];
  for (let page = 1; page <= 15; page++) {
    // Unpaid includes part-paid ones; the due date decides what is overdue
    const body = await call('/invoices', { query: { filter_by: 'Status.Unpaid', per_page: 200, page, sort_column: 'due_date', sort_order: 'A' } });
    (body.invoices || []).forEach(i => out.push({ id: i.invoice_id, number: i.invoice_number, customerId: i.customer_id,
      customer: i.customer_name, date: i.date, due: i.due_date, total: Number(i.total) || 0, balance: Number(i.balance) || 0 }));
    if (!body.page_context || !body.page_context.has_more_page) break;
  }
  return out;
}

module.exports = { configured, overdueInvoices, connect, disconnect, makeBills, status, billFor, vendorNames, matchVendor, DEFAULT_FALLBACK,
  DEFAULT_HOURS_ACCOUNT, hourlyRates, weekOf, hourWeeks,
  _resetForTests: () => { token = { access: null, expiresAt: 0 }; accounts = null; vendorList = null; } };

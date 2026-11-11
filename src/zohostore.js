'use strict';
/**
 * Everything Rep Hub keeps for itself, copied into Zoho CRM (James, 11 Nov:
 * "we need one database, one source of truth, and that is Zoho").
 *
 * How it stays safe:
 *  - It is OFF until the office switches it on (Access & security → Copy to
 *    Zoho). Rep Hub works exactly as before either way: this only copies.
 *  - Five modules, created by Rep Hub itself and visible only to Zoho
 *    administrators until Symbiz decides who else should see them.
 *  - Each record carries its Rep Hub ID (a unique field), so copying again
 *    updates the same Zoho record and never makes duplicates.
 *  - Only rows that changed since the last copy are sent; receipts are
 *    attached once. Something removed in Rep Hub is marked "Removed in Rep
 *    Hub" in Zoho, never deleted, so nothing is ever lost.
 *  - "Check" compares Rep Hub and Zoho record by record before anyone relies on it.
 */
const crypto = require('crypto');
const zoho = require('./lib/zoho');
const { query, q, setting } = require('./db');

/* ── The five modules and their fields (labels ≤ 25 characters; Zoho makes the API names from them) ── */
const T = (label, extra = {}) => ({ field_label: label, data_type: 'text', length: 255, ...extra });
const BASE = [T('Rep Hub ID', { unique: { case_sensitive: false } }), { field_label: 'Removed in Rep Hub', data_type: 'boolean' },
  { field_label: 'Created in Rep Hub', data_type: 'datetime' }];
const MODULES = {
  hours: { plural: 'Rep Hub Hours', singular: 'Rep Hub Hour', fields: [...BASE, T('Rep Name'), T('Rep Email'),
    { field_label: 'Entry Date', data_type: 'date' }, { field_label: 'Hours', data_type: 'double' }, T('Category'),
    { field_label: 'Description', data_type: 'textarea', textarea: { type: 'small' } }, T('Ring ID'), T('Status'), T('Approved By'),
    { field_label: 'Approved At', data_type: 'datetime' }, { field_label: 'Decline Note', data_type: 'textarea', textarea: { type: 'small' } }, T('Books Bill ID')] },
  expenses: { plural: 'Rep Hub Expenses', singular: 'Rep Hub Expense', fields: [...BASE, T('Rep Name'), T('Rep Email'),
    { field_label: 'Entry Date', data_type: 'date' }, { field_label: 'Amount', data_type: 'currency', currency: { precision: '2', rounding_option: 'normal' } },
    T('Category'), T('Vendor'), { field_label: 'Description', data_type: 'textarea', textarea: { type: 'small' } }, T('Ring ID'), T('Status'),
    T('Approved By'), { field_label: 'Approved At', data_type: 'datetime' }, { field_label: 'Decline Note', data_type: 'textarea', textarea: { type: 'small' } },
    T('Books Bill ID'), T('Receipt Name')] },
  handoffs: { plural: 'Member Hand-offs', singular: 'Member Hand-off', fields: [...BASE, T('Member ID'), T('Member Name'), T('Ring Name'),
    T('Phone'), T('Rep Name'), { field_label: 'Reason', data_type: 'textarea', textarea: { type: 'small' } }, T('Status'),
    { field_label: 'Call Notes', data_type: 'textarea', textarea: { type: 'large' } }, { field_label: 'Closed At', data_type: 'datetime' }] },
  candidates: { plural: 'Rep Candidates', singular: 'Rep Candidate', fields: [...BASE, T('Phone'), T('Email'), T('Region'), T('Source'), T('Stage'),
    // "Notes" is reserved in Zoho (its notes section), so the field has its own name
    { field_label: 'Candidate Notes', data_type: 'textarea', textarea: { type: 'large' } }, { field_label: 'Archived', data_type: 'boolean' }] },
  records: { plural: 'Rep Hub Records', singular: 'Rep Hub Record', fields: [...BASE, T('Record Type'), T('Member ID'), T('Ring ID'), T('Event ID'),
    T('Rep Name'), { field_label: 'Record Date', data_type: 'date' }, { field_label: 'Details', data_type: 'textarea', textarea: { type: 'large' } }] },
};
// Zoho's API name for a label: spaces and dashes become underscores
const api = label => label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

/* ── What each Rep Hub table becomes in Zoho ── */
const day = d => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
const at = d => { if (!d) return null; const t = new Date(d); return isNaN(t) ? null : t.toISOString().replace(/\.\d{3}Z$/, '+00:00'); };
const cut = (v, n) => v == null ? null : String(v).slice(0, n);
const parse = v => { try { return JSON.parse(v || '[]'); } catch (_) { return []; } };
const notesText = list => parse(list).map(n => `${day(n.at) || ''} ${n.by || ''}: ${n.text || ''}`.trim()).join('\n').slice(0, 31000) || null;
const details = o => cut(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')
  .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'), 31000);

/* `rows()` lists what is in Rep Hub now; `map()` turns one into a Zoho record. */
const KINDS = [
  { kind: 'hours', module: 'hours', key: r => 'H' + r.id,
    rows: () => query(`SELECT t.id, t.user_id, t.rep_name, t.entry_date, t.hours, t.category, t.description, t.ring_id, t.status, t.created_at,
      t.approved_at, t.approved_by, t.decline_note, t.books_bill_id, u.email FROM time_entries t LEFT JOIN users u ON u.id = t.user_id`),
    map: (r, names) => ({ Name: cut(`${r.rep_name || 'Rep'}: ${r.hours} h, ${day(r.entry_date)}`, 120), Rep_Name: r.rep_name, Rep_Email: r.email,
      Entry_Date: day(r.entry_date), Hours: Number(r.hours), Category: r.category, Description: cut(r.description, 1990), Ring_ID: r.ring_id,
      Status: r.status, Approved_By: names(r.approved_by), Approved_At: at(r.approved_at), Decline_Note: cut(r.decline_note, 1990),
      Books_Bill_ID: r.books_bill_id, Created_in_Rep_Hub: at(r.created_at) }) },
  { kind: 'expenses', module: 'expenses', key: r => 'E' + r.id, receipts: true,
    rows: () => query(`SELECT x.id, x.user_id, x.rep_name, x.entry_date, x.amount, x.category, x.vendor, x.description, x.ring_id, x.status,
      x.created_at, x.approved_at, x.approved_by, x.decline_note, x.books_bill_id, x.receipt_name, u.email FROM expenses x LEFT JOIN users u ON u.id = x.user_id`),
    map: (r, names) => ({ Name: cut(`${r.rep_name || 'Rep'}: $${Number(r.amount).toFixed(2)} ${r.category || ''}, ${day(r.entry_date)}`, 120),
      Rep_Name: r.rep_name, Rep_Email: r.email, Entry_Date: day(r.entry_date), Amount: Number(r.amount), Category: r.category, Vendor: r.vendor,
      Description: cut(r.description, 1990), Ring_ID: r.ring_id, Status: r.status, Approved_By: names(r.approved_by), Approved_At: at(r.approved_at),
      Decline_Note: cut(r.decline_note, 1990), Books_Bill_ID: r.books_bill_id, Receipt_Name: r.receipt_name, Created_in_Rep_Hub: at(r.created_at) }) },
  { kind: 'handoffs', module: 'handoffs', key: r => 'HO' + r.id, rows: () => query('SELECT * FROM handoffs'),
    map: r => ({ Name: cut(r.member_name || 'Member', 120), Member_ID: r.member_id, Member_Name: r.member_name, Ring_Name: r.ring_name, Phone: r.phone,
      Rep_Name: r.rep_name, Reason: cut(r.reason, 1990), Status: r.status, Call_Notes: notesText(r.notes), Closed_At: at(r.closed_at),
      Created_in_Rep_Hub: at(r.created_at) }) },
  { kind: 'candidates', module: 'candidates', key: r => 'C' + r.id, rows: () => query('SELECT * FROM rep_candidates'),
    map: r => ({ Name: cut(r.name, 120), Phone: r.phone, Email: r.email, Region: r.region, Source: r.source, Stage: r.stage,
      Candidate_Notes: notesText(r.notes), Archived: !!r.archived, Created_in_Rep_Hub: at(r.created_at) }) },
  // Everything else, in one module, by type
  ...[
    ['Ring note', 'SELECT * FROM ring_notes', r => 'RN' + r.id, r => ({ title: `Ring note by ${r.author_name || '?'}`, ring: r.ring_id, date: r.created_at,
      rep: r.author_name, d: { note: r.note, handover: r.handover } })],
    ['Rep note', 'SELECT * FROM rep_notes', r => 'PN' + r.id, r => ({ title: `Note on rep ${r.rep_id}`, date: r.created_at, rep: r.author,
      d: { rep_id: r.rep_id, note: r.note, next_check_in: day(r.next_checkin) } })],
    ['Rep goal', 'SELECT * FROM rep_goals', r => `G${r.rep_id}:${r.quarter}`, r => ({ title: `Goal ${r.quarter}`, date: r.updated_at,
      d: { rep_id: r.rep_id, quarter: r.quarter, calls: r.calls, visits: r.visits, new_members: r.new_members, set_by: r.set_by } })],
    ['Message to reps', 'SELECT * FROM rep_messages', r => 'M' + r.id, r => ({ title: r.subject || 'Message', date: r.created_at, rep: r.sent_by,
      d: { subject: r.subject, body: r.body, recipients: r.recipients } })],
    ['Summit task', 'SELECT * FROM summit_tasks', r => 'ST' + r.id, r => ({ title: r.title, event: r.event_id, date: r.done_at,
      d: { stage: r.stage, owner: r.owner, owner_id: r.owner_id, done: r.done, done_by: r.done_by, days_before: r.due_offset } })],
    ['Summit link', 'SELECT * FROM summit_links', r => 'SL' + r.id, r => ({ title: r.label, event: r.event_id, date: r.created_at,
      d: { url: r.url, added_by: r.added_by } })],
    ['Summit notes', 'SELECT * FROM summit_notes', r => 'SN' + r.event_id, r => ({ title: 'Summit notes', event: r.event_id, date: r.updated_at,
      d: { notes: r.notes, updated_by: r.updated_by } })],
    ['Onboarding stage', 'SELECT member_id, member_name, stage, note, history, updated_at, updated_by FROM member_onboarding', r => 'OB' + r.member_id,
      r => ({ title: `${r.member_name || 'Member'}: ${r.stage}`, member: r.member_id, date: r.updated_at, rep: r.updated_by,
        d: { stage: r.stage, note: r.note, history: notesText(JSON.stringify(parse(r.history).map(h => ({ at: h.at, by: h.by, text: h.stage + (h.note ? ' — ' + h.note : '') })))) } })],
    ['Coach', 'SELECT * FROM coaches', r => 'CO' + r.member_id, r => ({ title: `${r.member_name || 'Member'}${r.willing ? ': willing to coach' : ''}`,
      member: r.member_id, date: r.updated_at, rep: r.updated_by, d: { willing_to_coach: r.willing, strengths: r.strengths } })],
    ['Approval request', 'SELECT id, kind, payload, rep_name, summary, status, zoho_id, note, created_at, decided_at, decided_by FROM pending_writes',
      r => 'PW' + r.id, r => ({ title: cut(`${r.kind}: ${r.summary || ''}`, 120), date: r.created_at, rep: r.rep_name,
        d: { kind: r.kind, status: r.status, zoho_id: r.zoho_id, note: r.note, decided_by: r.decided_by, decided_at: at(r.decided_at), details: r.payload } })],
    ['Accounting batch', 'SELECT id, period, status, time_ids, expense_ids, requested_by, approver, note, created_at, decided_at, decided_by FROM accounting_batches',
      r => 'AB' + r.id, r => ({ title: `Accounting batch ${r.period || r.id}`, date: r.created_at,
        d: { status: r.status, hours_ids: r.time_ids, expense_ids: r.expense_ids, requested_by: r.requested_by, approver: r.approver, note: r.note, decided_by: r.decided_by } })],
    ['Exit interview', 'SELECT id, activity_id, member_id, payload, status, created_at FROM exit_forms', r => 'EX' + r.id,
      r => ({ title: 'Exit interview', member: r.member_id, date: r.created_at, d: { status: r.status, activity_id: r.activity_id, answers: r.payload } })],
  ].map(([type, sql, key, shape]) => ({ kind: 'records:' + type, module: 'records', key, rows: () => query(sql).catch(() => []),
    map: r => { const s = shape(r);
      return { Name: cut(s.title || type, 120), Record_Type: type, Member_ID: s.member || null, Ring_ID: s.ring || null, Event_ID: s.event || null,
        Rep_Name: s.rep || null, Record_Date: day(s.date), Details: details(s.d), Created_in_Rep_Hub: at(s.date) }; } })),
];

/* ── Bookkeeping: what has been copied, so only changes are sent ── */
const hashOf = o => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
async function moduleNames() {
  try { return JSON.parse(await setting('zohoStoreModules', '{}')) || {}; } catch (_) { return {}; }
}

/**
 * Create whatever is missing: the five modules (only Zoho administrators can
 * see them) and their fields. Safe to run again: existing ones are left alone.
 */
async function setup() {
  const report = [];
  const [mods, profiles] = await Promise.all([zoho.request('/settings/modules'), zoho.request('/settings/profiles')]);
  const admin = (profiles.profiles || []).find(p => /^administrator$/i.test(p.name)) || (profiles.profiles || [])[0];
  if (!admin) throw new Error('Could not find the Administrator profile in Zoho');
  const names = await moduleNames();
  for (const [key, def] of Object.entries(MODULES)) {
    let m = (mods.modules || []).find(x => x.plural_label === def.plural || x.api_name === names[key]);
    if (!m) {
      try {
        await zoho.request('/settings/modules', { method: 'POST', body: { modules: [{ plural_label: def.plural, singular_label: def.singular,
          profiles: [{ id: admin.id }], display_field: { field_label: 'Name', data_type: 'text' } }] } });
        const again = await zoho.request('/settings/modules');
        m = (again.modules || []).find(x => x.plural_label === def.plural);
        report.push(`${def.plural}: created`);
      } catch (e) { report.push(`${def.plural}: could not be created (${e.message})`); continue; }
    } else report.push(`${def.plural}: already there`);
    if (!m) { report.push(`${def.plural}: created but not found afterwards`); continue; }
    names[key] = m.api_name;
    // Fields: add the ones not there yet
    const have = await zoho.request('/settings/fields', { query: { module: m.api_name } }).catch(() => ({ fields: [] }));
    const existing = new Set((have.fields || []).map(f => f.api_name));
    const missing = def.fields.filter(f => !existing.has(api(f.field_label)));
    for (let i = 0; i < missing.length; i += 25) {
      try {
        await zoho.request('/settings/fields', { method: 'POST', query: { module: m.api_name }, body: { fields: missing.slice(i, i + 25) } });
        report.push(`${def.plural}: ${missing.slice(i, i + 25).length} fields added`);
      } catch (e) { report.push(`${def.plural}: fields could not be added (${e.message})`); }
    }
    if (!missing.length) report.push(`${def.plural}: fields already there`);
    // Confirm Zoho named every field the way the copy expects
    const after = await zoho.request('/settings/fields', { query: { module: m.api_name } }).catch(() => ({ fields: [] }));
    const got = new Set((after.fields || []).map(f => f.api_name));
    const wrong = def.fields.map(f => api(f.field_label)).filter(a => !got.has(a));
    if (wrong.length) report.push(`${def.plural}: PROBLEM, these fields are missing or named differently in Zoho: ${wrong.join(', ')}`);
  }
  await q.setSetting('zohoStoreModules', JSON.stringify(names));
  return { modules: names, report };
}

/**
 * Copy what changed. `budgetMs` keeps a run inside a serverless time limit;
 * the next run carries on from where this one stopped.
 */
async function copy({ budgetMs = 8000 } = {}) {
  const started = Date.now();
  const names = await moduleNames();
  if (!names.hours) return { ok: false, error: 'The Zoho modules are not set up yet' };
  const users = await q.everyUser().catch(() => []);
  const nameOf = id => (users.find(u => String(u.id) === String(id)) || {}).name || id || null;
  const out = { copied: 0, attached: 0, removed: 0, failed: 0, errors: [], left: 0 };
  for (const k of KINDS) {
    const mod = names[k.module];
    if (!mod) continue;
    const [rows, done] = await Promise.all([k.rows(), query('SELECT key, hash, zoho_id, attached, removed FROM zoho_copy WHERE kind = $1', [k.kind])]);
    const seen = new Map(done.map(d => [d.key, d]));
    const now = new Map(rows.map(r => [k.key(r), r]));
    const changed = [];
    for (const [key, r] of now) {
      const rec = { ...k.map(r, nameOf), Rep_Hub_ID: `${k.kind.split(':')[0]}:${key}`, Removed_in_Rep_Hub: false };
      const h = hashOf(rec);
      const prev = seen.get(key);
      if (!prev || prev.hash !== h || prev.removed) changed.push({ key, rec, h, row: r });
    }
    for (let i = 0; i < changed.length; i += 100) {
      if (Date.now() - started > budgetMs) { out.left += changed.length - i; break; }
      const group = changed.slice(i, i + 100);
      let res;
      try { res = await zoho.upsertRecords(mod, group.map(g => g.rec), ['Rep_Hub_ID']); }
      catch (e) { out.failed += group.length; out.errors.push(`${k.kind}: ${e.message}`.slice(0, 300)); continue; }
      for (const [j, g] of group.entries()) {
        const r0 = res[j] || {};
        if (r0.code && r0.code !== 'SUCCESS') { out.failed++; out.errors.push(`${k.kind} ${g.key}: ${r0.message || r0.code}`.slice(0, 300)); continue; }
        const id = r0.details && r0.details.id;
        await query(`INSERT INTO zoho_copy (kind, key, hash, zoho_id, removed, copied_at) VALUES ($1,$2,$3,$4,FALSE,now())
          ON CONFLICT (kind, key) DO UPDATE SET hash = EXCLUDED.hash, zoho_id = COALESCE(EXCLUDED.zoho_id, zoho_copy.zoho_id), removed = FALSE, copied_at = now()`,
          [k.kind, g.key, g.h, id || null]);
        out.copied++;
      }
    }
    // Receipts, once each, after the expense itself is in Zoho
    if (k.receipts) {
      const need = (await query("SELECT key, zoho_id FROM zoho_copy WHERE kind = $1 AND attached = FALSE AND zoho_id IS NOT NULL", [k.kind]))
        .filter(d => (now.get(d.key) || {}).receipt_name);
      for (const d of need) {
        if (Date.now() - started > budgetMs) { out.left++; continue; }
        const row = await q.receiptFor(Number(d.key.slice(1))).catch(() => null);
        const m = row && String(row.receipt_data || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
        if (!m) { await query('UPDATE zoho_copy SET attached = TRUE WHERE kind = $1 AND key = $2', [k.kind, d.key]); continue; }
        try {
          const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
          await zoho.attachFile(mod, d.zoho_id, row.receipt_name || `receipt-${d.key}`, buf, row.receipt_type || m[1] || 'application/octet-stream');
          await query('UPDATE zoho_copy SET attached = TRUE WHERE kind = $1 AND key = $2', [k.kind, d.key]);
          out.attached++;
        } catch (e) { out.failed++; out.errors.push(`receipt ${d.key}: ${e.message}`.slice(0, 300)); }
      }
    }
    // Gone from Rep Hub: marked in Zoho, never deleted there
    const gone = done.filter(d => !now.has(d.key) && !d.removed && d.zoho_id);
    if (gone.length && Date.now() - started <= budgetMs) {
      try {
        await zoho.updateRecords(mod, gone.map(d => ({ id: d.zoho_id, Removed_in_Rep_Hub: true })));
        for (const d of gone) await query('UPDATE zoho_copy SET removed = TRUE WHERE kind = $1 AND key = $2', [k.kind, d.key]);
        out.removed += gone.length;
      } catch (e) { out.failed += gone.length; out.errors.push(`${k.kind} removals: ${e.message}`.slice(0, 300)); }
    }
  }
  await q.setSetting('zohoStoreLast', JSON.stringify({ at: new Date().toISOString(), ...out, errors: out.errors.slice(0, 20) })).catch(() => {});
  return { ok: true, ...out };
}

/** Rep Hub and Zoho side by side: how many of each, and whether every one is copied and up to date */
async function check() {
  const names = await moduleNames();
  const users = await q.everyUser().catch(() => []);
  const nameOf = id => (users.find(u => String(u.id) === String(id)) || {}).name || id || null;
  const lines = [];
  for (const k of KINDS) {
    const rows = await k.rows();
    const done = await query('SELECT key, hash, attached FROM zoho_copy WHERE kind = $1 AND removed = FALSE', [k.kind]);
    const byKey = new Map(done.map(d => [d.key, d]));
    let upToDate = 0, receiptsMissing = 0;
    for (const r of rows) {
      const key = k.key(r), d = byKey.get(key);
      if (d && d.hash === hashOf({ ...k.map(r, nameOf), Rep_Hub_ID: `${k.kind.split(':')[0]}:${key}`, Removed_in_Rep_Hub: false })) upToDate++;
      if (k.receipts && r.receipt_name && !(d && d.attached)) receiptsMissing++;
    }
    lines.push({ kind: k.kind, module: names[k.module] || null, inRepHub: rows.length, copied: upToDate, behind: rows.length - upToDate, receiptsMissing });
  }
  // Zoho's own count for each module, to confirm the records are really there
  const zohoCounts = {};
  for (const [key, mod] of Object.entries(names)) {
    try { const r = await zoho.coql(`select COUNT(id) from ${mod} where Removed_in_Rep_Hub = false`); zohoCounts[key] = Number(Object.values((r && r[0]) || {})[0]) || 0; }
    catch (e) { zohoCounts[key] = 'could not count: ' + e.message.slice(0, 80); }
  }
  const total = lines.reduce((s, l) => s + l.inRepHub, 0), copied = lines.reduce((s, l) => s + l.copied, 0);
  return { lines, zohoCounts, total, copied, allMatch: total === copied && lines.every(l => !l.receiptsMissing) };
}

module.exports = { MODULES, KINDS, setup, copy, check, moduleNames, api };

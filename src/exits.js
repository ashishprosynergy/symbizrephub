'use strict';
/**
 * Exit interviews, filed the way the office files the paper form.
 *
 * The answers are already in Zoho with the member's visits by the time this
 * runs. Here the Growth Ring Exit Interview form is filled in as a PDF and:
 *   - attached to the member's contact in Zoho,
 *   - saved in the "Exit Interview forms" folder in Google Drive (Access &
 *     security → Office notifications), through the Drive script,
 *   - emailed, with the PDF, to whoever ends memberships (Keturah).
 * Each step is tried on its own, so a Drive hiccup never stops the email.
 * Runs in the background; anything unfinished is tried again by the
 * 15-minute job, three times at most.
 */
const { query, setting } = require('./db');
const zoho = require('./lib/zoho');
const { formPDF } = require('./lib/pdf');
const { M } = require('./domain');

const QUESTIONS = [
  ['reasonJoining', 'What was your reason for joining Symbiz?'],
  ['value', 'What value did you receive from your Symbiz membership?'],
  ['reasonLeaving', 'What is your reason for discontinuing your membership?'],
  ['suggestions', 'What suggestions do you have for how we can better serve our members?'],
  ['wouldReturn', 'Would you consider joining a Growth Ring again in the future?'],
  ['other', 'Any other comments or suggestions?'],
];

const usDate = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(d || ''); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The answers as the form asks them; "Maybe — busy season" style for the yes/no one */
function answers(x = {}) {
  return {
    reasonJoining: x.reasonJoining, value: x.value,
    reasonLeaving: [x.reasonCategory, x.reasonLeaving].filter(Boolean).join(': '),
    suggestions: x.suggestions,
    wouldReturn: [x.wouldReturn, x.wouldReturnWhy].filter(Boolean).join(' - '),
    other: x.other,
  };
}

function pdfFor(p) {
  const a = answers(p.exit);
  return formPDF({
    title: 'Growth Ring Exit Interview',
    details: [['Member Name', p.memberName], ['Date', usDate(p.date)],
      ['Growth Ring Number', p.ringName], ['Date originally joined Symbiz', usDate(p.exit && p.exit.joined)]],
    questions: QUESTIONS.map(([k, label]) => ({ q: label, a: a[k] })),
    signoff: [['Interviewer', p.repName], ['Reviewed by', '']],
    note: `Recorded in Rep Hub by ${p.repName || 'a rep'} on ${usDate(p.date)}. The same answers are in Zoho with the member's visits.`,
  });
}
const fileName = p => `Exit Interview - ${String(p.memberName || 'Member').replace(/[\\/:*?"<>|]/g, '')}.pdf`;

/** A Drive folder link or its id → the id */
function folderId(v) {
  const s = String(v || '').trim();
  const m = s.match(/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : (/^[\w-]{10,}$/.test(s) ? s : '');
}

/** Saved by the activity route: the exit interview waits here for filing */
async function queueExit(p) {
  const row = await query('INSERT INTO exit_forms (activity_id, member_id, payload) VALUES ($1,$2,$3) RETURNING id',
    [p.activityId || null, p.memberId || null, JSON.stringify(p)]);
  return row[0] && row[0].id;
}

async function fileOne(row) {
  const p = JSON.parse(row.payload);
  const done = row.result ? JSON.parse(row.result) : {};
  const pdf = pdfFor(p), name = fileName(p);
  const step = async (key, fn) => {
    if (done[key] && done[key].ok) return;
    try { done[key] = { ok: true, ...(await fn()) }; }
    catch (e) { done[key] = { ok: false, error: String(e.message || e).slice(0, 300) }; }
  };

  await step('zoho', async () => {
    if (!p.memberId) return { skipped: 'no member record' };
    return { id: await zoho.attachFile(M.CONTACT, p.memberId, name, pdf, 'application/pdf') };
  });
  await step('drive', async () => {
    const id = folderId(await setting('exitInterviewFolder', ''));
    if (!id) return { skipped: 'no Drive folder chosen' };
    const out = await require('./lib/gdrive').saveToFolder(id, name, pdf, 'application/pdf');
    return { url: out.url || null };
  });
  // The email goes once, after Zoho and Drive have had their go, and says how each went
  if (!(done.email && done.email.ok)) {
    const last = row.tries + 1 >= 3;
    const pending = ['zoho', 'drive'].some(k => done[k] && !done[k].ok);
    if (!pending || last) await step('email', () => notify(p, pdf, name, done));
  }
  const ok = ['zoho', 'drive', 'email'].every(k => !done[k] || done[k].ok) && done.email;
  await query('UPDATE exit_forms SET status = $1, tries = tries + 1, result = $2 WHERE id = $3',
    [ok ? 'done' : (row.tries + 1 >= 3 ? 'failed' : 'pending'), JSON.stringify(done), row.id]);
  return { id: row.id, ok, done };
}

async function notify(p, pdf, name, done) {
  const list = String(await setting('exitInterviewNotify', '')).split(/[\s,;]+/).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if (!list.length) return { skipped: 'nobody to email' };
  const a = answers(p.exit);
  const row = (k, v) => v ? `<tr><td style="padding:4px 14px 4px 0;color:#6B7468;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>` : '';
  const said = QUESTIONS.map(([k, label]) => a[k] ? `<p style="margin:10px 0 2px;font-weight:600;font-size:13.5px">${esc(label)}</p><p style="margin:0;font-size:14px">${esc(a[k])}</p>` : '').join('');
  const filed = [
    done.zoho && done.zoho.ok && !done.zoho.skipped ? 'The form is attached to the member in Zoho (Attachments).' : done.zoho && !done.zoho.ok ? `It could not be attached in Zoho (${done.zoho.error}); please attach the PDF below.` : '',
    done.drive && done.drive.ok && !done.drive.skipped ? 'A copy is in the Exit Interview forms folder in Google Drive.' : done.drive && !done.drive.ok ? `It could not be saved to Google Drive (${done.drive.error}); please save the PDF below there.` : '',
  ].filter(Boolean).map(t => `<li>${esc(t)}</li>`).join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;color:#1E2A20">
    <p style="font-size:15px"><strong>${esc(p.repName || 'A rep')}</strong> recorded an exit interview with <strong>${esc(p.memberName || 'a member')}</strong>.
      Please end the membership in Zoho.</p>
    <table style="font-size:14px;border-collapse:collapse">${row('Member', p.memberName)}${row('Growth Ring', p.ringName)}${row('Date', usDate(p.date))}${row('Joined Symbiz', usDate(p.exit && p.exit.joined))}${row('Interviewer', p.repName)}</table>
    ${said}
    ${filed ? `<ul style="font-size:13px;color:#3A4537;margin-top:16px">${filed}</ul>` : ''}
    <p style="font-size:12.5px;color:#6B7468;margin-top:14px">The filled-in Growth Ring Exit Interview form is attached.</p></div>`;
  const reminders = require('./reminders');
  for (const to of list) {
    await reminders.queueEmail(to, `Exit interview to enter in Zoho: ${p.memberName || 'a member'}`, html, {
      kind: 'exit', replyTo: p.repEmail || undefined,
      attachments: [{ filename: name, content: pdf.toString('base64'), encoding: 'base64', contentType: 'application/pdf' }],
    });
  }
  return { to: list };
}

/** File everything waiting (the background job and the 15-minute job both call this) */
async function processExits({ budgetMs = 20000 } = {}) {
  const t0 = Date.now();
  // One left 'filing' by a job that was stopped part-way is picked up again after half an hour
  const stale = new Date(Date.now() - 30 * 60000).toISOString();
  const rows = await query("SELECT * FROM exit_forms WHERE (status = 'pending' OR (status = 'filing' AND created_at < $1)) AND tries < 3 ORDER BY id LIMIT 20", [stale]).catch(() => []);
  const out = [];
  for (const r of rows) {
    if (Date.now() - t0 > budgetMs) break;
    // Claimed first, so two jobs running at once never file the same form twice
    const claimed = await query("UPDATE exit_forms SET status = 'filing' WHERE id = $1 AND status = $2 RETURNING id", [r.id, r.status]);
    if (!claimed.length) continue;
    out.push(await fileOne(r).catch(async e => {
      await query("UPDATE exit_forms SET status = 'pending', tries = tries + 1 WHERE id = $1", [r.id]);
      return { id: r.id, ok: false, error: e.message };
    }));
  }
  if (out.some(x => x.done && x.done.email && x.done.email.ok)) await require('./reminders').flushOutbox({ budgetMs: 8000 }).catch(() => {});
  return { filed: out.filter(x => x.ok).length, waiting: out.filter(x => !x.ok).length };
}

module.exports = { queueExit, processExits, pdfFor, folderId, QUESTIONS };

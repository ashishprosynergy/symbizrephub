'use strict';
/**
 * Reminder service — the piece that actually drives the work.
 *
 * Reps in the field will not open an app to discover who to call. The
 * weekly email is the product; the app is where the result gets recorded.
 * Every message includes tel: links so a rep can go straight from the
 * email to the call without signing in.
 */
const nodemailer = require('nodemailer');
const cfg = require('./config');
const { q, audit } = require('./db');
const zoho = require('./lib/zoho');
const { fromZoho, daysUntil, today, M } = require('./domain');

let transport = null;
function mailer() {
  if (!cfg.mail.enabled) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: cfg.mail.host,
      port: cfg.mail.port,
      secure: cfg.mail.port === 465,
      auth: cfg.mail.user ? { user: cfg.mail.user, pass: cfg.mail.pass } : undefined,
    });
  }
  return transport;
}

/* ─────────── data gathering ─────────── */

/**
 * Pull everything due within `windowDays` for one rep.
 * COQL keeps this to a single API call instead of paging a module.
 */
async function dueForRep(repId, windowDays = cfg.reminders.dueWindowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = await zoho.coql(
    `select id, Name, Activity_Type, Next_Due_Date, Contact_Name, Facilitator, Growth_Ring, Rep, Outcome
     from ${M.ACTIVITY}
     where Rep = '${repId}' and Next_Due_Date <= '${cutoffStr}' and Next_Due_Date is not null
     order by Next_Due_Date asc limit 100`
  );
  return rows.map(fromZoho.activity);
}

/* ─────────── rendering ─────────── */

function renderDigestHTML(user, items) {
  const overdue = items.filter(i => daysUntil(i.nextDue) < 0);
  const soon = items.filter(i => daysUntil(i.nextDue) >= 0);

  const row = i => {
    const n = daysUntil(i.nextDue);
    const when = n < 0 ? `${Math.abs(n)} days overdue` : n === 0 ? 'today' : `in ${n} days`;
    const colour = n < 0 ? '#A2452C' : n <= 7 ? '#AD7E21' : '#5A6455';
    const phone = i.phone || '';
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #E9ECDF;">
        <strong style="color:#1E2A20;">${esc(i.who)}</strong><br>
        <span style="color:#5A6455;font-size:13px;">${esc(i.type)}${i.ringName ? ' · ' + esc(i.ringName) : ''}</span>
      </td>
      <td style="padding:9px 10px;border-bottom:1px solid #E9ECDF;color:${colour};font-size:13px;white-space:nowrap;">${when}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E9ECDF;white-space:nowrap;">
        ${phone ? `<a href="tel:${esc(phone)}" style="color:#2E5132;font-weight:600;font-size:13px;">Call</a>` : ''}
      </td></tr>`;
  };

  return `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:22px 16px;">
    <h1 style="font-size:19px;color:#1E2A20;margin:0 0 4px;">Your calls this week</h1>
    <p style="color:#5A6455;font-size:14px;margin:0 0 18px;line-height:1.5;">
      ${esc(user.name.split(' ')[0])}, here's who's due. Tap a name to call, then log it when you get a moment.
    </p>
    ${overdue.length ? `<p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#A2452C;">OVERDUE · ${overdue.length}</p>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;margin-bottom:16px;">${overdue.map(row).join('')}</table>` : ''}
    ${soon.length ? `<p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#5A6455;">COMING UP · ${soon.length}</p>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;">${soon.map(row).join('')}</table>` : ''}
    ${!items.length ? `<p style="color:#2E5132;font-size:14px;">Nothing due this week. You're caught up.</p>` : ''}
    <p style="margin:22px 0 0;">
      <a href="${cfg.appUrl}" style="background:#2E5132;color:#fff;padding:10px 18px;border-radius:7px;text-decoration:none;font-size:14px;font-weight:600;">Open Rep Hub</a>
      <a href="${cfg.appUrl}/callsheet" style="margin-left:8px;color:#2E5132;font-size:14px;">Print a call sheet</a>
    </p>
    <p style="color:#8A9284;font-size:12px;margin-top:22px;line-height:1.5;">
      Symbiz Network · reply to this email or call the office at 800-394-7970 if you'd rather have these keyed in for you.
    </p>
  </div></body></html>`;
}

function renderDigestSMS(user, items) {
  const overdue = items.filter(i => daysUntil(i.nextDue) < 0).length;
  const names = items.slice(0, 4).map(i => i.who.split(' ')[0]).join(', ');
  return `Symbiz: ${items.length} call${items.length === 1 ? '' : 's'} due${overdue ? ` (${overdue} overdue)` : ''}: ${names}${items.length > 4 ? '…' : ''}. ${cfg.appUrl}`;
}

function renderOfficeSummary(stats) {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F2F5EC;margin:0;">
  <div style="max-width:560px;margin:0 auto;padding:22px 16px;">
    <h1 style="font-size:19px;color:#1E2A20;margin:0 0 14px;">Monthly network summary</h1>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;">
      ${Object.entries(stats).map(([k, v]) => `<tr>
        <td style="padding:9px 12px;border-bottom:1px solid #E9ECDF;color:#5A6455;font-size:14px;">${esc(k)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #E9ECDF;text-align:right;font-weight:700;color:#1E2A20;">${esc(v)}</td>
      </tr>`).join('')}
    </table>
    <p style="margin-top:18px;"><a href="${cfg.appUrl}/reports" style="color:#2E5132;font-weight:600;">Open full reports</a></p>
  </div></body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ─────────── sending ─────────── */

/** Readable text from one of our HTML emails: links kept, tags dropped. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const l = label.replace(/<[^>]+>/g, '').trim();
      return href.startsWith('tel:') || !l ? l || href : `${l}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail(to, subject, html, { userId, kind, replyTo, attachments } = {}) {
  const t = mailer();
  if (!t) {
    // Be explicit: a caller that marks work as "sent" must know it wasn't.
    console.log(`[mail:disabled] would send "${subject}" to ${to}`);
    await q.logSend(userId || null, kind || 'email', 'email', subject, true, 'mail disabled');
    return { skipped: true, ok: false, error: 'Email is not configured on this site' };
  }
  try {
    // A plain-text copy alongside the HTML. HTML-only mail is one of the
    // things Gmail and Yahoo score as spam, which is where codes were landing.
    await t.sendMail({ from: cfg.mail.from, to, subject, html, text: htmlToText(html),
      ...(replyTo ? { replyTo } : {}), ...(attachments ? { attachments } : {}) });
    await q.logSend(userId || null, kind || 'email', 'email', subject, true, null);
    return { ok: true };
  } catch (err) {
    await q.logSend(userId || null, kind || 'email', 'email', subject, false, err.message);
    console.error('[mail] failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendSMS(to, body, { userId } = {}) {
  if (!cfg.sms.enabled) {
    console.log(`[sms:disabled] would send to ${to}: ${body}`);
    return { skipped: true };
  }
  try {
    const auth = Buffer.from(`${cfg.sms.sid}:${cfg.sms.authToken}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sms.sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: cfg.sms.from, Body: body }),
    });
    const ok = res.ok;
    await q.logSend(userId || null, 'digest', 'sms', null, ok, ok ? null : `HTTP ${res.status}`);
    return { ok };
  } catch (err) {
    await q.logSend(userId || null, 'digest', 'sms', null, false, err.message);
    return { ok: false, error: err.message };
  }
}

/* ─────────── jobs ─────────── */

async function runWeeklyDigest({ dryRun = false } = {}) {
  const reps = await q.allReps();
  const results = [];
  for (const rep of reps) {
    let items = [];
    try { items = await dueForRep(rep.id); }
    catch (err) { console.error(`[digest] ${rep.email}:`, err.message); results.push({ rep: rep.email, error: err.message }); continue; }

    if (!items.length) { results.push({ rep: rep.email, skipped: 'nothing due' }); continue; }

    const subject = `${items.length} call${items.length === 1 ? '' : 's'} due this week`;
    if (dryRun) { results.push({ rep: rep.email, subject, count: items.length, dryRun: true }); continue; }

    if (rep.digest_email) await sendEmail(rep.email, subject, renderDigestHTML(rep, items), { userId: rep.id, kind: 'digest' });
    if (rep.digest_sms && rep.phone) await sendSMS(rep.phone, renderDigestSMS(rep, items), { userId: rep.id });
    results.push({ rep: rep.email, count: items.length });
  }
  await audit(null, 'reminder.weekly', { reps: results.length });
  return results;
}

async function runOverdueNudge({ dryRun = false } = {}) {
  const reps = await q.allReps();
  const out = [];
  for (const rep of reps) {
    let items = [];
    try { items = await dueForRep(rep.id, 0); } catch { continue; }
    const bad = items.filter(i => daysUntil(i.nextDue) <= -cfg.reminders.nudgeAfterDays);
    if (!bad.length) continue;
    const subject = `${bad.length} contact${bad.length === 1 ? '' : 's'} more than ${cfg.reminders.nudgeAfterDays} days overdue`;
    if (!dryRun && rep.digest_email) {
      await sendEmail(rep.email, subject, renderDigestHTML(rep, bad), { userId: rep.id, kind: 'nudge' });
    }
    out.push({ rep: rep.email, count: bad.length });
  }
  return out;
}

async function runOfficeSummary({ dryRun = false } = {}) {
  const office = await q.allOffice();
  if (!office.length) return [];

  let stats = {};
  try {
    const [rings, members, activities] = await Promise.all([
      zoho.coql(`select id, Status from ${M.RING} limit 200`),
      zoho.coql(`select id, Member_Status from ${M.CONTACT} limit 200`),
      zoho.coql(`select id, Next_Due_Date from ${M.ACTIVITY} where Next_Due_Date is not null limit 200`),
    ]);
    stats = {
      'Active Growth Rings': rings.filter(r => r.Status === 'active').length,
      'Awaiting approval': rings.filter(r => r.Status === 'pending').length,
      'Active members': members.filter(m => (m.Member_Status || 'active') === 'active').length,
      'Contacts overdue': activities.filter(a => daysUntil(a.Next_Due_Date) < 0).length,
      'Contacts due in 30 days': activities.filter(a => { const d = daysUntil(a.Next_Due_Date); return d >= 0 && d <= 30; }).length,
    };
  } catch (err) {
    console.error('[office summary]', err.message);
    return [{ error: err.message }];
  }

  if (dryRun) return [{ stats, dryRun: true }];
  for (const u of office) {
    await sendEmail(u.email, 'Symbiz monthly network summary', renderOfficeSummary(stats), { userId: u.id, kind: 'office' });
  }
  return [{ sent: office.length, stats }];
}

module.exports = {
  dueForRep, runWeeklyDigest, runOverdueNudge, runOfficeSummary,
  renderDigestHTML, renderDigestSMS, renderOfficeSummary, sendEmail, sendSMS, htmlToText,
};

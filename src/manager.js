'use strict';
/**
 * Managing the reps (Mel): one picture of every rep, built from Zoho and
 * Rep Hub, used by the Monday email and the early warnings.
 *
 * Per rep: rings, calls made in the last 7 / 30 days, overdue contacts,
 * facilitator calls more than 30 days overdue, rings with no meeting in 60
 * days, rings never visited or not visited in 6 months, last sign-in, goals
 * for the quarter and the next check-in Mel noted.
 */
const zoho = require('./lib/zoho');
const { q } = require('./db');
const { queries, fromZoho, today, addDays, daysUntil, M } = require('./domain');

const quarterOf = (d = new Date()) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
const quarterStart = (d = new Date()) => `${d.getFullYear()}-${String(Math.floor(d.getMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/** Thresholds, matching what Mel asked to be warned about */
const WARN = { quietDays: 14, noMeetingDays: 60, facOverdueDays: 30, visitDays: 180 };

async function teamSnapshot() {
  const t = today();
  const rings = (await zoho.coql(queries.ringsForRep(null))).map(fromZoho.ring).filter(r => r.repZohoId);
  const ringIds = rings.map(r => r.id);
  const [actBatches, mtgBatches, users, notes, goals] = await Promise.all([
    Promise.all(chunk(ringIds, 20).map(b => zoho.coql(queries.visitsForRings(b)))),
    Promise.all(chunk(ringIds, 20).map(b => zoho.coql(`select id, Growth_Ring_Group, Meeting_Datetime, Meeting_Status from ${M.MEETING}
      where Growth_Ring_Group in (${b.map(i => `'${i}'`).join(',')}) and Meeting_Datetime >= '${addDays(t, -120)}T00:00:00+00:00' limit 200`))),
    q.allUsers(), q.allRepNotes(), q.goalsFor(quarterOf()),
  ]);
  const acts = actBatches.flat().map(fromZoho.activity);
  const meetings = mtgBatches.flat().map(m => ({ ringId: m.Growth_Ring_Group?.id, date: String(m.Meeting_Datetime || '').slice(0, 10),
    status: /^complete/i.test(m.Meeting_Status || '') ? 'held' : /^cancel/i.test(m.Meeting_Status || '') ? 'cancelled' : 'planned' }));

  const reps = new Map();
  rings.forEach(r => {
    if (!reps.has(r.repZohoId)) reps.set(r.repZohoId, { id: r.repZohoId, name: r.repName || 'Rep', rings: [] });
    reps.get(r.repZohoId).rings.push(r);
  });
  const qs = quarterStart();
  const out = [...reps.values()].map(rep => {
    const ids = new Set(rep.rings.map(r => r.id));
    const mine = acts.filter(a => a.repZohoId === rep.id || ids.has(a.ringId));
    const made = mine.filter(a => a.outcome && a.date && a.date <= t);
    // What is due: the newest call per person (or per ring for facilitator calls)
    const latest = new Map();
    mine.forEach(a => { const k = a.memberId ? 'm' + a.memberId : 'r' + a.ringId + a.type;
      const c = latest.get(k); if (!c || String(a.date) > String(c.date)) latest.set(k, a); });
    const due = [...latest.values()].filter(a => a.nextDue);
    const overdue = due.filter(a => daysUntil(a.nextDue) < 0);
    const facLate = overdue.filter(a => /facilitator/i.test(a.type) && daysUntil(a.nextDue) <= -WARN.facOverdueDays);
    const lastMeet = id => meetings.filter(m => m.ringId === id && m.status === 'held' && m.date <= t).map(m => m.date).sort().pop() || null;
    const lastVisit = r => [r.lastRepVisit, ...mine.filter(a => a.ringId === r.id && /visit/i.test(a.type) && a.outcome).map(a => a.date)]
      .filter(Boolean).sort().pop() || null;
    const account = users.find(u => u.zoho_owner_id === rep.id);
    const goal = goals.find(g => g.rep_id === rep.id) || null;
    const repNotes = notes.filter(n => n.rep_id === rep.id);
    const nextCheckin = repNotes.map(n => n.next_checkin).filter(Boolean).map(d => String(d instanceof Date ? d.toISOString() : d).slice(0, 10))
      .filter(d => d >= addDays(t, -60)).sort()[0] || null;
    return {
      id: rep.id, name: rep.name, email: account ? account.email : '', hasAccount: !!account,
      lastLogin: account && account.last_login_at ? new Date(account.last_login_at).toISOString() : null,
      rings: rep.rings.length,
      calls7: made.filter(a => daysUntil(a.date) >= -7).length,
      calls30: made.filter(a => daysUntil(a.date) >= -30).length,
      callsQuarter: made.filter(a => a.date >= qs).length,
      visitsQuarter: mine.filter(a => /visit/i.test(a.type) && a.outcome && a.date >= qs).length,
      lastCall: made.map(a => a.date).sort().pop() || null,
      overdue: overdue.length,
      facLate: facLate.map(a => ({ ring: rings.find(r => r.id === a.ringId)?.name || '', due: a.nextDue })),
      quietRings: rep.rings.filter(r => { const m = lastMeet(r.id); return !m || daysUntil(m) < -WARN.noMeetingDays; })
        .map(r => ({ id: r.id, name: r.name, lastMeeting: lastMeet(r.id) })),
      needVisit: rep.rings.filter(r => { const v = lastVisit(r); return !v || daysUntil(v) < -WARN.visitDays; })
        .map(r => ({ id: r.id, name: r.name, lastVisit: lastVisit(r), nextVisit: r.nextRepVisit || null })),
      upcomingMeetings: meetings.filter(m => ids.has(m.ringId) && m.status === 'planned' && m.date >= t && m.date <= addDays(t, 7))
        .map(m => ({ ring: rings.find(r => r.id === m.ringId)?.name || '', date: m.date })),
      goal: goal ? { calls: goal.calls, visits: goal.visits, newMembers: goal.new_members } : null,
      nextCheckin,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { at: new Date().toISOString(), quarter: quarterOf(), reps: out };
}

/** The things worth Mel's attention this week, most pressing first */
function warningsFrom(snap) {
  const w = [];
  snap.reps.forEach(r => {
    const quietSince = [r.lastLogin && r.lastLogin.slice(0, 10), r.lastCall].filter(Boolean).sort().pop();
    if (!quietSince || daysUntil(quietSince) < -WARN.quietDays) {
      w.push({ kind: 'quiet', rep: r.name, repId: r.id, text: quietSince
        ? `has not signed in or logged a call for ${-daysUntil(quietSince)} days` : 'has never signed in or logged a call' });
    }
    if (r.facLate.length) w.push({ kind: 'facLate', rep: r.name, repId: r.id,
      text: `${r.facLate.length} facilitator call${r.facLate.length === 1 ? ' is' : 's are'} over ${WARN.facOverdueDays} days overdue` });
    if (r.quietRings.length) w.push({ kind: 'noMeeting', rep: r.name, repId: r.id,
      text: `${r.quietRings.length} ring${r.quietRings.length === 1 ? ' has' : 's have'} had no meeting in ${WARN.noMeetingDays} days` });
    if (r.nextCheckin && r.nextCheckin <= today()) w.push({ kind: 'checkin', rep: r.name, repId: r.id, text: 'check-in is due' });
  });
  const order = { quiet: 0, facLate: 1, checkin: 2, noMeeting: 3 };
  return w.sort((a, b) => order[a.kind] - order[b.kind] || a.rep.localeCompare(b.rep));
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

function digestHTML(snap, name, appUrl) {
  const warn = warningsFrom(snap);
  const totalCalls = snap.reps.reduce((s, r) => s + r.calls7, 0);
  const upcoming = snap.reps.flatMap(r => r.upcomingMeetings.map(m => ({ ...m, rep: r.name }))).sort((a, b) => a.date.localeCompare(b.date));
  const visits = snap.reps.reduce((s, r) => s + r.needVisit.length, 0);
  const cell = 'padding:6px 8px;border-bottom:1px solid #e3e6da;font-size:13px';
  return `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1E2A20">
  <div style="max-width:620px;margin:0 auto;padding:24px 18px">
    <h1 style="font-size:20px;margin:0 0 4px">Your reps this week</h1>
    <p style="color:#5A6455;margin:0 0 18px;font-size:14px">${esc((name || '').split(' ')[0] || 'Hello')}, ${totalCalls} call${totalCalls === 1 ? '' : 's'} logged across the team last week.
      ${warn.length ? `${warn.length} thing${warn.length === 1 ? '' : 's'} need${warn.length === 1 ? 's' : ''} your attention.` : 'Nothing needs your attention.'}</p>
    ${warn.length ? `<h2 style="font-size:15px;margin:18px 0 8px">Needs your attention</h2>
      <ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.6">${warn.map(x => `<li><strong>${esc(x.rep)}</strong> ${esc(x.text)}</li>`).join('')}</ul>` : ''}
    <h2 style="font-size:15px;margin:22px 0 8px">Each rep</h2>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px">
      <tr style="text-align:left;color:#5A6455;font-size:12px"><th style="${cell}">Rep</th><th style="${cell}">Rings</th><th style="${cell}">Calls (7 days)</th><th style="${cell}">Overdue</th><th style="${cell}">Last signed in</th></tr>
      ${snap.reps.map(r => `<tr><td style="${cell}">${esc(r.name)}</td><td style="${cell}">${r.rings}</td><td style="${cell}">${r.calls7}</td>
        <td style="${cell};color:${r.overdue ? '#A2452C' : '#1E2A20'}">${r.overdue}</td><td style="${cell}">${r.lastLogin ? fmt(r.lastLogin.slice(0, 10)) : (r.hasAccount ? 'never' : 'no account')}</td></tr>`).join('')}
    </table>
    ${upcoming.length ? `<h2 style="font-size:15px;margin:22px 0 8px">Ring meetings this week</h2>
      <ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.6">${upcoming.slice(0, 25).map(m => `<li>${fmt(m.date)} — ${esc(m.ring)} (${esc(m.rep)})</li>`).join('')}</ul>` : ''}
    ${visits ? `<p style="font-size:14px;margin:18px 0 0">${visits} ring${visits === 1 ? '' : 's'} have not had a rep visit in 6 months. The visit plan in Rep Hub lists them by rep.</p>` : ''}
    <p style="margin:24px 0 0"><a href="${esc(appUrl)}" style="background:#2E5132;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open Rep manager</a></p>
    <p style="color:#8A9284;font-size:12px;margin-top:22px">Sent every Monday by Rep Hub. Turn it off from Rep manager → Weekly email.</p>
  </div></body></html>`;
}

/**
 * Monday email to everyone in the office who manages reps (the `manager`
 * access) and has not switched the weekly email off.
 */
async function runManagerDigest({ dryRun = false, onlyUserId = null } = {}) {
  const { permsFor } = require('./access');
  const { sendEmail } = require('./reminders');
  const cfg = require('./config');
  const office = (await q.allUsers()).filter(u => u.role !== 'rep' && (!onlyUserId || u.id === onlyUserId));
  const managers = [];
  for (const u of office) if ((await permsFor(u)).manager) managers.push(u);
  if (!managers.length) return [{ sent: 0, reason: 'nobody manages reps' }];
  const snap = await teamSnapshot();
  const warnings = warningsFrom(snap);
  if (dryRun) return [{ dryRun: true, to: managers.map(m => m.email), reps: snap.reps.length, warnings }];
  const out = [];
  for (const u of managers) {
    if (!u.digest_email && !onlyUserId) { out.push({ to: u.email, skipped: 'turned off' }); continue; }
    const r = await sendEmail(u.email, `Your reps this week: ${warnings.length ? warnings.length + ' to look at' : 'all on track'}`,
      digestHTML(snap, u.name, cfg.appUrl), { userId: u.id, kind: 'manager-digest' });
    out.push({ to: u.email, ok: !!r.ok, error: r.error });
  }
  return out;
}

module.exports = { teamSnapshot, warningsFrom, digestHTML, runManagerDigest, quarterOf, quarterStart, WARN };

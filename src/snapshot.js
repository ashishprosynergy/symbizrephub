'use strict';
/**
 * The weekly email for reps who don't use Rep Hub (Mel, 4 Nov: Michael Beiler
 * and Larry Weaver have no internet, only email). Every Monday each rep the
 * office has picked gets one email that stands in for the app:
 *   - their numbers: rings, members, calls overdue and due this week;
 *   - the calls due, with phone numbers and what was said last time;
 *   - the next 30 days: ring meetings, rep visits, events and Symbiz calls;
 *   - a reply section to fill in. Replies go to the office (Mel), who logs them.
 * Links are kept to a minimum: these reps often read mail on filtered devices.
 */
const zoho = require('./lib/zoho');
const { queries, fromZoho, today, addDays, daysUntil, M } = require('./domain');
const { q, setting } = require('./db');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nice = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const inList = ids => ids.map(i => `'${String(i).replace(/'/g, '')}'`).join(',');

/** Who gets it: [{ id (Zoho contact id), name, email }] */
async function chosenReps() {
  try { const v = JSON.parse(await setting('snapshotReps', '[]')); return Array.isArray(v) ? v.filter(r => r && r.id) : []; }
  catch (_) { return []; }
}

/** Every rep named on an active ring, with the email Zoho has for them */
async function zohoReps() {
  const rings = await zoho.coql(queries.repsOnRings());
  const by = new Map();
  rings.forEach(r => { if (r.Regional_Rep?.id) by.set(r.Regional_Rep.id, { id: r.Regional_Rep.id, name: r.Regional_Rep.name, rings: (by.get(r.Regional_Rep.id)?.rings || 0) + 1 }); });
  const ids = [...by.keys()];
  for (const b of chunk(ids, 50)) {
    (await zoho.coql(queries.contactsByIds(b))).forEach(c => { const x = by.get(c.id); if (x) x.email = c.Email || ''; });
  }
  return [...by.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Everything the email shows, for one rep (a Zoho contact id) */
async function gather(repId, { calls = null } = {}) {
  const t = today(), until = addDays(t, 30);
  const rings = (await zoho.coql(queries.ringsForRep(repId))).map(fromZoho.ring);
  const ringIds = rings.map(r => r.id);
  const ringOf = id => rings.find(r => r.id === id) || {};
  const [linkRows, actRows, mtgRows, eventRows] = await Promise.all([
    Promise.all(chunk(ringIds, 20).map(b => zoho.coql(queries.groupMembersFor(b)))).then(x => x.flat()),
    Promise.all(chunk(ringIds, 20).map(b => zoho.coql(queries.visitsForRings(b)))).then(x => x.flat()),
    Promise.all(chunk(ringIds, 20).map(b => zoho.coql(`select id, Growth_Ring_Group, Meeting_Datetime, Meeting_Status, Location from ${M.MEETING}
      where Growth_Ring_Group in (${inList(b)}) and Meeting_Datetime between '${t}T00:00:00+00:00' and '${until}T23:59:59+00:00' limit 200`)
      .catch(() => []))).then(x => x.flat()),
    zoho.coql(queries.portalEvents()).catch(() => []),
  ]);
  // Members and facilitators, for names and phone numbers
  const people = new Map();
  const wanted = [...new Set([...linkRows.map(l => l.Members?.id), ...rings.map(r => r.facId)].filter(Boolean))];
  for (const b of chunk(wanted, 50)) (await zoho.coql(queries.contactsByIds(b))).map(fromZoho.member).forEach(m => people.set(m.id, m));
  const members = [...new Set(linkRows.map(l => l.Members?.id).filter(Boolean))];

  // Who is due: the latest activity for each member (or ring and call type) that set a next date,
  // the same rule as the app's call list
  const acts = actRows.map(fromZoho.activity);
  const latest = new Map();
  acts.forEach(a => {
    const k = a.memberId ? 'm:' + a.memberId : 'r:' + (a.ringId || '') + ':' + (a.type || '');
    const cur = latest.get(k);
    if (!cur || String(a.date || '') > String(cur.date || '')) latest.set(k, a);
  });
  const due = [...latest.values()].filter(a => a.nextDue && daysUntil(a.nextDue) <= 7)
    .sort((a, b) => String(a.nextDue).localeCompare(String(b.nextDue)))
    .map(a => {
      const ring = ringOf(a.ringId);
      const who = a.memberId ? people.get(a.memberId) : people.get(ring.facId);
      return { name: a.memberName || (who && who.name) || ring.facName || ring.name || 'Ring', type: String(a.type || 'Call').replace(/ Call$/, ''),
        ring: ring.name || a.ringName || '', phone: who ? (who.mobile || who.phone || who.phone2) : '', due: a.nextDue,
        overdue: daysUntil(a.nextDue) < 0, lastDate: a.date, lastNotes: a.notes };
    });

  // The next 30 days
  const when = [];
  mtgRows.filter(m => !/^cancel/i.test(m.Meeting_Status || '')).forEach(m => when.push({ date: String(m.Meeting_Datetime).slice(0, 10),
    what: `${m.Growth_Ring_Group?.name || 'Ring'} meets`, where: m.Location || '' }));
  rings.forEach(r => { const d = String(r.nextRepVisit || '').slice(0, 10); if (d >= t && d <= until) when.push({ date: d, what: `Your visit: ${r.name}`, where: '' }); });
  eventRows.map(fromZoho.event).filter(e => e.date >= t && e.date <= until && !/cancel/i.test(e.status) && (!e.repZohoId || e.repZohoId === repId))
    .forEach(e => when.push({ date: e.date, what: e.title, where: [e.time, e.venue, e.city, e.state].filter(Boolean).join(', ') }));
  ((calls && calls.items) || []).forEach(c => when.push({ date: c.date, what: c.title,
    where: c.allDay ? '' : new Date(c.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' Eastern' }));
  when.sort((a, b) => a.date.localeCompare(b.date));

  return { rings, members: members.length, due, when, overdue: due.filter(d => d.overdue).length, thisWeek: due.filter(d => !d.overdue).length };
}

function render(rep, s, { replyTo = '', officeName = 'the office' } = {}) {
  const first = String(rep.name || '').replace(/\s*#\s*\d+\s*$/, '').split(' ')[0] || 'there';
  const cell = 'padding:6px 8px;border-bottom:1px solid #e5e2da;vertical-align:top;font-size:14px';
  const tile = (n, l) => `<td style="padding:10px;text-align:center;border:1px solid #e5e2da;border-radius:6px"><div style="font-size:22px;font-weight:700">${n}</div><div style="font-size:12px;color:#555">${l}</div></td>`;
  const dueRows = s.due.map(d => `<tr>
      <td style="${cell}"><strong>${esc(d.name)}</strong><br><span style="color:#555">${esc(d.type)}${d.ring ? ' · ' + esc(d.ring) : ''}</span></td>
      <td style="${cell};white-space:nowrap">${esc(d.phone || '—')}</td>
      <td style="${cell};white-space:nowrap;${d.overdue ? 'color:#b3261e;font-weight:600' : ''}">${d.overdue ? 'Overdue since ' : ''}${nice(d.due)}</td>
      <td style="${cell};color:#555">${d.lastDate ? 'Spoke ' + nice(d.lastDate) : 'Not yet'}${d.lastNotes ? ': ' + esc(String(d.lastNotes).slice(0, 140)) : ''}</td></tr>`).join('');
  const whenRows = s.when.map(w => `<tr><td style="${cell};white-space:nowrap">${nice(w.date)}</td><td style="${cell}">${esc(w.what)}${w.where ? `<br><span style="color:#555">${esc(w.where)}</span>` : ''}</td></tr>`).join('');
  const replyLines = s.due.length
    ? s.due.map(d => `${esc(d.name)}: called? ___ date ___ what they said: ____________`).join('<br>')
    : 'Name: ___ date ___ what they said: ____________';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f1f1f;max-width:640px">
    <h2 style="margin:0 0 4px">Your week, ${esc(first)}</h2>
    <div style="color:#555;margin-bottom:14px">Rep Hub for ${nice(today())}. Everything below is from Zoho as of this morning.</div>
    <table style="border-collapse:separate;border-spacing:6px;width:100%"><tr>
      ${tile(s.rings.length, 'Growth Rings')}${tile(s.members, 'Members')}${tile(s.overdue, 'Calls overdue')}${tile(s.thisWeek, 'Due this week')}</tr></table>
    <h3 style="margin:18px 0 6px">Calls to make</h3>
    ${s.due.length ? `<table style="border-collapse:collapse;width:100%">${dueRows}</table>` : '<p>Nothing due this week. Thank you!</p>'}
    <h3 style="margin:18px 0 6px">The next 30 days</h3>
    ${s.when.length ? `<table style="border-collapse:collapse;width:100%">${whenRows}</table>` : '<p>Nothing on the calendar.</p>'}
    <h3 style="margin:18px 0 6px">Your report for the week</h3>
    <p style="margin:0 0 8px">Press <strong>Reply</strong>, fill in the lines below and send it back. It goes to ${esc(officeName)}${replyTo ? ` (${esc(replyTo)})` : ''}, who will enter it into Rep Hub for you. Add anything else they should know.</p>
    <div style="font-family:Consolas,monospace;font-size:13px;background:#f6f5f1;padding:10px;border-radius:6px;line-height:1.8">${replyLines}<br>Anything else: ____________</div>
  </div>`;
}

/** Build one rep's email (also the preview) */
async function emailFor(rep, { calls } = {}) {
  const s = await gather(rep.id, { calls });
  const replyTo = (await setting('snapshotReplyTo', '')).trim();
  const subject = `Your week: ${s.overdue + s.thisWeek} call${s.overdue + s.thisWeek === 1 ? '' : 's'} to make${s.overdue ? `, ${s.overdue} overdue` : ''}`;
  return { subject, html: render(rep, s, { replyTo }), replyTo, stats: { due: s.due.length, when: s.when.length } };
}

/** Monday: every chosen rep. `only` = one rep id; `to` sends it somewhere else (a test) */
async function run({ dryRun = false, only = null, to = null, calls = null } = {}) {
  const { sendEmail } = require('./reminders');
  const reps = (await chosenReps()).filter(r => !only || r.id === only);
  const out = [];
  for (const rep of reps) {
    try {
      const addr = to || rep.email;
      if (!addr) { out.push({ rep: rep.name, skipped: 'no email' }); continue; }
      const m = await emailFor(rep, { calls });
      if (dryRun) { out.push({ rep: rep.name, to: addr, subject: m.subject, ...m.stats }); continue; }
      const r = await sendEmail(addr, m.subject, m.html, { kind: 'rep-snapshot', ...(m.replyTo ? { replyTo: m.replyTo } : {}) });
      out.push({ rep: rep.name, to: addr, ok: !!r.ok, error: r.error });
    } catch (e) { out.push({ rep: rep.name, error: e.message }); }
  }
  if (!dryRun && !to && !only) await q.setSetting('snapshot_last', JSON.stringify({ at: new Date().toISOString(), results: out })).catch(() => {});
  return out;
}

module.exports = { chosenReps, zohoReps, gather, render, emailFor, run };

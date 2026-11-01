'use strict';
/**
 * The Symbiz calendar, read from its private iCal link.
 *
 * Google Calendar (Settings → the calendar → "Secret address in iCal format")
 * and Zoho Calendar both publish one, so Rep Hub needs no Google sign-in and
 * no Zoom access: the Zoom or Zoho Meeting link is already in each event.
 *
 * Handles what those calendars send: times in a named time zone, in UTC or
 * all-day; weekly, daily, monthly and yearly repeats (INTERVAL, BYDAY,
 * BYMONTHDAY, UNTIL, COUNT); skipped dates (EXDATE); one changed or cancelled
 * meeting in a series (RECURRENCE-ID). Times come back in UTC.
 */

/* Outlook writes Windows zone names; the rest send IANA ones */
const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis', 'India Standard Time': 'Asia/Kolkata',
};
const DEFAULT_TZ = 'America/New_York';

function validTz(tz) {
  const z = WINDOWS_TZ[tz] || tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch (_) { return null; }
}

/** Minutes the zone is ahead of UTC at that moment (EDT → -240) */
function offsetMinutes(tz, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
  return Math.round((asUtc - utcMs) / 60000);
}
/** A wall-clock time in a zone → UTC milliseconds (right across daylight saving) */
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let out = guess - offsetMinutes(tz, guess) * 60000;
  const again = guess - offsetMinutes(tz, out) * 60000;
  if (again !== out) out = again;
  return out;
}

/* ── reading the file ── */
function unfold(text) { return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
function unescape(v) { return String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'); }

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const [name, ...ps] = head.split(';');
  const params = {};
  ps.forEach(p => { const i = p.indexOf('='); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ''); });
  return { name: name.toUpperCase(), params, value };
}

/** "20261103T090000" with its TZID → { y,mo,d,h,mi,s, allDay, utc, tz } */
function parseWhen(prop, calTz) {
  if (!prop) return null;
  const m = String(prop.value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const allDay = prop.params.VALUE === 'DATE' || !m[4];
  const tz = m[7] ? 'UTC' : (validTz(prop.params.TZID) || calTz);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), allDay, tz };
}
const wallKey = w => `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}T${String(w.h).padStart(2, '0')}${String(w.mi).padStart(2, '0')}`;
const toUtc = w => w.allDay ? Date.UTC(w.y, w.mo - 1, w.d) : zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, w.tz);

function parse(text) {
  const lines = unfold(text).split('\n');
  let calTz = DEFAULT_TZ, cur = null, depth = 0;
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'X-WR-TIMEZONE') calTz = validTz(p.value.trim()) || calTz;
    if (p.name === 'BEGIN' && p.value === 'VEVENT') { cur = { props: {}, multi: {} }; depth = 0; continue; }
    if (!cur) continue;
    if (p.name === 'BEGIN') { depth++; continue; }               // a VALARM inside the event
    if (p.name === 'END' && p.value === 'VEVENT') { events.push(cur); cur = null; continue; }
    if (p.name === 'END') { depth--; continue; }
    if (depth > 0) continue;
    if (p.name === 'EXDATE') (cur.multi.EXDATE = cur.multi.EXDATE || []).push(p);
    else cur.props[p.name] = p;
  }
  return { calTz, events: events.map(e => toEvent(e, calTz)).filter(Boolean) };
}

function toEvent(e, calTz) {
  const P = e.props;
  const start = parseWhen(P.DTSTART, calTz);
  if (!start) return null;
  let end = parseWhen(P.DTEND, calTz), durMs = null;
  if (end) durMs = toUtc(end) - toUtc(start);
  else if (P.DURATION) {
    const m = P.DURATION.value.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
    if (m) durMs = (((+m[1] || 0) * 7 + (+m[2] || 0)) * 24 * 60 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 60000;
  }
  if (durMs == null) durMs = start.allDay ? 864e5 : 3600e3;
  const exdates = new Set();
  (e.multi.EXDATE || []).forEach(x => String(x.value).split(',').forEach(v => {
    const w = parseWhen({ value: v, params: x.params }, calTz);
    if (w) exdates.add(start.allDay ? wallKey({ ...w, h: 0, mi: 0 }).slice(0, 10) : toUtc(w));
  }));
  const text = [P.SUMMARY, P.LOCATION, P.DESCRIPTION, P.URL, P['X-GOOGLE-CONFERENCE']].map(x => x ? unescape(x.value) : '').join('\n');
  return {
    uid: P.UID ? P.UID.value : '', title: unescape(P.SUMMARY && P.SUMMARY.value).trim() || '(no title)',
    location: unescape(P.LOCATION && P.LOCATION.value).trim(), start, durMs, exdates,
    rrule: P.RRULE ? Object.fromEntries(P.RRULE.value.split(';').map(kv => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v])) : null,
    recurrenceId: P['RECURRENCE-ID'] ? parseWhen(P['RECURRENCE-ID'], calTz) : null,
    cancelled: P.STATUS && /cancel/i.test(P.STATUS.value),
    link: meetingLink(text),
  };
}

/** The join link: Zoom or Zoho Meeting first, then Google Meet or Teams, then any link */
function meetingLink(text) {
  const urls = (String(text).replace(/<[^>]+>/g, ' ').match(/https?:\/\/[^\s<>"'\])]+/g) || []).map(u => u.replace(/[.,;]+$/, ''));
  const pick = re => urls.find(u => re.test(u));
  return pick(/zoom\.us\/(j|w|my|s)\//i) || pick(/zoho\.(com|eu|in)\/meeting|meeting\.zoho|zohomeeting/i) || pick(/meet\.google\.com/i)
    || pick(/teams\.microsoft\.com|teams\.live\.com/i) || pick(/zoom\.us/i) || null;
}

/* ── repeating meetings ── */
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const addDaysW = (w, n) => { const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n)); return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const dowOf = w => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();

/** Every start (wall clock) of a series up to `untilMs`, at most `cap` */
function occurrences(ev, untilMs, cap = 1500) {
  const r = ev.rrule, s = ev.start;
  if (!r) return [s];
  const freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1), count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? toUtc(parseWhen({ value: r.UNTIL, params: {} }, 'UTC')) : Infinity;
  const stopAt = Math.min(until, untilMs);
  const out = [];
  const take = w => { if (out.length >= count || out.length >= cap) return false; const t = toUtc(w); if (t > stopAt) return false; if (t >= toUtc(s)) out.push(w); return true; };
  const byday = (r.BYDAY || '').split(',').filter(Boolean);
  if (freq === 'DAILY') {
    for (let w = s; take(w); w = addDaysW(w, interval));
  } else if (freq === 'WEEKLY') {
    const days = byday.length ? byday.map(b => DOW[b.slice(-2)]).sort((a, b) => a - b) : [dowOf(s)];
    let weekStart = addDaysW(s, -dowOf(s));
    for (let guard = 0; guard < 5000; guard++, weekStart = addDaysW(weekStart, 7 * interval)) {
      let more = true;
      for (const d of days) { const w = addDaysW(weekStart, d); if (toUtc(w) < toUtc(s)) continue; if (!take(w)) { more = false; break; } }
      if (!more) break;
    }
  } else if (freq === 'MONTHLY') {
    for (let k = 0, guard = 0; guard < 2000; k += interval, guard++) {
      const base = new Date(Date.UTC(s.y, s.mo - 1 + k, 1));
      const y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      let dates = [];
      if (byday.length) {
        byday.forEach(b => {
          const m = b.match(/^([+-]?\d+)?([A-Z]{2})$/); if (!m) return;
          const want = DOW[m[2]], all = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === want) all.push(d);
          const n = m[1] ? +m[1] : 0;
          if (!n) dates.push(...all); else { const d = n > 0 ? all[n - 1] : all[all.length + n]; if (d) dates.push(d); }
        });
      } else dates = (r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : [s.d]).map(d => d < 0 ? dim + d + 1 : d).filter(d => d >= 1 && d <= dim);
      let more = true;
      for (const d of [...new Set(dates)].sort((a, b) => a - b)) if (!take({ ...s, y, mo, d })) { more = false; break; }
      if (!more || Date.UTC(y, mo - 1, 1) > stopAt) break;
    }
  } else if (freq === 'YEARLY') {
    for (let k = 0; k < 200; k += interval) if (!take({ ...s, y: s.y + k })) break;
  } else out.push(s);
  return out;
}

/** What kind of Symbiz call a title is */
function kindOf(title) {
  if (/\bL\s?-?\s?10\b|level\s*10/i.test(title)) return 'L10';
  if (/facilitator/i.test(title)) return 'Facilitator call';
  if (/forum/i.test(title)) return 'Forum call';
  return 'Other';
}

/**
 * The meetings between two times, from one or more calendar files.
 * `keywords`: only titles with one of these words (empty = everything).
 */
function between(texts, fromMs, toMs, { keywords = [] } = {}) {
  const out = [];
  const wanted = t => !keywords.length || keywords.some(k => t.toLowerCase().includes(k.toLowerCase()));
  for (const text of [].concat(texts)) {
    const { events } = parse(text);
    // Changed or cancelled single meetings of a series, by series and original start
    const moved = new Map();
    events.filter(e => e.recurrenceId).forEach(e => moved.set(e.uid + '|' + toUtc(e.recurrenceId), e));
    const push = (ev, w) => {
      const startMs = toUtc(w), endMs = startMs + ev.durMs;
      if (ev.cancelled || endMs < fromMs || startMs > toMs || !wanted(ev.title)) return;
      out.push({
        id: `${ev.uid || ev.title}|${startMs}`, title: ev.title, type: kindOf(ev.title),
        start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), allDay: !!ev.start.allDay,
        date: wallKey(w).slice(0, 10), link: ev.link, where: ev.location && !/^https?:/i.test(ev.location) ? ev.location : '',
      });
    };
    for (const ev of events) {
      if (ev.recurrenceId) continue;                                   // handled with its series
      for (const w of occurrences(ev, toMs)) {
        const t = toUtc(w);
        if (ev.exdates.has(ev.start.allDay ? wallKey(w).slice(0, 10) : t)) continue;
        const change = moved.get(ev.uid + '|' + t);
        if (change) { if (!change.cancelled) push(change, change.start); continue; }
        push(ev, w);
      }
    }
    // A moved meeting whose series is not in this file (or ended): still show it
    events.filter(e => e.recurrenceId && !events.some(x => !x.recurrenceId && x.uid === e.uid)).forEach(e => push(e, e.start));
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => a.start.localeCompare(b.start));
}

module.exports = { parse, between, meetingLink, kindOf, zonedToUtc };

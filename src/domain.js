'use strict';
/**
 * Domain rules and Zoho mapping.
 *
 * ── IMPORTANT ──
 * Every module and field name below was READ FROM Symbiz's live Zoho CRM on
 * 13 October 2026, not invented. Their org is already well built: Growth Rings,
 * meetings, visits, events and regions all exist. We map onto that schema
 * rather than creating a parallel one.
 *
 * Verified module API names:
 *   Growth_Ring_Groups      the rings
 *   Rep_Visit_Trackings     rep visits to a group
 *   Growth_Ring_Meetings_N  group meetings
 *   Symbiz_Events           events
 *   Event_Registrations     who registered
 *   Regions                 regions
 *   Contacts                members, facilitators AND reps
 *
 * The most important fact about this schema: A REP IS A CONTACT, not a CRM
 * user. Growth_Ring_Groups.Regional_Rep is a lookup to Contacts. That is what
 * lets reps use this app without consuming a Zoho One licence.
 *
 * The member -> rep link is INDIRECT:
 *   Contact (member) -> their Growth Ring Group -> Regional_Rep -> Contact (rep)
 * There is no rep field on the member record. Always resolve through the group.
 */
const cfg = require('./config');

/* ─────────── cadence ─────────── */
const FREQ_DAYS = { 'Quarterly': 91, 'Semi-Annual': 182, 'Annual': 365 };
const RETRY_DAYS = 4;
const RESCHEDULE_DAYS = 7;

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }
function daysUntil(isoDate, from = today()) {
  if (!isoDate) return null;
  return Math.round((new Date(`${isoDate}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * Turn a Zoho datetime into the calendar day and clock time Symbiz would
 * recognise. Zoho returns the connection's offset, not the venue's, so a
 * 6:30pm Ohio meeting can come back as "02:00+05:30" the following day.
 * Everything is normalised to US Eastern, where the organisation operates.
 */
function zonedParts(dt, tz = 'America/New_York') {
  if (!dt) return { date: '', time: '', iso: null };
  const d = new Date(dt);
  if (isNaN(d)) return { date: '', time: '', iso: null };
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  fmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  const h = parseInt(p.hour, 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${h12}:${p.minute} ${h < 12 ? 'AM' : 'PM'}`,
    iso: d.toISOString(),
  };
}

/** Their Meeting_Frequency picklist, mapped to days. */
const MEETING_FREQ_DAYS = {
  'Weekly': 7, 'Monthly': 30, 'Bi Monthly': 60,
  'Quarterly': 91, 'Yearly': 365, 'Other': null,
};

/**
 * THE core scheduling rule.
 * A missed call must NOT reset the long cycle — if nobody picks up on an
 * annual member call, the next attempt is days away, not a year.
 */
function nextDueDate({ type, outcome, date, facFreq, memFreq, settings = {} }) {
  const retry = settings.retryDays ?? RETRY_DAYS;
  const resched = settings.rescheduleDays ?? RESCHEDULE_DAYS;

  if (outcome === 'No answer' || outcome === 'Left voicemail') return addDays(date, retry);
  if (outcome === 'Rescheduled') return addDays(date, resched);

  if (type === 'Facilitator Call') return addDays(date, FREQ_DAYS[facFreq] ?? FREQ_DAYS.Quarterly);
  if (type === 'Member Call')      return addDays(date, FREQ_DAYS[memFreq] ?? FREQ_DAYS.Annual);
  return null;   // visits and exit interviews do not recur on a cycle
}

/** Ring health 0-100, computed from what their schema actually holds. */
function ringHealth({ meetings = [], lastRepVisit, memberCount, targetSize, meetingFrequency, status }) {
  let score = 0;

  const recent = (meetings || []).slice(0, 3);
  if (recent.length) {
    const rate = recent.reduce((s, m) => {
      const total = (m.attended || 0) + (m.absent || 0);
      return s + (total ? m.attended / total : 0);
    }, 0) / recent.length;
    score += rate * 40;
  } else score += 12;

  const gap = lastRepVisit ? Math.abs(daysUntil(lastRepVisit)) : 999;
  score += gap <= 180 ? 30 : gap <= 365 ? 18 : 5;

  const target = targetSize || 8;
  score += Math.min(20, ((memberCount || 0) / Math.max(1, target)) * 20);

  if (meetingFrequency) score += 10;   // a group with no rhythm set is a risk
  if (status === 'Inactive') score -= 25;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ═══════════════ ZOHO MAPPING ═══════════════ */
const M = cfg.modules;

const toZoho = {
  /**
   * A rep visit / logged contact, stored in their Rep_Visit_Trackings module.
   *
   * FOUR FIELDS MUST BE ADDED to that module before writes work (see
   * ZOHO-SETUP.md): Rep, Member, Outcome, Next_Due_Date. Everything else
   * already exists. Name is an autonumber — never send it.
   */
  activity: a => ({
    Visit_Date: a.date,
    Visit_Type: a.type,                                   // existing free-text field
    Visit_Notes: a.notes || '',
    Growth_Ring_Group: a.ringId ? { id: a.ringId } : undefined,
    Rep: a.repZohoId ? { id: a.repZohoId } : undefined,   // TO ADD: lookup -> Contacts
    Member: a.memberId ? { id: a.memberId } : undefined,  // TO ADD: lookup -> Contacts
    Outcome: a.outcome || undefined,                      // TO ADD: picklist
    Next_Due_Date: a.nextDue || null,                     // TO ADD: date
  }),

  /** Growth_Ring_Groups. Only fields the app is allowed to set. */
  ring: r => ({
    Name: r.name,
    Facilitator: r.facId ? { id: r.facId } : undefined,
    Regional_Rep: r.repZohoId ? { id: r.repZohoId } : undefined,
    Region_Lookup: r.regionId ? { id: r.regionId } : undefined,
    Target_Group_Size: r.capacity,
    Status: r.status,                         // Active | Inactive | Pending
    Group_Type: r.groupType || 'Growth Ring',
    Meeting_Frequency: r.meetingFrequency,    // Weekly|Monthly|Bi Monthly|Quarterly|Yearly|Other
    Meeting_Format: r.meetingFormat,          // Virtual | In Person | Hybrid
    Next_Meeting_Date_Time: r.nextMeeting,
    Last_Rep_Visit: r.lastRepVisit,
    Next_Rep_Visit: r.nextRepVisit,
    Group_Description: r.description,
  }),

  /** Growth_Ring_Meetings_N — confirm field names before the first write. */
  meeting: m => ({
    Growth_Ring_Group: { id: m.ringId },
    Meeting_Date: m.date,
    Notes: m.notes || '',
  }),

  /** Contacts. Deliberately narrow — we do not rewrite member master data. */
  member: m => ({
    Last_Name: m.name,
    Phone: m.phone,
    Email: m.email,
    Mailing_State: m.region,
  }),
};

const fromZoho = {
  ring: z => ({
    id: z.id,
    name: z.Name,
    facId: z.Facilitator?.id || null,
    facName: z.Facilitator?.name || null,
    repZohoId: z.Regional_Rep?.id || null,      // the rep, as a Contact id
    repName: z.Regional_Rep?.name || null,
    regionId: z.Region_Lookup?.id || null,
    regionName: z.Region_Lookup?.name || null,
    memberCount: z.of_Members ?? 0,
    capacity: z.Target_Group_Size || null,
    status: z.Status || (z.Active ? 'Active' : 'Inactive'),
    active: z.Active !== false,
    groupType: z.Group_Type || 'Growth Ring',
    meetingFrequency: z.Meeting_Frequency || null,
    meetingFormat: z.Meeting_Format || null,
    meetingDateTime: z.Meeting_Date_Time || null,
    nextMeeting: z.Next_Meeting_Date_Time || null,
    lastRepVisit: z.Last_Rep_Visit || null,
    nextRepVisit: z.Next_Rep_Visit || null,
    description: z.Group_Description || '',
    grGroupId: z.GR_Group_Id || null,
  }),

  activity: z => ({
    id: z.id,
    ref: z.Name,                                // autonumber, e.g. Rep-Visit12
    type: z.Visit_Type || 'Visit',
    date: z.Visit_Date,
    notes: z.Visit_Notes || '',
    ringId: z.Growth_Ring_Group?.id || null,
    ringName: z.Growth_Ring_Group?.name || null,
    repZohoId: z.Rep?.id || null,
    repName: z.Rep?.name || null,
    memberId: z.Member?.id || null,
    memberName: z.Member?.name || null,
    outcome: z.Outcome || null,
    nextDue: z.Next_Due_Date || null,
  }),

  /** Contacts -> member. Their Full_Name already carries the member number. */
  member: z => ({
    id: z.id,
    name: z.Full_Name,
    memberNo: z.Member_Id ?? null,
    email: z.Email || '',
    phone: z.Phone || '',
    business: z.Account_Name?.name || '',
    region: z.Mailing_State || '',
    isFacilitator: z.Is_Facilitator === 'Yes',
    status: z.Status || 'Active',
    active: z.Active !== false,
    joined: z.Paid_Membership_StartDate || null,
    daysWithoutGroup: z.Days_without_Group ?? null,
  }),

  /**
   * Symbiz_Events.
   *
   * CAREFUL WITH THE DATE. Zoho returns Event_Date_and_Time with the
   * connection's offset, e.g. "2026-10-23T02:00:00+05:30", which is actually
   * 22 October in the US. Taking the first ten characters shows the wrong day.
   * We convert the real instant into US Eastern, where Symbiz operates.
   */
  event: z => {
    const when = zonedParts(z.Event_Date_and_Time);
    return {
      id: z.id,
      title: z.Name,
      type: z.Event_Type || 'Local Event',
      date: when.date,
      time: when.time,
      venue: z.Event_Venue || '',
      city: z.Event_City || '',
      state: z.Event_State || '',
      format: z.Event_Format || '',
      status: z.Event_Status || '',
      repZohoId: z.Regional_Rep?.id || null,
      repName: z.Regional_Rep?.name || null,
      regionName: z.Region?.name || null,
      registrationCount: z.Registration_Count ?? z.Total_Registered_People ?? 0,
      attendanceCount: z.Attendance_Count ?? null,
      registrationDeadline: z.Registration_Deadline || null,
      joinLink: z.Meeting_Join_Link || '',
      showOnPortal: z.Show_on_Portal !== false,
    };
  },

  registration: z => ({
    id: z.id,
    ref: z.Name,
    eventId: z.Event?.id || null,
    eventName: z.Event?.name || '',
    name: z.Registrant_Name?.name || z.Registrant_Name1 || '',
    contactId: z.Registrant_Name?.id || null,
    business: z.Organization_Name?.name || z.Lead_Registrant_Organization || '',
    phone: z.Phone || '',
    email: z.Guest_Email || '',
    status: z.Registration_Status || '',
    attended: z.Attended || '',
    bringingGuest: z.Bringing_Guest === 'Yes',
    guestName: [z.Guest_First_Name, z.Guest_Last_Name].filter(Boolean).join(' '),
    registeredOn: z.Registration_Date || null,
    registrantType: z.Registrant || '',
    city: z.Address_1_City || '',
    state: z.Address_1_State_Province || '',
  }),
};

/* ─────────── reusable COQL ───────────
 * Written against the verified schema. A where clause is REQUIRED — COQL
 * rejects a query without one (confirmed against the live org).
 */
const RING_FIELDS = `id, Name, Facilitator, Regional_Rep, Region_Lookup, of_Members,
  Target_Group_Size, Status, Active, Group_Type, Meeting_Frequency, Meeting_Format,
  Meeting_Date_Time, Next_Meeting_Date_Time, Last_Rep_Visit, Next_Rep_Visit, GR_Group_Id`;

const MEMBER_FIELDS = `id, Full_Name, Member_Id, Email, Phone, Account_Name,
  Mailing_State, Is_Facilitator, Status, Active, Paid_Membership_StartDate, Days_without_Group`;

const esc = v => String(v == null ? '' : v).replace(/'/g, '');

const queries = {
  /** Every active ring, or just one rep's. repId is a CONTACT id. */
  ringsForRep: repId =>
    `select ${RING_FIELDS} from ${M.RING} where Active = true` +
    (repId ? ` and Regional_Rep = '${esc(repId)}'` : '') +
    ` limit 200`,

  /**
   * Membership links for the given rings.
   *
   * Members are NOT queryable by group from Contacts — Growth_Ring_Groups is a
   * multi-select lookup and COQL rejects it as a criterion (verified against
   * the live org). Group_Members is the real join table; go through it.
   *
   * Returns link rows: { Members: {id,name}, Growth_Ring_Groups: {id,name}, Role }
   */
  groupMembersFor: ringIds => {
    const ids = (ringIds || []).map(i => `'${esc(i)}'`).join(',');
    return `select id, Growth_Ring_Groups, Members, Role, Primary_Group, Join_Date
            from ${M.GROUP_MEMBER} where Growth_Ring_Groups in (${ids || "''"}) limit 200`;
  },

  /** Every membership link, used to work out who has no group at all. */
  allGroupMembers: (offset = 0) =>
    `select id, Growth_Ring_Groups, Members from ${M.GROUP_MEMBER}
     where id is not null limit ${offset}, 200`,

  /** Contacts by id, once the join table has told us which ones we want. */
  contactsByIds: ids => {
    const list = (ids || []).map(i => `'${esc(i)}'`).join(',');
    return `select ${MEMBER_FIELDS} from ${M.CONTACT}
            where id in (${list || "''"}) limit 200`;
  },

  /** All active members, paged. Diff against the join table for "no ring". */
  allActiveMembers: (offset = 0) =>
    `select ${MEMBER_FIELDS} from ${M.CONTACT}
     where Active = true limit ${offset}, 200`,

  /** Visits logged against a rep's rings. */
  visitsForRings: ringIds => {
    const ids = (ringIds || []).map(i => `'${esc(i)}'`).join(',');
    return `select id, Name, Visit_Date, Visit_Type, Visit_Notes, Growth_Ring_Group
            from ${M.ACTIVITY} where Growth_Ring_Group in (${ids || "''"})
            order by Visit_Date desc limit 200`;
  },

  /** Facilitators are Contacts flagged Is_Facilitator. */
  facilitators: () =>
    `select ${MEMBER_FIELDS} from ${M.CONTACT}
     where Active = true and Is_Facilitator = 'Yes' limit 200`,

  /** Events the office has marked visible to the portal. */
  portalEvents: () =>
    `select id, Name, Event_Type, Event_Date_and_Time, Event_Venue, Event_City, Event_State,
            Event_Format, Event_Status, Regional_Rep, Region, Registration_Count,
            Attendance_Count, Registration_Deadline, Meeting_Join_Link, Show_on_Portal
     from ${M.EVENT} where Show_on_Portal = true order by Event_Date_and_Time desc limit 200`,

  /** Registrations for one event — request #3, with contact details. */
  registrationsFor: eventId =>
    `select id, Name, Event, Registrant_Name, Registrant_Name1, Organization_Name,
            Lead_Registrant_Organization, Phone, Guest_Email, Registration_Status, Attended,
            Bringing_Guest, Guest_First_Name, Guest_Last_Name, Registration_Date, Registrant,
            Address_1_City, Address_1_State_Province
     from ${M.REGISTRATION} where Event = '${esc(eventId)}' limit 200`,

  /**
   * Every Regional Rep named on an active ring, so accounts can be created
   * from Zoho rather than typed by hand. Reps are Contacts, so the lookup
   * returns id and name directly on the ring.
   */
  repsOnRings: () =>
    `select id, Name, Regional_Rep, Region_Lookup from ${M.RING}
     where Active = true limit 200`,

  /** One contact by id — used to resolve a signed-in rep. */
  contactById: id =>
    `select ${MEMBER_FIELDS} from ${M.CONTACT} where id = '${esc(id)}' limit 1`,
};

module.exports = {
  FREQ_DAYS, MEETING_FREQ_DAYS, addDays, today, daysUntil,
  nextDueDate, ringHealth, toZoho, fromZoho, queries,
  RING_FIELDS, MEMBER_FIELDS, M,
};

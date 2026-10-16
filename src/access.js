'use strict';
/**
 * Who can do what.
 *
 * One OWNER (a director account, claimed once) can do everything and is the
 * only person who can change the rules below. Every other office account
 * gets the capabilities the owner switches on for its role. Reps get none.
 *
 * Until someone claims ownership, office accounts keep exactly the access
 * they had before this existed, so deploying it changes nothing on its own.
 */
const { q, setting } = require('./db');

/* Screens first (on by default, as before), then the sensitive areas. */
const screen = (label, detail) => ({ group: 'screens', label, detail, defaults: { admin: true, staff: true } });
const CAPS = {
  manager:      screen('Rep manager', 'How each rep is doing: who is behind, workloads, rings never visited.'),
  approvals:    screen('Approvals', 'Approve or send back new rings and the requests reps send in.'),
  calendar:     screen('Calendar', 'Events, ring visits and group meetings for every rep.'),
  members:      screen('Members', 'The member and facilitator lists.'),
  rings:        screen('Rings', 'Every Growth Ring and its health.'),
  visits:       screen('Visits', 'Ring visits booked and done.'),
  unaffiliated: screen('No ring yet', 'Members who are not in a Growth Ring.'),
  reports:      screen('Reports, coverage and retention', 'The reports, the coverage map and retention.'),
  team:         screen('Reps screen', 'Who covers what, and seeing a rep\'s own view.'),
  reminders:    screen('Reminders', 'The reminder emails reps get, and sending them now.'),
  accounting: { group: 'sensitive', label: 'Hours, expenses and accounting',
    detail: 'Approve hours and expenses, send them to accounting and give the final approval.',
    defaults: { admin: false, staff: false } },
  books: { group: 'sensitive', label: 'Zoho Books and accounting settings',
    detail: 'Connect Zoho Books, choose the expense accounts, the accounting email and the monthly send day.',
    defaults: { admin: false, staff: false } },
  users: { group: 'sensitive', label: 'Rep accounts',
    detail: 'Add and remove rep and office accounts and reset their passwords. Making someone a director is always owner-only.',
    defaults: { admin: true, staff: false } },
  settings: { group: 'sensitive', label: 'App settings',
    detail: 'Call cadence, reminders, announcements and forms.',
    defaults: { admin: true, staff: true } },
  system: { group: 'sensitive', label: 'System check and activity log',
    detail: 'Email and Zoho diagnostics and the record of who did what.',
    defaults: { admin: false, staff: false } },
};
const ROLES = ['admin', 'staff'];

// What office accounts could do before ownership existed (see the routes'
// old requireOffice / requireAdmin checks). Used until an owner is claimed.
const SCREENS = Object.keys(CAPS).filter(k => CAPS[k].group === 'screens');
const allScreens = Object.fromEntries(SCREENS.map(k => [k, true]));
const LEGACY = {
  admin: { ...allScreens, accounting: true, books: true, users: true, settings: true, system: true },
  staff: { ...allScreens, accounting: true, books: true, users: false, settings: true, system: false },
};

const TWO_STEP_DEFAULTS = { admin: true, staff: true, rep: false };

/* Read on every request, so remembered briefly: a burst of API calls from one
   screen should cost one settings query, not twenty. Cleared on any change. */
let cache = null;
const TTL = 10_000;
async function load() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  let perms = {}, twoStep = {};
  try { perms = JSON.parse(await setting('permissions', '{}')) || {}; } catch (_) { /* defaults */ }
  try { twoStep = JSON.parse(await setting('two_step', '{}')) || {}; } catch (_) { /* defaults */ }
  const ownerId = (await setting('owner_user_id', '')) || null;
  const merged = {};
  for (const role of ROLES) {
    merged[role] = {};
    for (const [cap, def] of Object.entries(CAPS)) {
      const v = perms[role] && perms[role][cap];
      merged[role][cap] = typeof v === 'boolean' ? v : def.defaults[role];
    }
  }
  const ts = {};
  for (const k of Object.keys(TWO_STEP_DEFAULTS)) ts[k] = typeof twoStep[k] === 'boolean' ? twoStep[k] : TWO_STEP_DEFAULTS[k];
  cache = { at: Date.now(), ownerId, perms: merged, twoStep: ts };
  return cache;
}
function clear() { cache = null; }

/** The capability map for one person. */
async function permsFor(user) {
  const all = Object.fromEntries(Object.keys(CAPS).map(c => [c, true]));
  const none = Object.fromEntries(Object.keys(CAPS).map(c => [c, false]));
  if (!user || user.role === 'rep') return none;
  const a = await load();
  if (a.ownerId && user.id === a.ownerId) return all;
  if (!a.ownerId) return { ...LEGACY[user.role] || none };
  return { ...(a.perms[user.role] || none) };
}

async function isOwner(user) {
  const a = await load();
  return !!(user && a.ownerId && user.id === a.ownerId);
}
async function ownerId() { return (await load()).ownerId; }

/** Does signing in need the emailed code as well as the password? */
async function needsTwoStep(user) {
  const a = await load();
  if (!a.ownerId) return false;                    // switched on when someone claims ownership
  if (user.id === a.ownerId) return true;          // the owner, always
  return !!a.twoStep[user.role];
}

/** Express middleware: the signed-in person must have this capability. */
function requirePerm(cap) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!req.user.perms || !req.user.perms[cap]) {
      return res.status(403).json({ error: `Your account does not have access to ${CAPS[cap].label.toLowerCase()}. Ask the owner.`, missing: cap });
    }
    next();
  };
}
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!req.user.owner) return res.status(403).json({ error: 'Only the owner can do that' });
  next();
}

async function savePermissions(perms) {
  const clean = {};
  for (const role of ROLES) {
    clean[role] = {};
    for (const cap of Object.keys(CAPS)) clean[role][cap] = !!(perms && perms[role] && perms[role][cap]);
  }
  await q.setSetting('permissions', JSON.stringify(clean));
  clear();
  return clean;
}
async function saveTwoStep(ts) {
  const clean = {};
  for (const k of Object.keys(TWO_STEP_DEFAULTS)) clean[k] = !!(ts && ts[k]);
  await q.setSetting('two_step', JSON.stringify(clean));
  clear();
  return clean;
}
async function setOwner(userId) {
  await q.setSetting('owner_user_id', userId);
  clear();
}

module.exports = { CAPS, ROLES, load, clear, permsFor, isOwner, ownerId, needsTwoStep, requirePerm, requireOwner,
  savePermissions, saveTwoStep, setOwner };

'use strict';
const express = require('express');
const crypto = require('crypto');
const zoho = require('./lib/zoho');
const cfg = require('./config');
const { q, audit, setting } = require('./db');
const auth = require('./auth');
const { enqueue, flushQueue } = require('./sync');
const reminders = require('./reminders');
const {
  nextDueDate, ringHealth, toZoho, fromZoho, daysUntil, today, addDays, queries, M,
} = require('./domain');

/** Blocks every write while READ_ONLY is on, so the app can go live safely. */
function writesAllowed(req, res, next) {
  if (cfg.readOnly) {
    return res.status(423).json({
      error: 'The app is live in read-only mode. Logging is switched on once the Zoho fields are added.',
      readOnly: true,
    });
  }
  next();
}

/**
 * Resolve the signed-in person to their Zoho Contact id and their rings.
 * A rep IS a Contact; Growth_Ring_Groups.Regional_Rep points at it. Members
 * have no rep field, so a rep's members are the members of their rings.
 */
async function scopeRings(user, asContactId) {
  // The office can ask to see one rep's scope with ?as=<contact id>. A rep
  // can never do this — their own contact is always used.
  const isRep = user.role === 'rep';
  const repContactId = isRep
    ? (user.zoho_owner_id || null)
    : (asContactId ? String(asContactId).replace(/'/g, '') : null);
  if (isRep && !repContactId) return { rings: [], ringIds: [], repContactId: null };
  const rows = await zoho.coql(queries.ringsForRep(repContactId));
  const rings = rows.map(fromZoho.ring);
  return { rings, ringIds: rings.map(r => r.id), repContactId };
}

const r = express.Router();
/** Split a list so no single COQL IN clause gets too long for Zoho. */
function chunk(arr, size){
  const out = [];
  for (let i = 0; i < (arr||[]).length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ═══════════ FIRST-RUN SETUP ═══════════
 * Creating the very first account by running a script on a laptop is a poor
 * experience and easy to get wrong. Instead the app reports what is and isn't
 * configured, and lets the first admin account be created in the browser —
 * but ONLY while no users exist, so it can never be used to add an account later.
 */
r.get('/setup/status', wrap(async (req, res) => {
  const out = { dbReady: false, needsSetup: false, zohoReady: false, userCount: 0, readOnly: cfg.readOnly };
  try {
    const rows = await q.allUsers();
    out.dbReady = true;
    out.userCount = rows.length;
    out.needsSetup = rows.length === 0;
  } catch (e) {
    out.dbError = /DATABASE_URL is not set/i.test(e.message)
      ? 'DATABASE_URL is not set in Netlify'
      : e.message;
    return res.json(out);
  }
  try { await zoho.ping(); out.zohoReady = true; }
  catch (e) { out.zohoError = e.message; }
  res.json(out);
}));

r.post('/setup', wrap(async (req, res) => {
  const existing = await q.allUsers().catch(() => null);
  if (existing === null) return res.status(503).json({ error: 'No database connected yet' });
  if (existing.length > 0) {
    return res.status(409).json({ error: 'Setup has already been completed. Sign in instead.' });
  }
  const { email, name, password } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'Name, email and password are all required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const id = 'u_' + Date.now().toString(36);
  await q.insertUser({
    id, email: String(email).trim(), name: String(name).trim(), phone: null,
    role: 'admin', region: null, password_hash: auth.hash(password), zoho_owner_id: null,
  });
  await audit(id, 'setup.firstAdmin', { email }, req.ip);
  const user = await q.userByEmail(email);
  res.status(201).json({ token: auth.issue(user), user: auth.publicUser(user) });
}));

/** The email a new rep receives with their sign-in details. */
function welcomeEmail({ name, email, password }) {
  const url = cfg.appUrl;
  return `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 18px;">
    <h1 style="font-size:19px;color:#1E2A20;margin:0 0 6px;">Your Rep Hub login</h1>
    <p style="color:#5A6455;font-size:14px;line-height:1.6;margin:0 0 18px;">
      ${esc(name.split(' ')[0])}, the Symbiz rep portal is ready for you. It shows the
      Growth Rings you look after, who is due a call, and the forms you need.
    </p>
    <table style="width:100%;background:#fff;border-radius:8px;border-collapse:collapse;">
      <tr><td style="padding:11px 14px;color:#5A6455;font-size:13px;border-bottom:1px solid #E9ECDF;">Sign in at</td>
          <td style="padding:11px 14px;border-bottom:1px solid #E9ECDF;"><a href="${url}" style="color:#2E5132;font-weight:600;">${esc(url)}</a></td></tr>
      <tr><td style="padding:11px 14px;color:#5A6455;font-size:13px;border-bottom:1px solid #E9ECDF;">Email</td>
          <td style="padding:11px 14px;border-bottom:1px solid #E9ECDF;font-size:14px;">${esc(email)}</td></tr>
      <tr><td style="padding:11px 14px;color:#5A6455;font-size:13px;">Password</td>
          <td style="padding:11px 14px;font-family:ui-monospace,monospace;font-size:16px;font-weight:700;">${esc(password)}</td></tr>
    </table>
    <p style="color:#5A6455;font-size:13px;line-height:1.6;margin:16px 0 0;">
      Please change that password after you sign in. It works on a phone or tablet as well as a computer.
    </p>
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · 800-394-7970</p>
  </div></body></html>`;
}
function esc(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/** Resend a login to someone who lost theirs. */
function makePassword(){ return Math.random().toString(36).slice(2,10); }

/**
 * The email someone gets when they ask to sign in.
 * Deliberately short — on a phone this is read in two seconds and tapped.
 */
/**
 * Where this site actually lives.
 *
 * APP_URL is the right answer when it's set, but its default is a localhost
 * address meant for development — and a sign-in link pointing at localhost is
 * useless in someone's inbox. Fall back to the host the request arrived on,
 * which on Netlify is always correct.
 */
function siteUrl(req) {
  const configured = (cfg.appUrl || '').replace(/\/$/, '');
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host && !/localhost|127\.0\.0\.1/.test(host)) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${host}`;
  }
  return configured || 'http://localhost:3000';
}

function signInEmail({ name, url, minutes }) {
  return `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:26px 18px;">
    <h1 style="font-size:18px;color:#1E2A20;margin:0 0 8px;">Sign in to Rep Hub</h1>
    <p style="color:#5A6455;font-size:14px;line-height:1.6;margin:0 0 20px;">
      ${esc((name||'').split(' ')[0] || 'Hello')}, tap the button to sign in. No password needed.</p>
    <a href="${url}" style="display:inline-block;background:#2E5132;color:#fff;text-decoration:none;
       padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;">Sign me in</a>
    <p style="color:#8A9284;font-size:12.5px;line-height:1.6;margin:20px 0 0;">
      This link works once and expires in ${minutes} minutes.
      If you didn't ask to sign in, you can ignore this — nobody can get in without the link.</p>
    <p style="color:#8A9284;font-size:11.5px;margin-top:18px;word-break:break-all;">
      Button not working? Paste this into your browser:<br>${esc(url)}</p>
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · 800-394-7970</p>
  </div></body></html>`;
}

/* ═══════════ AUTH ═══════════ */
/**
 * Ask for a sign-in link.
 *
 * Works for any email provider, which matters here: only one of the eleven
 * reps uses Gmail — the rest are on Yahoo, iCloud and their own business
 * domains, so a Google-only sign-in would lock out ten of them.
 *
 * Always answers the same way whether or not the address exists, so this
 * cannot be used to find out who has an account.
 */
r.post('/auth/request-link', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const same = { ok: true, message: 'If that address has an account, a sign-in link is on its way.' };
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'That does not look like an email address' });

  const user = await q.userByEmail(email);
  if (!user || user.active === false) return res.json(same);

  const recent = await q.recentTokenCount(user.id);
  if ((recent?.c || 0) >= 5) {
    return res.json({ ...same, message: 'A link was sent recently — check your inbox, including spam.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const minutes = 20;
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  await q.addLoginToken(token, user.id, expires, req.ip);
  await q.purgeOldTokens().catch(() => {});

  const url = `${siteUrl(req)}/?token=${token}`;
  const sent = await reminders.sendEmail(user.email, 'Your Rep Hub sign-in link',
    signInEmail({ name: user.name, url, minutes }), { userId: user.id, kind: 'signin' });

  if (sent && sent.ok === false) {
    return res.status(503).json({
      error: 'Email is not switched on for this site yet, so no link could be sent. Sign in with your password instead.',
    });
  }
  await audit(user.id, 'auth.linkRequested', { email }, req.ip);
  res.json(same);
}));

/**
 * Choose or reset a password.
 *
 * Used two ways: the invitation a new rep gets, and "I've forgotten mine".
 * Both send a link to the address on file, so only the person who owns that
 * inbox can set the password — nobody can set someone else's by knowing
 * their email.
 */
async function sendPasswordLink(user, req, { invite } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const hours = invite ? 72 : 2;
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  await q.addLoginToken(token, user.id, expires, req.ip, 'setpassword');
  const url = `${siteUrl(req)}/?setup=${token}`;
  return reminders.sendEmail(user.email,
    invite ? 'Set up your Rep Hub password' : 'Reset your Rep Hub password',
    passwordLinkEmail({ name: user.name, url, invite, hours }),
    { userId: user.id, kind: invite ? 'invite' : 'reset' });
}

function passwordLinkEmail({ name, url, invite, hours }) {
  return `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:26px 18px;">
    <h1 style="font-size:18px;color:#1E2A20;margin:0 0 8px;">
      ${invite ? 'Welcome to Rep Hub' : 'Reset your password'}</h1>
    <p style="color:#5A6455;font-size:14px;line-height:1.6;margin:0 0 20px;">
      ${esc((name||'').split(' ')[0] || 'Hello')}, ${invite
        ? 'your account is ready. Choose a password and you are in.'
        : 'tap below to choose a new password.'}</p>
    <a href="${url}" style="display:inline-block;background:#2E5132;color:#fff;text-decoration:none;
       padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;">
      ${invite ? 'Choose my password' : 'Set a new password'}</a>
    <p style="color:#8A9284;font-size:12.5px;line-height:1.6;margin:20px 0 0;">
      This link works once and expires in ${hours} hour${hours===1?'':'s'}.
      ${invite ? '' : "If you didn't ask for this, ignore it — your password has not changed."}</p>
    <p style="color:#8A9284;font-size:11.5px;margin-top:18px;word-break:break-all;">${esc(url)}</p>
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · 800-394-7970</p>
  </div></body></html>`;
}

/** "I've forgotten my password." Same answer whether or not the account exists. */
r.post('/auth/forgot', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const same = { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'That does not look like an email address' });

  const user = await q.userByEmail(email);
  if (!user || user.active === false) return res.json(same);

  const recent = await q.recentTokenCount(user.id);
  if ((recent?.c || 0) >= 5) return res.json(same);

  const sent = await sendPasswordLink(user, req);
  if (sent && sent.ok === false) {
    return res.status(503).json({ error: 'Email is not switched on for this site, so no link could be sent. Ask the office to reset it for you.' });
  }
  await audit(user.id, 'auth.forgotRequested', {}, req.ip);
  res.json(same);
}));

/** Check a setup link before showing the form, so a dead link fails early. */
r.post('/auth/check-setup', wrap(async (req, res) => {
  const row = await q.findLoginToken(String(req.body?.token || ''));
  if (!row || row.purpose !== 'setpassword') return res.status(401).json({ error: 'That link is not valid. Ask for a new one.' });
  if (row.used_at) return res.status(401).json({ error: 'That link has already been used. Ask for a new one.' });
  if (new Date(row.expires_at) < new Date()) return res.status(401).json({ error: 'That link has expired. Ask for a new one.' });
  const user = await q.userById(row.user_id);
  if (!user || user.active === false) return res.status(401).json({ error: 'That account is no longer active' });
  res.json({ ok: true, name: user.name, email: user.email });
}));

/** Set the password and sign them straight in. */
r.post('/auth/set-password', wrap(async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });

  const row = await q.findLoginToken(token);
  if (!row || row.purpose !== 'setpassword') return res.status(401).json({ error: 'That link is not valid' });
  if (row.used_at) return res.status(401).json({ error: 'That link has already been used' });
  if (new Date(row.expires_at) < new Date()) return res.status(401).json({ error: 'That link has expired' });

  const user = await q.userById(row.user_id);
  if (!user || user.active === false) return res.status(401).json({ error: 'That account is no longer active' });

  await q.setPassword(auth.hash(password), user.id);
  await q.useLoginToken(token);
  await audit(user.id, 'auth.passwordSet', {}, req.ip);
  res.json({ token: auth.issue(user), user: auth.publicUser(user) });
}));

/** Exchange a link for a session. Single use, time limited. */
r.post('/auth/verify-link', wrap(async (req, res) => {
  const token = String(req.body?.token || '');
  if (!token) return res.status(400).json({ error: 'No link token' });

  const row = await q.findLoginToken(token);
  if (!row) return res.status(401).json({ error: 'That link is not valid. Ask for a new one.' });
  if (row.used_at) return res.status(401).json({ error: 'That link has already been used. Ask for a new one.' });
  if (new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: 'That link has expired. Ask for a new one.' });
  }

  const user = await q.userById(row.user_id);
  if (!user || user.active === false) return res.status(401).json({ error: 'That account is no longer active' });

  await q.useLoginToken(token);       // burn it before issuing the session
  await audit(user.id, 'auth.linkUsed', {}, req.ip);
  res.json({ token: auth.issue(user), user: auth.publicUser(user) });
}));

r.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const out = await auth.login(email, password, req.ip);
  if (!out) return res.status(401).json({ error: 'Email or password is incorrect' });
  res.json(out);
}));

r.get('/auth/me', auth.authRequired, wrap(async (req, res) => {
  const pending = (await q.pendingFor(req.user.id))?.c || 0;
  res.json({ user: req.user, pendingSync: pending });
}));

r.post('/auth/password', auth.authRequired, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const u = await q.userById(req.user.id);
  if (!auth.verify(current || '', u.password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await q.setPassword(auth.hash(next), u.id);
  await audit(u.id, 'password.changed', null, req.ip);
  res.json({ ok: true });
}));

/* ═══════════ RINGS ═══════════ */
r.get('/rings', auth.authRequired, wrap(async (req, res) => {
  const { rings } = await scopeRings(req.user, req.query.as);
  res.json(rings.map(r => ({
    ...r,
    health: ringHealth({
      meetings: [],
      lastRepVisit: r.lastRepVisit,
      memberCount: r.memberCount,
      targetSize: r.capacity,
      meetingFrequency: r.meetingFrequency,
      status: r.status,
    }),
  })));
}));

r.post('/rings', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  // A rep-created ring always starts pending; the client cannot set it active.
  const record = toZoho.ring({
    ...b,
    repId: req.user.role === 'rep' ? req.user.id : (b.repId || req.user.id),
    status: 'pending',
    launchSteps: [],
  });
  const out = await zoho.insertRecords(M.RING, [record]);
  const id = out[0]?.details?.id;
  await audit(req.user.id, 'ring.created', { id, name: b.name }, req.ip);
  // notify the office
  for (const u of await q.allOffice()) {
    reminders.sendEmail(u.email, `New Growth Ring awaiting approval: ${b.name}`,
      `<p>${req.user.name} submitted <strong>${b.name}</strong> for approval.</p>
       <p><a href="${cfg.appUrl}/approvals">Review it</a></p>`, { userId: u.id, kind: 'approval' });
  }
  res.status(201).json({ id, status: 'pending' });
}));

/**
 * Set meeting details on many rings at once.
 *
 * All 81 rings have no meeting rhythm, format or target size. Editing them
 * one at a time in Zoho is an afternoon's work; this is the same job in a
 * single screen, and it is what makes ring health mean anything.
 */
r.patch('/rings/bulk', auth.authRequired, auth.requireOffice, writesAllowed, wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const fields = req.body?.fields || {};
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one ring' });
  if (ids.length > 200) return res.status(413).json({ error: 'Too many rings in one go' });

  // Only these may be set in bulk. Never the rep, facilitator or status —
  // those are per-ring decisions and too easy to wreck en masse.
  const allowed = ['meetingFrequency', 'meetingFormat', 'capacity', 'meetingRhythm'];
  const patch = {};
  allowed.forEach(k => { if (fields[k] !== undefined && fields[k] !== '') patch[k] = fields[k]; });
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

  const records = ids.map(id => {
    const z = { id };
    if (patch.meetingFrequency) z.Meeting_Frequency = patch.meetingFrequency;
    if (patch.meetingFormat) z.Meeting_Format = patch.meetingFormat;
    if (patch.capacity) z.Target_Group_Size = parseInt(patch.capacity, 10) || undefined;
    return z;
  });

  const out = await zoho.updateRecords(M.RING, records);
  const ok = out.filter(o => o.code === 'SUCCESS' || o.status === 'success').length;
  await audit(req.user.id, 'rings.bulkUpdated', { count: ok, fields: Object.keys(patch) }, req.ip);
  res.json({ updated: ok, failed: records.length - ok });
}));

r.patch('/rings/:id', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const b = req.body || {};
  const existing = await zoho.getRecord(M.RING, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const current = fromZoho.ring(existing);

  // Reps may edit only their own ring, and may never set status themselves
  if (req.user.role === 'rep') {
    if (current.repId !== req.user.id) return res.status(403).json({ error: 'Not your ring' });
    if (b.status && b.status !== 'pending') return res.status(403).json({ error: 'Only the office can approve a ring' });
    b.status = 'pending';
    b.rejectionReason = '';
  }
  const merged = { ...current, ...b };
  await zoho.updateRecords(M.RING, [{ id: req.params.id, ...toZoho.ring(merged) }]);
  await audit(req.user.id, 'ring.updated', { id: req.params.id, status: merged.status }, req.ip);

  // tell the rep when the office decides
  if (req.user.role !== 'rep' && b.status && b.status !== current.status) {
    const rep = await q.userById(current.repId);
    if (rep) {
      const approved = b.status === 'active';
      reminders.sendEmail(rep.email,
        approved ? `${merged.name} is approved` : `${merged.name} needs changes`,
        approved
          ? `<p>Your Growth Ring <strong>${merged.name}</strong> is now active. You can start placing members.</p><p><a href="${cfg.appUrl}">Open Rep Hub</a></p>`
          : `<p><strong>${merged.name}</strong> was sent back.</p><blockquote>${merged.rejectionReason || ''}</blockquote><p><a href="${cfg.appUrl}">Edit and resubmit</a></p>`,
        { userId: rep.id, kind: 'ring.decision' });
    }
  }
  res.json({ ok: true });
}));

/* ═══════════ ACTIVITIES ═══════════ */
r.get('/activities', auth.authRequired, wrap(async (req, res) => {
  const { ringIds } = await scopeRings(req.user, req.query.as);
  if (!ringIds.length) return res.json([]);
  const batches = await Promise.all(
    chunk(ringIds, 20).map(batch => zoho.coql(queries.visitsForRings(batch)).catch(() => []))
  );
  res.json(batches.flat().map(fromZoho.activity));
}));

/**
 * Log a call. This is the most-used write in the whole system.
 * next_due is computed SERVER side — never trusted from the client, so the
 * cadence rule can't drift between web, mobile and office entry.
 */
r.post('/activities', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.type || !b.date) return res.status(400).json({ error: 'type and date are required' });
  if (!b.ringId) return res.status(400).json({ error: 'A Growth Ring is required' });

  const z = await zoho.getRecord(M.RING, b.ringId);
  const ringRec = z ? fromZoho.ring(z) : null;
  if (!ringRec) return res.status(400).json({ error: 'Unknown Growth Ring' });

  // A rep may only log against their own ring. Their identity is a CONTACT id,
  // matched to Growth_Ring_Groups.Regional_Rep — not a Zoho user.
  const myContactId = req.user.zoho_owner_id || null;
  if (req.user.role === 'rep') {
    if (!myContactId) return res.status(403).json({ error: 'Your login is not linked to a Zoho contact yet' });
    if (ringRec.repZohoId !== myContactId) return res.status(403).json({ error: 'Not your ring' });
  }
  const repZohoId = req.user.role === 'rep' ? myContactId : (b.repZohoId || ringRec.repZohoId);

  /**
   * Call cadence is NOT stored per ring in their Zoho — Meeting_Frequency is the
   * group's own meeting rhythm, a different thing. So cadence comes from the
   * org defaults: quarterly facilitator calls, annual member calls, as Jeremy
   * described them. Override per ring later if Symbiz wants that.
   */
  const nextDue = nextDueDate({
    type: b.type,
    outcome: b.outcome || 'Connected',
    date: b.date,
    facFreq: await setting('defaultFacFreq', 'Quarterly'),
    memFreq: await setting('defaultMemFreq', 'Annual'),
    settings: {
      retryDays: parseInt(await setting('retryDays', '4'), 10),
      rescheduleDays: parseInt(await setting('rescheduleDays', '7'), 10),
    },
  });

  // Retire any open due-item of the same type for the same person, so the
  // list doesn't show the same call twice.
  try {
    const whoClause = b.memberId ? ` and Member = '${String(b.memberId).replace(/'/g, '')}'` : '';
    const open = await zoho.coql(
      `select id from ${M.ACTIVITY}
       where Growth_Ring_Group = '${String(b.ringId).replace(/'/g, '')}'
         and Visit_Type = '${String(b.type).replace(/'/g, '')}'
         and Next_Due_Date is not null${whoClause} limit 20`
    );
    if (open.length) {
      await zoho.updateRecords(M.ACTIVITY, open.map(o => ({ id: o.id, Next_Due_Date: null })));
    }
  } catch (e) {
    // Fails harmlessly until Next_Due_Date exists on the module
    console.warn('[activities] could not clear prior due item:', e.message);
  }

  const out = await zoho.insertRecords(M.ACTIVITY, [toZoho.activity({
    ...b, repZohoId, nextDue,
  })]);
  const id = out[0]?.details?.id;

  await audit(req.user.id, 'activity.logged', { id, type: b.type, ringId: b.ringId, repZohoId }, req.ip);
  res.status(201).json({ id, nextDue });
}));

/* ═══════════ MEMBERS ═══════════ */
r.get('/members', auth.authRequired, wrap(async (req, res) => {
  const { ringIds } = await scopeRings(req.user, req.query.as);
  if (!ringIds.length) return res.json([]);

  // Membership lives in the Group_Members join table, not on the Contact.
  // The office may cover 80+ rings; one IN clause that long is rejected by
  // Zoho, so ask in batches and merge.
  // Run the batches together rather than one after another. With 80+ rings
  // the sequential version took long enough that sign-in felt broken.
  const linkBatches = await Promise.all(
    chunk(ringIds, 20).map(batch => zoho.coql(queries.groupMembersFor(batch)).catch(() => []))
  );
  const links = linkBatches.flat();
  const byContact = new Map();
  links.forEach(l => {
    const cid = l.Members?.id;
    if (!cid) return;
    if (!byContact.has(cid)) byContact.set(cid, { ringIds: [], ringNames: [], roles: [] });
    const e = byContact.get(cid);
    if (l.Growth_Ring_Groups?.id) { e.ringIds.push(l.Growth_Ring_Groups.id); e.ringNames.push(l.Growth_Ring_Groups.name); }
    if (l.Role) e.roles.push(l.Role);
  });
  if (!byContact.size) return res.json([]);

  const contactBatches = await Promise.all(
    chunk([...byContact.keys()], 50).map(batch => zoho.coql(queries.contactsByIds(batch)).catch(() => []))
  );
  const contacts = contactBatches.flat();
  res.json(contacts.map(c => {
    const m = fromZoho.member(c);
    const link = byContact.get(c.id) || {};
    return { ...m, ringIds: link.ringIds || [], ringNames: link.ringNames || [], roles: link.roles || [] };
  }));
}));

/**
 * Members with no Growth Ring at all — Keturah's request #1.
 * Worked out by diffing active members against the join table, because
 * Contacts cannot be filtered on the group lookup.
 */
r.get('/members/no-ring', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  // Page the join table and the member list in parallel — these are the two
  // slowest calls in the app and they do not depend on each other.
  const offsets = [0, 200, 400, 600, 800, 1000];
  const [linkPages, memberPages] = await Promise.all([
    Promise.all(offsets.map(o => zoho.coql(queries.allGroupMembers(o)).catch(() => []))),
    Promise.all(offsets.map(o => zoho.coql(queries.allActiveMembers(o)).catch(() => []))),
  ]);
  const inAGroup = new Set();
  linkPages.flat().forEach(l => { if (l.Members?.id) inAGroup.add(l.Members.id); });

  // A rep should see the unaffiliated members in THEIR patch, not the whole
  // network. Their patch is the set of states their own rings cover.
  let repStates = null;
  if (req.user.role === 'rep') {
    const { rings } = await scopeRings(req.user, req.query.as);
    const regionNames = new Set(rings.map(r => r.regionName).filter(Boolean));
    const memberStates = new Set();
    if (rings.length) {
      const links = await zoho.coql(queries.groupMembersFor(rings.map(r => r.id)));
      const ids = [...new Set(links.map(l => l.Members?.id).filter(Boolean))];
      if (ids.length) {
        const mine = await zoho.coql(queries.contactsByIds(ids));
        mine.forEach(c => { if (c.Mailing_State) memberStates.add(c.Mailing_State); });
      }
    }
    repStates = { regionNames, memberStates };
  }

  const out = [];
  memberPages.flat().forEach(c => {
    if (inAGroup.has(c.id)) return;
    if (repStates && repStates.memberStates.size && !repStates.memberStates.has(c.Mailing_State)) return;
    if (out.some(m => m.id === c.id)) return;
    out.push(fromZoho.member(c));
  });
  res.json(out);
}));

/** Events the office has flagged Show_on_Portal — requests #2 and #4. */
r.get('/events', auth.authRequired, wrap(async (req, res) => {
  const rows = await zoho.coql(queries.portalEvents());
  res.json(rows.map(fromZoho.event));
}));

/** Registrations for one event, with contact details — request #3. */
r.get('/events/:id/registrations', auth.authRequired, wrap(async (req, res) => {
  const rows = await zoho.coql(queries.registrationsFor(req.params.id));
  res.json(rows.map(fromZoho.registration));
}));

/**
 * Growth Ring visit schedule — Keturah's request #4.
 * Combines the Last/Next Rep Visit dates held on each ring with the visits
 * already logged in Rep_Visit_Trackings.
 */
r.get('/visits', auth.authRequired, wrap(async (req, res) => {
  const { rings, ringIds } = await scopeRings(req.user, req.query.as);
  const out = [];

  rings.forEach(r => {
    if (r.nextRepVisit) out.push({
      id: `next_${r.id}`, ringId: r.id, ringName: r.name, repZohoId: r.repZohoId,
      date: r.nextRepVisit, status: 'Scheduled', source: 'ring',
      location: r.regionName || '', notes: '',
    });
    if (r.lastRepVisit) out.push({
      id: `last_${r.id}`, ringId: r.id, ringName: r.name, repZohoId: r.repZohoId,
      date: r.lastRepVisit, status: 'Completed', source: 'ring',
      location: r.regionName || '', notes: '',
    });
  });

  if (ringIds.length) {
    const loggedBatches = await Promise.all(
      chunk(ringIds, 20).map(batch => zoho.coql(queries.visitsForRings(batch)).catch(() => []))
    );
    const logged = loggedBatches.flat();
    logged.map(fromZoho.activity).forEach(a => {
      if (!/visit/i.test(a.type || '')) return;    // calls are not visits
      out.push({
        id: a.id, ringId: a.ringId, ringName: a.ringName, repZohoId: a.repZohoId,
        date: a.date, status: 'Completed', source: 'logged',
        location: '', notes: a.notes || '',
      });
    });
  }

  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  res.json(out);
}));

/**
 * Group meetings. Reps record these after a ring meets; they go into
 * Growth_Ring_Meetings_N and come back on the calendar.
 */
r.get('/meetings', auth.authRequired, wrap(async (req, res) => {
  const { ringIds } = await scopeRings(req.user, req.query.as);
  if (!ringIds.length) return res.json([]);
  const batches = await Promise.all(
    chunk(ringIds, 20).map(b => zoho.coql(
      `select id, Growth_Ring_Group, Meeting_Date, Notes from ${M.MEETING}
       where Growth_Ring_Group in (${b.map(i => `'${String(i).replace(/'/g,'')}'`).join(',')})
       order by Meeting_Date desc limit 200`
    ).catch(() => []))
  );
  res.json(batches.flat().map(z => ({
    id: z.id,
    ringId: z.Growth_Ring_Group?.id || null,
    ringName: z.Growth_Ring_Group?.name || '',
    date: z.Meeting_Date,
    notes: z.Notes || '',
  })));
}));

r.post('/meetings', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.ringId || !b.date) return res.status(400).json({ error: 'A ring and a date are required' });

  if (req.user.role === 'rep') {
    const { ringIds } = await scopeRings(req.user);
    if (!ringIds.includes(b.ringId)) return res.status(403).json({ error: 'Not your ring' });
  }

  const attended = Array.isArray(b.attended) ? b.attended.length : (parseInt(b.attended, 10) || 0);
  const absent = Array.isArray(b.absent) ? b.absent.length : (parseInt(b.absent, 10) || 0);
  const note = [b.notes, attended || absent ? `${attended} attended, ${absent} absent` : '']
    .filter(Boolean).join(' — ');

  const out = await zoho.insertRecords(M.MEETING, [{
    Growth_Ring_Group: { id: b.ringId },
    Meeting_Date: b.date,
    Notes: note,
  }]);
  const id = out[0]?.details?.id;
  await audit(req.user.id, 'meeting.recorded', { id, ringId: b.ringId }, req.ip);
  res.status(201).json({ id });
}));

/** Facilitators are Contacts flagged Is_Facilitator. */
r.get('/facilitators', auth.authRequired, wrap(async (req, res) => {
  const rows = await zoho.coql(queries.facilitators());
  res.json(rows.map(fromZoho.member));
}));

r.post('/members', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });

  // Duplicate guard — same name + phone already in the ring
  const dupe = await zoho.coql(
    `select id, Last_Name from ${M.CONTACT} where Phone = '${String(b.phone || '').replace(/'/g, '')}' limit 5`
  ).catch(() => []);
  if (dupe.length && !b.force) {
    return res.status(409).json({ error: 'Someone with that phone number already exists', existing: dupe.map(d => d.id) });
  }

  const out = await zoho.insertRecords(M.CONTACT, [toZoho.member({
    ...b,
    repId: req.user.role === 'rep' ? req.user.id : b.repId,
    joined: b.joined || today(),
    renews: b.renews || addDays(today(), 365),
    status: 'active',
  })]);
  await audit(req.user.id, 'member.created', { name: b.name }, req.ip);
  res.status(201).json({ id: out[0]?.details?.id });
}));

/* ═══════════ STARTING THE CALL CYCLE ═══════════
 * Their CRM has no call history, so without this every rep signs in to an
 * empty Today screen and never comes back. This creates the first round of
 * due dates — staggered, so nobody gets twenty calls on one Monday.
 */

/** What starting the cycle would create, without creating it. */
r.get('/cycle/preview', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const rings = (await zoho.coql(queries.ringsForRep(null))).map(fromZoho.ring);
  const existing = await zoho.coql(
    `select id, Growth_Ring_Group, Visit_Type from ${M.ACTIVITY} where Visit_Date is not null limit 200`
  ).catch(() => []);
  const alreadyScheduled = new Set(
    existing.map(e => e.Growth_Ring_Group?.id).filter(Boolean)
  );

  const byRep = {};
  rings.forEach(r => {
    if (!r.repZohoId) return;
    const k = r.repName || r.repZohoId;
    byRep[k] = byRep[k] || { rep: k, rings: 0, alreadyHas: 0 };
    byRep[k].rings++;
    if (alreadyScheduled.has(r.id)) byRep[k].alreadyHas++;
  });

  const toCreate = rings.filter(r => r.repZohoId && !alreadyScheduled.has(r.id));
  res.json({
    totalRings: rings.length,
    willCreate: toCreate.length,
    alreadyScheduled: alreadyScheduled.size,
    byRep: Object.values(byRep).sort((a, b) => b.rings - a.rings),
    spreadWeeks: Math.max(1, Math.ceil(toCreate.length / Math.max(1, Object.keys(byRep).length) / 2)),
  });
}));

/**
 * Create the first facilitator call for every active ring.
 *
 * Staggering matters: a rep with 22 rings should not open the app to 22 calls
 * all due today. Each rep's rings are spread two per week from next Monday.
 */
r.post('/cycle/start', auth.authRequired, auth.requireOffice, writesAllowed, wrap(async (req, res) => {
  const perWeek = Math.min(10, Math.max(1, parseInt(req.body?.perWeek, 10) || 2));
  const rings = (await zoho.coql(queries.ringsForRep(null))).map(fromZoho.ring);

  const existing = await zoho.coql(
    `select id, Growth_Ring_Group from ${M.ACTIVITY} where Next_Due_Date is not null limit 200`
  ).catch(() => []);
  const already = new Set(existing.map(e => e.Growth_Ring_Group?.id).filter(Boolean));

  // Group by rep so each rep's own list is spread, not the global list
  const byRep = {};
  rings.forEach(r => {
    if (!r.repZohoId || already.has(r.id)) return;
    (byRep[r.repZohoId] = byRep[r.repZohoId] || []).push(r);
  });

  // Start next Monday — a call "due today" on the day you first sign in
  // feels like a backlog rather than a plan.
  const start = new Date();
  start.setDate(start.getDate() + ((8 - start.getDay()) % 7 || 7));
  const startIso = start.toISOString().slice(0, 10);

  const records = [];
  Object.entries(byRep).forEach(([repId, list]) => {
    list.forEach((ring, i) => {
      const week = Math.floor(i / perWeek);
      records.push(toZoho.activity({
        ringId: ring.id,
        repZohoId: repId,
        type: 'Facilitator Call',
        date: startIso,
        nextDue: addDays(startIso, week * 7),
        outcome: undefined,
        notes: 'First call of the cycle, scheduled when the portal went live.',
      }));
    });
  });

  if (!records.length) {
    return res.json({ created: 0, message: 'Every ring already has a call scheduled.' });
  }

  const out = await zoho.insertRecords(M.ACTIVITY, records);
  const created = out.filter(o => o.code === 'SUCCESS' || o.status === 'success').length;
  await audit(req.user.id, 'cycle.started', { created, perWeek }, req.ip);
  res.json({ created, failed: records.length - created, from: startIso, perWeek });
}));

/* ═══════════ THINGS REPS ASK TO PUT INTO ZOHO ═══════════
 * Reps can register someone for an event, cancel a registration, or add a
 * lead. None of it reaches the CRM directly: it waits here until the office
 * approves, which is what Keturah asked for so reps cannot corrupt the data.
 */

/** What this rep has submitted, or everything if the office is asking. */
r.get('/pending', auth.authRequired, wrap(async (req, res) => {
  const rows = req.user.role === 'rep'
    ? await q.writeRequestsFor(req.user.id)
    : await q.allWriteRequests();
  res.json(rows);
}));

/** A rep registers someone for an event. */
r.post('/pending/registration', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.eventId) return res.status(400).json({ error: 'Which event?' });
  if (!b.name && !b.contactId) return res.status(400).json({ error: 'A name is required' });

  const event = await zoho.getRecord(M.EVENT, b.eventId).catch(() => null);
  const eventName = event ? event.Name : 'an event';

  const out = await q.addWriteRequest({
    kind: 'registration',
    payload: b,
    repId: req.user.id,
    repName: req.user.name,
    repZohoId: req.user.zoho_owner_id,
    summary: `Register ${b.name || 'a member'} for ${eventName}` +
             (b.bringingGuest ? ' (bringing a guest)' : ''),
  });
  await audit(req.user.id, 'pending.registration', { eventId: b.eventId }, req.ip);
  res.status(201).json({ id: out[0]?.id, status: 'pending' });
}));

/** A rep asks for a registration to be cancelled. */
r.post('/pending/cancellation', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.registrationId) return res.status(400).json({ error: 'Which registration?' });
  const out = await q.addWriteRequest({
    kind: 'cancellation',
    payload: b,
    repId: req.user.id,
    repName: req.user.name,
    repZohoId: req.user.zoho_owner_id,
    summary: `Cancel ${b.name || 'a registration'}${b.eventName ? ' for ' + b.eventName : ''}` +
             (b.reason ? ` — ${b.reason}` : ''),
  });
  await audit(req.user.id, 'pending.cancellation', { registrationId: b.registrationId }, req.ip);
  res.status(201).json({ id: out[0]?.id, status: 'pending' });
}));

/** A rep adds a lead they have met. */
r.post('/pending/lead', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.lastName && !b.name) return res.status(400).json({ error: 'A name is required' });
  const out = await q.addWriteRequest({
    kind: 'lead',
    payload: b,
    repId: req.user.id,
    repName: req.user.name,
    repZohoId: req.user.zoho_owner_id,
    summary: `Add lead ${[b.firstName, b.lastName || b.name].filter(Boolean).join(' ')}` +
             (b.company ? ` of ${b.company}` : ''),
  });
  await audit(req.user.id, 'pending.lead', { name: b.lastName || b.name }, req.ip);
  res.status(201).json({ id: out[0]?.id, status: 'pending' });
}));

/**
 * The office approves, and only now does anything reach Zoho.
 * If the Zoho write fails the item stays pending with the reason, so nothing
 * is silently lost and the office can retry.
 */
r.post('/pending/:id/approve', auth.authRequired, auth.requireOffice, writesAllowed, wrap(async (req, res) => {
  const row = await q.oneWriteRequest(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'No such request' });
  if (row.status !== 'pending') return res.status(409).json({ error: `Already ${row.status}` });

  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  try {
    let zohoId = null;

    if (row.kind === 'registration') {
      const out = await zoho.insertRecords(M.REGISTRATION, [toZoho.registration(p)]);
      zohoId = out[0]?.details?.id;

    } else if (row.kind === 'cancellation') {
      await zoho.updateRecords(M.REGISTRATION, [{
        id: p.registrationId,
        Registration_Status: 'Canceled',   // their spelling, verified in the org
      }]);
      zohoId = p.registrationId;

    } else if (row.kind === 'lead') {
      const out = await zoho.insertRecords('Leads', [toZoho.lead(p)]);
      zohoId = out[0]?.details?.id;

    } else {
      return res.status(400).json({ error: `Unknown request type: ${row.kind}` });
    }

    await q.markWriteRequest(row.id, 'approved', req.user.id, { zohoId });
    await audit(req.user.id, 'pending.approved', { id: row.id, kind: row.kind, zohoId }, req.ip);
    res.json({ ok: true, zohoId });

  } catch (e) {
    // Left pending deliberately — an approved-but-unwritten record would be
    // worse than one still waiting.
    await q.markWriteRequest(row.id, 'pending', req.user.id, { error: e.message });
    res.status(502).json({ error: `Zoho refused that: ${e.message}. The request is still waiting.` });
  }
}));

/** The office sends it back, with a reason the rep can act on. */
r.post('/pending/:id/reject', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const row = await q.oneWriteRequest(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'No such request' });
  if (row.status !== 'pending') return res.status(409).json({ error: `Already ${row.status}` });
  const note = (req.body?.reason || '').trim();
  if (!note) return res.status(400).json({ error: 'Give the rep a reason' });
  await q.markWriteRequest(row.id, 'rejected', req.user.id, { note });
  await audit(req.user.id, 'pending.rejected', { id: row.id, kind: row.kind }, req.ip);
  res.json({ ok: true });
}));

/* ═══════════ HOURS AND EXPENSES ═══════════
 * Mel's request. Held in our own database — Symbiz's accounting is QuickBooks
 * and no Zoho module fits. Writes stay allowed in read-only mode because this
 * is our data, not their CRM.
 */
r.get('/time', auth.authRequired, wrap(async (req, res) => {
  const rows = req.user.role === 'rep' ? await q.timeFor(req.user.id) : await q.allTime();
  res.json(rows);
}));

r.post('/time', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const hours = parseFloat(b.hours);
  if (!b.date || !hours || hours <= 0) return res.status(400).json({ error: 'A date and hours are required' });
  if (hours > 24) return res.status(400).json({ error: 'That is more than a day' });
  const out = await q.addTime({
    userId: req.user.id, repName: req.user.name, date: b.date, hours,
    category: b.category || 'Admin', description: b.description || '', ringId: b.ringId,
  });
  await audit(req.user.id, 'time.logged', { hours, category: b.category }, req.ip);
  res.status(201).json({ id: out[0]?.id });
}));

r.post('/time/:id/approve', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  await q.approveTime(parseInt(req.params.id, 10), req.user.id);
  res.json({ ok: true });
}));

r.get('/expenses', auth.authRequired, wrap(async (req, res) => {
  const rows = req.user.role === 'rep' ? await q.expensesFor(req.user.id) : await q.allExpenses();
  res.json(rows);
}));

r.post('/expenses', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (!b.date || !amount || amount <= 0) return res.status(400).json({ error: 'A date and amount are required' });
  // A receipt is a data URI; cap it so one claim cannot fill the database
  if (b.receiptData && String(b.receiptData).length > 3_000_000) {
    return res.status(413).json({ error: 'That receipt is too large — retake the photo further back' });
  }
  const out = await q.addExpense({
    userId: req.user.id, repName: req.user.name, date: b.date, amount,
    category: b.category || 'Other', description: b.description || '', ringId: b.ringId,
    receiptName: b.receiptName, receiptType: b.receiptType, receiptData: b.receiptData,
  });
  await audit(req.user.id, 'expense.logged', { amount, category: b.category, receipt: !!b.receiptData }, req.ip);
  res.status(201).json({ id: out[0]?.id });
}));

/** The receipt itself, fetched only when someone opens it. */
r.get('/expenses/:id/receipt', auth.authRequired, wrap(async (req, res) => {
  const row = await q.receiptFor(parseInt(req.params.id, 10));
  if (!row || !row.receipt_data) return res.status(404).json({ error: 'No receipt on that expense' });
  res.json({ name: row.receipt_name, type: row.receipt_type, data: row.receipt_data });
}));

r.post('/expenses/:id/approve', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  await q.approveExpense(parseInt(req.params.id, 10), req.user.id);
  res.json({ ok: true });
}));

/** Everything approved, as one payload for accounting. */
r.get('/accounting/pending', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const [time, exp] = await Promise.all([q.allTime(), q.allExpenses()]);
  const approvedTime = time.filter(t => t.status === 'Approved');
  const approvedExp = exp.filter(x => x.status === 'Approved');
  res.json({
    hours: approvedTime.reduce((s, t) => s + Number(t.hours), 0),
    amount: approvedExp.reduce((s, x) => s + Number(x.amount), 0),
    missingReceipts: approvedExp.filter(x => !x.receipt_name).length,
    time: approvedTime, expenses: approvedExp,
  });
}));

r.post('/accounting/send', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const [time, exp] = await Promise.all([q.allTime(), q.allExpenses()]);
  const t = time.filter(x => x.status === 'Approved');
  const e = exp.filter(x => x.status === 'Approved');
  if (!t.length && !e.length) return res.status(400).json({ error: 'Nothing approved to send' });

  const to = await setting('accountingEmail', 'accounting@symbiz.org');
  if (!cfg.mail.enabled || !cfg.mail.host) {
    return res.status(503).json({
      error: 'Email is not configured for this site, so nothing was sent. Nothing has been marked as claimed.',
      fix: 'Set MAIL_ENABLED, SMTP_HOST, SMTP_USER and SMTP_PASS, then try again.',
    });
  }
  const rows = [['Type', 'Rep', 'Date', 'Category', 'Hours', 'Amount', 'Description', 'Receipt']];
  t.forEach(x => rows.push(['Hours', x.rep_name, x.entry_date, x.category, x.hours, '', x.description, '']));
  e.forEach(x => rows.push(['Expense', x.rep_name, x.entry_date, x.category, '', x.amount, x.description,
                            x.receipt_name || 'MISSING']));
  const csv = rows.map(r => r.map(c => {
    const v = String(c ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\n');

  // Name who approved what, and reply to them. Sending from their own mailbox
  // would mean holding their password, which nobody should give an app.
  const approverIds = [...new Set([...t, ...e].map(x => x.approved_by).filter(Boolean))];
  const approverUsers = (await q.allUsers()).filter(u => approverIds.includes(u.id));
  const byLine = approverUsers.length ? `Approved by ${approverUsers.map(u => u.name).join(', ')}.` : '';

  const sent = await reminders.sendEmail(to, `Rep hours and expenses — ${today()}`,
    `<p>${t.length} time entries and ${e.length} expenses approved for payment. ${esc(byLine)}</p>
     <p>Total: ${t.reduce((s, x) => s + Number(x.hours), 0)} hours, $${e.reduce((s, x) => s + Number(x.amount), 0).toFixed(2)}</p>
     <pre style="font:12px/1.5 monospace;background:#f5f5f0;padding:10px;border-radius:6px">${csv}</pre>`,
    { userId: req.user.id, kind: 'accounting',
      replyTo: approverUsers.length === 1 ? approverUsers[0].email : req.user.email });

  if (sent && sent.ok === false) {
    // Marking them claimed when the email failed would silently lose a month
    // of expenses — leave them approved so the office can retry.
    return res.status(502).json({ error: `The email could not be sent: ${sent.error}. Nothing was marked as claimed.` });
  }

  await q.markTimeSent();
  await q.markExpensesSent();
  await audit(req.user.id, 'accounting.sent', { time: t.length, expenses: e.length }, req.ip);
  res.json({ sent: true, to, time: t.length, expenses: e.length });
}));

/* ═══════════ SYNC (offline queue) ═══════════ */
r.post('/sync/push', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.json({ accepted: 0, duplicates: 0 });
  if (items.length > 500) return res.status(413).json({ error: 'Too many items in one push' });

  let accepted = 0, duplicates = 0;
  for (const it of items) {
    if (!it.clientUuid || !it.module || !it.op) continue;
    const out = await enqueue({
      userId: req.user.id,
      clientUuid: it.clientUuid,
      module: it.module,
      op: it.op,
      payload: it.payload || {},
    });
    out.duplicate ? duplicates++ : accepted++;
  }
  await audit(req.user.id, 'sync.push', { accepted, duplicates }, req.ip);

  // Serverless containers freeze the moment a response is sent, so background
  // work started with setImmediate silently never runs. Flush inline instead;
  // if it fails the scheduled sync-flush function picks it up within 15 minutes.
  let flushed = null;
  try { flushed = await flushQueue({ limit: 100 }); }
  catch (e) { console.error('[sync] inline flush failed, scheduled job will retry:', e.message); }
  res.json({ accepted, duplicates, flushed });
}));

r.get('/sync/status', auth.authRequired, wrap(async (req, res) => {
  res.json({ pending: (await q.pendingFor(req.user.id))?.c || 0 });
}));

r.post('/sync/flush', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  res.json(await flushQueue({ limit: 300 }));
}));

/* ═══════════ REPORTS ═══════════
 * Built against the verified live schema. Office only.
 */
const REPORTS = {
  'ring-roster': {
    name: 'Growth Ring roster',
    cols: ['Ring', 'Facilitator', 'Regional Rep', 'Region', 'Members', 'Target', 'Meets', 'Format', 'Last rep visit', 'Health'],
    build: async () => {
      const rows = await zoho.coql(queries.ringsForRep(null));
      return rows.map(fromZoho.ring).map(r => [
        r.name, r.facName || '', r.repName || '', r.regionName || '',
        r.memberCount, r.capacity || '', r.meetingFrequency || '', r.meetingFormat || '',
        r.lastRepVisit || 'never',
        ringHealth({ meetings: [], lastRepVisit: r.lastRepVisit, memberCount: r.memberCount,
                     targetSize: r.capacity, meetingFrequency: r.meetingFrequency, status: r.status }),
      ]);
    },
  },
  'rep-coverage': {
    name: 'Coverage by rep',
    cols: ['Regional Rep', 'Rings', 'Members', 'Rings with no meeting rhythm', 'Rings never visited'],
    build: async () => {
      const rows = (await zoho.coql(queries.ringsForRep(null))).map(fromZoho.ring);
      const byRep = {};
      rows.forEach(r => {
        const k = r.repName || '(unassigned)';
        byRep[k] = byRep[k] || { rings: 0, members: 0, noRhythm: 0, noVisit: 0 };
        byRep[k].rings++;
        byRep[k].members += r.memberCount || 0;
        if (!r.meetingFrequency) byRep[k].noRhythm++;
        if (!r.lastRepVisit) byRep[k].noVisit++;
      });
      return Object.entries(byRep)
        .sort((a, b) => b[1].rings - a[1].rings)
        .map(([rep, v]) => [rep, v.rings, v.members, v.noRhythm, v.noVisit]);
    },
  },
  'no-ring': {
    name: 'Members without a Growth Ring',
    cols: ['Member', 'Member no', 'Business', 'State', 'Phone', 'Email', 'Member since'],
    build: async () => {
      const inAGroup = new Set();
      for (let offset = 0; offset < 2000; offset += 200) {
        const batch = await zoho.coql(queries.allGroupMembers(offset));
        batch.forEach(l => { if (l.Members?.id) inAGroup.add(l.Members.id); });
        if (batch.length < 200) break;
      }
      const out = [];
      for (let offset = 0; offset < 2000; offset += 200) {
        const batch = await zoho.coql(queries.allActiveMembers(offset));
        batch.forEach(c => {
          if (inAGroup.has(c.id)) return;
          const m = fromZoho.member(c);
          out.push([m.name, m.memberNo || '', m.business, m.region, m.phone, m.email, m.joined || '']);
        });
        if (batch.length < 200) break;
      }
      return out;
    },
  },
  'member-directory': {
    name: 'Member directory',
    cols: ['Member', 'Member no', 'Business', 'State', 'Phone', 'Email', 'Facilitator', 'Member since'],
    build: async () => {
      const rows = await zoho.coql(
        `select ${require('./domain').MEMBER_FIELDS} from ${M.CONTACT} where Active = true limit 200`
      );
      return rows.map(fromZoho.member).map(m => [
        m.name, m.memberNo || '', m.business, m.region, m.phone, m.email,
        m.isFacilitator ? 'Yes' : 'No', m.joined || '',
      ]);
    },
  },
  'facilitators': {
    name: 'Facilitators',
    cols: ['Name', 'Member no', 'Business', 'State', 'Phone', 'Email'],
    build: async () => {
      const rows = await zoho.coql(queries.facilitators());
      return rows.map(fromZoho.member).map(f => [
        f.name, f.memberNo || '', f.business, f.region, f.phone, f.email,
      ]);
    },
  },
  'event-registrations': {
    name: 'Event registrations',
    cols: ['Event', 'Date', 'Registrant', 'Business', 'Phone', 'Status', 'Guest', 'Registered'],
    build: async () => {
      const events = (await zoho.coql(queries.portalEvents())).map(fromZoho.event);
      const upcoming = events.filter(e => e.date && e.date >= today()).slice(0, 12);
      const out = [];
      for (const e of upcoming) {
        const regs = await zoho.coql(queries.registrationsFor(e.id));
        regs.map(fromZoho.registration).forEach(x => out.push([
          e.title, e.date, x.name, x.business, x.phone,
          x.status, x.bringingGuest ? (x.guestName || 'Yes') : '', x.registeredOn || '',
        ]));
      }
      return out;
    },
  },
  'upcoming-events': {
    name: 'Upcoming events',
    cols: ['Event', 'Type', 'Date', 'Time', 'Venue', 'City', 'State', 'Registered', 'Deadline'],
    build: async () => {
      const events = (await zoho.coql(queries.portalEvents())).map(fromZoho.event);
      return events
        .filter(e => e.date && e.date >= today())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(e => [e.title, e.type, e.date, e.time, e.venue, e.city, e.state,
                   e.registrationCount || 0, e.registrationDeadline || '']);
    },
  },
  'missing-detail': {
    name: 'Rings missing meeting or visit detail',
    cols: ['Ring', 'Regional Rep', 'Meeting rhythm', 'Meeting format', 'Next meeting', 'Last rep visit'],
    build: async () => {
      const rows = (await zoho.coql(queries.ringsForRep(null))).map(fromZoho.ring);
      return rows
        .filter(r => !r.meetingFrequency || !r.meetingFormat || !r.nextMeeting || !r.lastRepVisit)
        .map(r => [
          r.name, r.repName || '',
          r.meetingFrequency || 'MISSING', r.meetingFormat || 'MISSING',
          r.nextMeeting || 'MISSING', r.lastRepVisit || 'MISSING',
        ]);
    },
  },
};

r.get('/reports', auth.authRequired, auth.requireOffice, (req, res) => {
  res.json(Object.entries(REPORTS).map(([k, v]) => ({ key: k, name: v.name, cols: v.cols })));
});

r.get('/reports/:key', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const rep = REPORTS[req.params.key];
  if (!rep) return res.status(404).json({ error: 'Unknown report' });
  const rows = await rep.build();

  if (req.query.format === 'csv') {
    const csv = [rep.cols, ...rows].map(line =>
      line.map(c => {
        const s = String(c ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}-${today()}.csv"`);
    await audit(req.user.id, 'report.exported', { key: req.params.key, rows: rows.length }, req.ip);
    return res.send(csv);
  }
  res.json({ name: rep.name, cols: rep.cols, rows });
}));

/* ═══════════ ADMIN ═══════════ */
/**
 * Reps discovered in Zoho — every Regional Rep on an active ring, with their
 * ring count, regions, and whether an account already exists here.
 *
 * This is how accounts get created: pulled from the CRM rather than typed,
 * so a rep added in Zoho simply appears here ready to invite.
 */
r.get('/admin/reps-from-zoho', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const rings = (await zoho.coql(queries.repsOnRings())).map(fromZoho.ring);

  const byRep = new Map();
  rings.forEach(ring => {
    if (!ring.repZohoId) return;
    if (!byRep.has(ring.repZohoId)) {
      byRep.set(ring.repZohoId, {
        contactId: ring.repZohoId, name: ring.repName || 'Unnamed rep',
        rings: 0, ringNames: [], regions: new Set(),
      });
    }
    const e = byRep.get(ring.repZohoId);
    e.rings++;
    if (e.ringNames.length < 6) e.ringNames.push(ring.name);
    if (ring.regionName) e.regions.add(ring.regionName);
  });

  // Fill in contact details (email, phone) for the reps we found
  const ids = [...byRep.keys()];
  if (ids.length) {
    const contacts = await zoho.coql(queries.contactsByIds(ids)).catch(() => []);
    contacts.map(fromZoho.member).forEach(c => {
      const e = byRep.get(c.id);
      if (e) { e.email = c.email || ''; e.phone = c.phone || ''; e.business = c.business || ''; }
    });
  }

  const existing = await q.allUsers();
  const linked = new Set(existing.map(u => u.zoho_owner_id).filter(Boolean));

  const out = [...byRep.values()]
    .map(e => ({
      ...e,
      regions: [...e.regions],
      hasAccount: linked.has(e.contactId),
      account: existing.find(u => u.zoho_owner_id === e.contactId) || null,
    }))
    .sort((a, b) => b.rings - a.rings);

  res.json(out);
}));

/** Create an account straight from a Zoho rep, no typing of ids. */
r.post('/admin/users/from-zoho', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  const { contactId, name, email, role } = req.body || {};
  if (!contactId || !name) return res.status(400).json({ error: 'A Zoho contact and name are required' });
  if (!email) return res.status(400).json({ error: 'That rep has no email in Zoho — add one there, or create the account manually' });

  const existing = await q.allUsers();
  if (existing.some(u => u.zoho_owner_id === contactId)) {
    return res.status(409).json({ error: 'That rep already has an account' });
  }
  if (existing.some(u => String(u.email).toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: 'That email is already in use' });
  }

  const id = 'u_' + Date.now().toString(36);
  const temp = Math.random().toString(36).slice(2, 10);
  await q.insertUser({
    id, email: String(email).trim(), name: String(name).trim(), phone: null,
    role: role === 'staff' || role === 'admin' ? role : 'rep', region: null,
    password_hash: auth.hash(temp), zoho_owner_id: String(contactId).trim(),
  });
  await audit(req.user.id, 'user.createdFromZoho', { id, contactId, email }, req.ip);

  // Send them their login rather than making the office copy it into an email
  // Invite them to choose their own password rather than mailing one out.
  // A password in an inbox stays there forever; a link expires.
  let emailed = false;
  if (req.body?.sendEmail !== false) {
    const sent = await sendPasswordLink({ id, name, email }, req, { invite: true });
    emailed = !!(sent && sent.ok === true);
  }
  res.status(201).json({ id, tempPassword: emailed ? undefined : temp, emailed, invited: emailed });
}));

/**
 * Why isn't email working?
 *
 * Reports exactly what is configured and, optionally, tries a real send and
 * hands back the server's own error. Guessing at SMTP problems from the
 * outside wastes more time than any other part of setup.
 */
r.get('/admin/mail-status', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  const m = cfg.mail;
  const problems = [];
  if (!m.enabled) problems.push('MAIL_ENABLED is not set to true');
  if (!m.host) problems.push('SMTP_HOST is not set');
  if (!m.user) problems.push('SMTP_USER is not set');
  if (!m.pass) problems.push('SMTP_PASS is not set');
  if (m.host && m.port !== 465 && m.port !== 587) {
    problems.push(`SMTP_PORT is ${m.port} — Zoho and Gmail both want 465`);
  }
  if (/gmail/i.test(m.host) && m.pass && m.pass.includes(' ')) {
    problems.push('SMTP_PASS has spaces in it — Google shows the app password in four blocks, but it must be typed without spaces');
  }
  if (m.from && !/@/.test(m.from)) problems.push('MAIL_FROM does not contain an email address');

  res.json({
    enabled: m.enabled,
    host: m.host || null,
    port: m.port,
    user: m.user ? m.user.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    passSet: !!m.pass,
    passLength: m.pass ? m.pass.length : 0,
    from: m.from,
    appUrl: cfg.appUrl,
    linkBase: siteUrl(req),
    linkBaseFromRequest: !cfg.appUrl || /localhost|127\.0\.0\.1/.test(cfg.appUrl),
    ready: problems.length === 0,
    problems,
  });
}));

/** Send a real email and report what actually happened. */
r.post('/admin/mail-test', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  const to = String(req.body?.to || req.user.email || '').trim();
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Where should the test go?' });

  const out = await reminders.sendEmail(to, 'Rep Hub test email',
    `<p>This is a test from Rep Hub.</p>
     <p>If you are reading it, sign-in links and the accounting summary will work.</p>
     <p style="color:#8A9284;font-size:12px">Sent ${new Date().toISOString()} from ${esc(cfg.mail.host || 'unknown host')}.</p>`,
    { userId: req.user.id, kind: 'test' });

  if (out && out.ok) {
    await audit(req.user.id, 'mail.test', { to, ok: true }, req.ip);
    return res.json({ ok: true, to, host: cfg.mail.host, from: cfg.mail.from });
  }

  // Turn the usual SMTP errors into something actionable
  const raw = (out && out.error) || 'Unknown error';
  let hint = null;
  if (/invalid login|535|authentication failed/i.test(raw)) {
    hint = 'The username or password was rejected. Use an app password, not the normal account password.';
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    hint = `The host "${cfg.mail.host}" could not be found. Check the spelling — smtp.zoho.com or smtp.gmail.com.`;
  } else if (/ECONNREFUSED|ETIMEDOUT|ESOCKET/i.test(raw)) {
    hint = `Could not connect on port ${cfg.mail.port}. Try 465.`;
  } else if (/not configured/i.test(raw)) {
    hint = 'MAIL_ENABLED is not true, or the deploy has not run since the variables were added.';
  } else if (/self.signed|certificate/i.test(raw)) {
    hint = 'The mail server certificate was rejected. Check the host name is right.';
  }
  res.status(502).json({ ok: false, error: raw, hint, host: cfg.mail.host, port: cfg.mail.port });
}));

r.get('/admin/users', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  res.json(await q.allUsers());
}));

r.post('/admin/users', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  const { email, name, role, region, phone, password, zohoContactId } = req.body || {};
  if (!email || !name || !role) return res.status(400).json({ error: 'email, name and role are required' });
  if (!['rep', 'staff', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const id = `u_${Date.now().toString(36)}`;
  const temp = password || Math.random().toString(36).slice(2, 10);
  try {
    await q.insertUser({
      id, email, name, phone: phone || null, role, region: region || null,
      password_hash: auth.hash(temp),
      // For a rep this is their Zoho CONTACT id — the link that scopes
      // everything they can see. Without it they sign in to an empty app.
      zoho_owner_id: zohoContactId ? String(zohoContactId).trim() : null,
    });
  } catch (e) {
    return res.status(409).json({ error: 'That email already exists' });
  }
  await audit(req.user.id, 'user.created', { id, email, role, linked: !!zohoContactId }, req.ip);
  res.status(201).json({
    id,
    tempPassword: password ? undefined : temp,
    warning: role === 'rep' && !zohoContactId
      ? 'This rep has no Zoho Contact ID, so they will see no rings. Add it before they sign in.'
      : undefined,
  });
}));

/**
 * Reset someone's password. Passwords are hashed and cannot be read back —
 * not by us, not by the office — so the only way to help someone locked out
 * is to issue a new one.
 */
r.post('/admin/users/:id/reset-password', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  const user = await q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such account' });
  const temp = Math.random().toString(36).slice(2, 10);
  await q.setPassword(auth.hash(temp), user.id);
  await audit(req.user.id, 'user.passwordReset', { id: user.id, email: user.email }, req.ip);
  res.json({ tempPassword: temp, email: user.email, name: user.name });
}));

/** Reset someone's password and email them the new one. */
r.post('/admin/users/:id/resend', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const users = await q.allUsers();
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'No such account' });
  // Prefer sending a link so they choose their own. Only fall back to a
  // generated password when email cannot go out, so nobody is locked out.
  const sent = await sendPasswordLink(u, req, { invite: false });
  if (sent && sent.ok === true) {
    await audit(req.user.id, 'user.resetLinkSent', { id: u.id }, req.ip);
    return res.json({ emailed: true, sentTo: u.email });
  }
  const temp = makePassword();
  await q.setPassword(auth.hash(temp), u.id);
  await audit(req.user.id, 'user.passwordReset', { id: u.id }, req.ip);
  res.json({ tempPassword: temp, emailed: false });
}));

r.delete('/admin/users/:id', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove your own account" });
  const everyone = await q.everyUser();
  const target = everyone.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  const admins = everyone.filter(u => u.role === 'admin' && u.active);
  if (target.role === 'admin' && admins.length <= 1) {
    return res.status(400).json({ error: 'That is the only director account — make someone else a director first' });
  }
  // Delete rather than deactivate: a deactivated row still holds the Zoho
  // contact id, so the person could never be added back.
  await q.hardDelete(req.params.id);
  await audit(req.user.id, 'user.removed', { id: req.params.id, email: target.email }, req.ip);
  res.json({ ok: true, removed: target.email });
}));

r.get('/admin/audit', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  res.json(await q.recentAudit(parseInt(req.query.limit || '100', 10)));
}));

r.get('/admin/settings', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  res.json({
    retryDays: parseInt(await setting('retryDays', '4'), 10),
    rescheduleDays: parseInt(await setting('rescheduleDays', '7'), 10),
    dueWindow: parseInt(await setting('dueWindow', String(cfg.reminders.dueWindowDays)), 10),
    announcement: await setting('announcement', ''),
  });
}));

r.put('/admin/settings', auth.authRequired, auth.requireAdmin, wrap(async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) await q.setSetting(k, String(v));
  await audit(req.user.id, 'settings.updated', req.body, req.ip);
  res.json({ ok: true });
}));

/* ═══════════ REMINDERS (manual trigger / preview) ═══════════ */
r.post('/reminders/run', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const kind = req.body?.kind || 'weekly';
  const dryRun = req.body?.dryRun !== false;   // default to preview, not blast
  const fn = kind === 'nudge' ? reminders.runOverdueNudge
    : kind === 'office' ? reminders.runOfficeSummary
    : reminders.runWeeklyDigest;
  const out = await fn({ dryRun });
  await audit(req.user.id, 'reminder.manual', { kind, dryRun }, req.ip);
  res.json({ kind, dryRun, results: out });
}));

module.exports = r;

'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cfg = require('./config');
const { q, audit } = require('./db');

// A dummy hash so a wrong email costs the same time as a wrong password.
const DUMMY = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function hash(pw) { return bcrypt.hashSync(pw, 10); }
function verify(pw, h) { return bcrypt.compareSync(pw, h); }

function issue(user) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, cfg.jwtSecret, { expiresIn: cfg.jwtExpiry });
}
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, region: u.region, phone: u.phone,
    // The rep's Zoho CONTACT id. Everything a rep can see is scoped by this,
    // via Growth_Ring_Groups.Regional_Rep. Without it a rep sees nothing.
    zoho_owner_id: u.zoho_owner_id || null,
  };
}

/** The person as the app sees them: who they are plus what they may do. */
async function withAccess(u) {
  const access = require('./access');
  return { ...publicUser(u), owner: await access.isOwner(u), perms: await access.permsFor(u) };
}

/* ── Wrong passwords: after this many in a quarter of an hour, stop trying ── */
const LOCK_AFTER = 8, LOCK_MINUTES = 15;

/* ── Trusted devices ("Don't ask again on this device") ──
   The browser keeps a random token; only its hash is stored here. */
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const DEVICE_DAYS = 30;
async function trustDevice(userId, label) {
  const raw = crypto.randomBytes(32).toString('hex');
  await q.addDevice(sha(raw), userId, String(label || 'A browser').slice(0, 120),
    new Date(Date.now() + DEVICE_DAYS * 86400000).toISOString());
  return raw;
}
async function deviceTrusted(userId, raw, { touch = true } = {}) {
  if (!raw) return false;
  const row = await q.deviceByHash(sha(raw));
  if (!row || row.user_id !== userId || new Date(row.expires_at) < new Date()) return false;
  if (touch) await q.touchDevice(row.token_hash).catch(() => {});
  return true;
}

/** A short-lived pass between the password and the emailed code. */
function challengeFor(user) {
  return jwt.sign({ sub: user.id, step: '2sv' }, cfg.jwtSecret, { expiresIn: '15m' });
}
function readChallenge(token) {
  try { const c = jwt.verify(String(token || ''), cfg.jwtSecret); return c.step === '2sv' ? c.sub : null; }
  catch { return null; }
}

/** Proof the owner re-typed their password in the last 15 minutes. */
function elevate(user) {
  return jwt.sign({ sub: user.id, step: 'elevated' }, cfg.jwtSecret, { expiresIn: '15m' });
}
function requireElevated(req, res, next) {
  try {
    const c = jwt.verify(String(req.headers['x-elevation'] || ''), cfg.jwtSecret);
    if (c.step === 'elevated' && c.sub === req.user.id) return next();
  } catch { /* fall through */ }
  return res.status(401).json({ error: 'Enter your password again to change these settings', needsPassword: true });
}

const maskEmail = e => String(e || '').replace(/^(.)(.*)(.@.*)$/, (m, a, mid, b) => a + '•'.repeat(Math.min(6, mid.length)) + b);

/**
 * Password check. Returns null (wrong), { locked }, { unverified, user },
 * { twoStep, user } when the emailed code is still needed, or a session.
 */
async function login(email, password, ip, device, gate = true) {
  const user = await q.userByEmail(String(email || '').trim());
  const access = require('./access');
  // Everything after the lookup runs side by side: the password check (which
  // yields while it works), the lock-out count, the 2-step rule and the
  // remembered device. One after another, each database trip added up.
  const [ok, fails, twoStep, trusted] = await Promise.all([
    bcrypt.compare(password || '', user ? user.password_hash : DUMMY).catch(() => false),
    user ? q.failsSinceOk(user.id, LOCK_MINUTES).then(r => r?.c || 0) : 0,
    user ? access.needsTwoStep(user) : false,
    user ? deviceTrusted(user.id, device, { touch: false }) : false,
  ]);
  // The robot check runs alongside the reads above; nothing is recorded
  // (a failed attempt, a sign-in) unless it passed.
  if (!(await gate)) return { blocked: true };
  if (trusted) q.touchDevice(sha(device)).catch(() => {});
  if (user && fails >= LOCK_AFTER) {
    await audit(user.id, 'login.locked', { email }, ip);
    return { locked: true };
  }
  if (!user || !ok) {
    await audit(user?.id, 'login.failed', { email }, ip);
    return null;
  }
  // Right password, but they never typed the code from the sign-up email
  if (user.email_verified === false) return { unverified: true, user };
  if (twoStep && !trusted) {
    await audit(user.id, 'login.passwordOk', null, ip);
    return { twoStep: true, user };
  }
  return finishLogin(user, ip);
}
async function finishLogin(user, ip) {
  // Side by side, not one after another: each is a round trip to the database
  const [, , who] = await Promise.all([q.touchLogin(user.id), audit(user.id, 'login.ok', null, ip), withAccess(user)]);
  return { token: issue(user), user: who };
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!raw) return res.status(401).json({ error: 'Not signed in' });
  let user;
  try {
    const claims = jwt.verify(raw, cfg.jwtSecret);
    if (claims.step) throw new Error('not a session');      // a 2-step or elevation pass is not a sign-in
    user = await q.userById(claims.sub);
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
  if (!user || !user.active) return res.status(401).json({ error: 'Account inactive' });
  req.user = await withAccess(user);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}
const requireOffice = requireRole('staff', 'admin');
const requireAdmin = requireRole('admin');

function scopeFor(user) {
  return user.role === 'rep' ? { repId: user.id, all: false } : { repId: null, all: true };
}

module.exports = { hash, verify, issue, login, finishLogin, publicUser, withAccess, authRequired, requireRole, requireOffice,
  requireAdmin, scopeFor, trustDevice, challengeFor, readChallenge, elevate, requireElevated, maskEmail, sha,
  LOCK_AFTER, LOCK_MINUTES };

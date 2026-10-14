'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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

async function login(email, password, ip) {
  const user = await q.userByEmail(String(email || '').trim());
  const ok = verify(password || '', user ? user.password_hash : DUMMY);
  if (!user || !ok) {
    await audit(user?.id, 'login.failed', { email }, ip);
    return null;
  }
  await q.touchLogin(user.id);
  await audit(user.id, 'login.ok', null, ip);
  return { token: issue(user), user: publicUser(user) };
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!raw) return res.status(401).json({ error: 'Not signed in' });
  try {
    const claims = jwt.verify(raw, cfg.jwtSecret);
    const user = await q.userById(claims.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Account inactive' });
    req.user = publicUser(user);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
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

module.exports = { hash, verify, issue, login, publicUser, authRequired, requireRole, requireOffice, requireAdmin, scopeFor };

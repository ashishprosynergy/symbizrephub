'use strict';
const express = require('express');
const crypto = require('crypto');
const zoho = require('./lib/zoho');
const cfg = require('./config');
const { q, audit, setting, query } = require('./db');
const auth = require('./auth');
const access = require('./access');
const { enqueue, flushQueue } = require('./sync');
const reminders = require('./reminders');
const { tablePDF } = require('./lib/pdf');
const books = require('./lib/books');
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
  const out = { dbReady: false, needsSetup: false, zohoReady: false, userCount: 0,
                readOnly: cfg.readOnly, zohoOrg: null, zohoError: null };
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
  try {
    const org = await zoho.ping();
    out.zohoReady = true;
    out.zohoOrg = (org && (org.company_name || org.name)) || null;
  } catch (e) {
    // Keep the real reason. "Not connected" on its own sends people checking
    // the CRM when the token has simply lapsed.
    out.zohoError = /token|refresh|401|invalid/i.test(e.message || '')
      ? 'the connection has lapsed, reconnect in Netlify'
      : e.message;
  }
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
  await access.setOwner(id);            // whoever installs Rep Hub owns it
  const user = await q.userByEmail(email);
  res.status(201).json({ token: auth.issue(user), user: await auth.withAccess(user) });
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
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · {{SUPPORT}}</p>
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
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · {{SUPPORT}}</p>
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
 * An address with no account, and no rep in Zoho behind it, is told so.
 * That does say whether an address is known, a fair trade for a closed group
 * of reps who were otherwise left waiting for emails that never came.
 */
/**
 * A rep asking for a code before the office has created their account.
 *
 * Only a handful of accounts had been made, so every other rep who typed
 * their email got nothing — and was told a code was on its way. If the
 * address belongs to a Regional Rep on an active ring in Zoho, make the
 * account now. Safe: the code still only goes to that inbox, and the account
 * is scoped to their own rings exactly as one made by the office would be.
 */
async function accountFromZoho(email) {
  const c = await zohoRepFor(email);
  if (!c) return null;

  // Already here under another address, or switched off: leave it to the office
  const existing = await q.allUsers();
  if (existing.some(u => u.zoho_owner_id === c.id || String(u.email).toLowerCase() === email)) return null;

  const user = {
    id: 'u_' + Date.now().toString(36), email, name: c.repName || c.name || email,
    phone: c.phone || null, role: 'rep', region: c.region || null,
    // Unusable until they choose their own with the emailed code
    password_hash: auth.hash(crypto.randomBytes(24).toString('hex')),
    zoho_owner_id: c.id,
  };
  await q.insertUser(user);
  await audit(user.id, 'user.selfSetupFromZoho', { email, contactId: c.id }, null);
  return q.userByEmail(email);
}

/** The account for this email, creating it for a known Zoho rep if need be. */
async function findOrCreateAccount(email) {
  const user = await q.userByEmail(email);
  if (user) return user.active === false ? null : user;
  return accountFromZoho(email).catch(e => {
    console.error('[auth] Zoho rep lookup failed:', e.message);
    return null;
  });
}

// Saying plainly that nothing was sent. "A code is on its way" for an address
// with no account left reps waiting for an email that was never coming.
const NO_ACCOUNT = 'There is no Rep Hub account for that email, and it is not a rep\'s email in Symbiz\'s records. ' +
  'Check it is the address the office has for you, or ask Keturah or Mel to add you.';

/**
 * An emailed link now only SETS UP an account: it opens "choose your
 * password", and the person then signs in like anyone else (with the code,
 * if their role uses 2-step). A link that signed straight in gave full access
 * to whoever held the inbox.
 */
r.post('/auth/request-link', wrap(async (req, res) => {
  if (!(await humanCheck(req, res))) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'That does not look like an email address' });

  const user = await findOrCreateAccount(email);
  if (!user) return res.status(404).json({ error: NO_ACCOUNT, noAccount: true });

  const recent = await q.recentTokenCount(user.id, 'setpassword');
  if ((recent?.c || 0) >= 8) {
    return res.json({ ok: true, message: 'A link was sent recently — check your inbox, including spam.' });
  }
  await q.purgeOldTokens().catch(() => {});
  const sent = await sendPasswordLink(user, req, { invite: !user.last_login_at });
  if (sent && sent.ok === false) {
    return res.status(503).json({ error: sent.skipped
      ? 'Email is not switched on for this site yet, so no link could be sent.'
      : 'The email could not be sent just now. Try again in a minute.' });
  }
  await audit(user.id, 'auth.setupLinkRequested', { email }, req.ip);
  res.json({ ok: true, message: 'We have emailed a link to set up your account.' });
}));

/**
 * Choose or reset a password.
 *
 * Used two ways: the invitation a new rep gets, and "I've forgotten mine".
 * Both send a link to the address on file, so only the person who owns that
 * inbox can set the password — nobody can set someone else's by knowing
 * their email.
 */
/**
 * A six-digit code, emailed.
 *
 * Preferred over a link for resets: reps often read email on a different
 * device from the one they are signing in on, and some mail clients mangle
 * links. A code works whatever they are holding.
 */
/**
 * Email a six-digit code. purpose 'otp' resets a password; 'verify' confirms
 * the address on a new sign-up. Every code stays good until it expires or
 * another one is used, so asking twice never breaks the first email.
 */
async function sendCode(user, req, purpose = 'otp') {
  const code = String(crypto.randomInt(100000, 1000000));
  const minutes = 15;
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  // Stored as the code itself, scoped to this user and single use. It is
  // short-lived and rate limited, which is what makes six digits safe enough.
  await q.addLoginToken(`${purpose}:${user.id}:${code}`, user.id, expires, req.ip, purpose);
  const verify = purpose === 'verify', twoStep = purpose === '2sv';
  const where = req.headers['user-agent'] ? deviceLabel(req.headers['user-agent']) : '';
  return reminders.sendEmail(user.email, twoStep ? `Rep Hub sign-in code: ${code}` : `Your Rep Hub code: ${code}`,
    `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
    <div style="max-width:440px;margin:0 auto;padding:26px 18px;text-align:center;">
      <h1 style="font-size:18px;color:#1E2A20;margin:0 0 6px;">${verify ? 'Confirm your email' : twoStep ? 'Your sign-in code' : 'Your password reset code'}</h1>
      <p style="color:#5A6455;font-size:14px;margin:0 0 18px;">
        ${esc((user.name||'').split(' ')[0] || 'Hello')}, ${verify
          ? 'type this into Rep Hub to finish setting up your account.'
          : twoStep ? `someone — hopefully you — entered your password${where ? ` on ${esc(where)}` : ''}. Type this code to finish signing in.`
          : 'type this into Rep Hub to choose a new password.'}</p>
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:34px;font-weight:700;
        letter-spacing:.18em;color:#2E5132;background:#fff;border-radius:10px;padding:16px 10px;">${code}</div>
      <p style="color:#8A9284;font-size:12.5px;margin:18px 0 0;">
        It expires in ${minutes} minutes and works once.
        ${verify ? "If you didn't sign up for Rep Hub, ignore it."
          : twoStep ? "<strong>If this wasn't you, change your password now</strong> — whoever tried has it, but cannot get in without this code."
          : "If you didn't ask for this, ignore it — your password has not changed."}</p>
      <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network</p>
    </div></body></html>`,
    { userId: user.id, kind: purpose });
}

/* ── "I'm not a robot" (Google reCAPTCHA v2) on the sign-in screens ──
   Off until the owner pastes keys into Access & security. Fails OPEN when
   the keys are wrong or Google can't be reached, and says so in the
   activity log: a typo in a key must never lock every director out. */
let captchaCache = null, unprovenNoted = 0;
async function captchaKeys() {
  if (captchaCache && Date.now() - captchaCache.at < 60000) return captchaCache.keys;
  const s = await require('./db').settings({ captcha_site_key: '', captcha_secret: '', captcha_type: '', captcha_proven: '' });
  const keys = { site: s.captcha_site_key, secret: s.captcha_secret,
    // v3 = invisible "score" keys (Google's default); v2 = the "I'm not a robot" box
    type: s.captcha_type || 'v3',
    // Has a real check ever passed with these keys? Until one has, a wrong key
    // or key type must not stop anyone signing in.
    proven: s.captcha_proven === '1' };
  captchaCache = { at: Date.now(), keys };
  return keys;
}
async function humanCheck(req, res) {
  const { secret, proven } = await captchaKeys();
  if (!secret) return true;
  const token = String(req.body?.captcha || '');
  if (!token) {
    if (!proven) {
      // The keys have never worked (wrong type, wrong domain…). Let people in
      // rather than lock everyone out — as happened once. Noted once an hour.
      if (Date.now() - unprovenNoted > 3600000) { unprovenNoted = Date.now(); await audit(null, 'captcha.unproven', { path: req.path }, req.ip); }
      return true;
    }
    res.status(400).json({ error: 'Tick "I\'m not a robot" first.', captcha: true }); return false;
  }
  try {
    const r2 = await fetch(process.env.RECAPTCHA_VERIFY_URL || 'https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: req.ip || '' }), signal: AbortSignal.timeout(5000) });
    const out = await r2.json();
    // v3 tokens carry a score: 1 is surely a person, 0 surely a bot
    if (out.success && (typeof out.score !== 'number' || out.score >= 0.3)) {
      if (!proven) { await q.setSetting('captcha_proven', '1'); captchaCache = null; }
      return true;
    }
    if (out.success) { res.status(400).json({ error: 'That looked automated. Wait a moment and try again.', captcha: true }); return false; }
    if (!proven) { await audit(null, 'captcha.unproven', { codes: out['error-codes'] || [] }, req.ip); return true; }
    const codes = out['error-codes'] || [];
    if (codes.some(c => /secret/.test(c))) {
      await audit(null, 'captcha.misconfigured', { codes }, req.ip);
      return true;
    }
    res.status(400).json({ error: 'The robot check did not pass. Tick the box again.', captcha: true });
    return false;
  } catch (e) {
    console.error('[captcha] could not check with Google:', e.message);
    return true;
  }
}
/**
 * Which kind of key is this? Google's widget page says "Invalid" when asked
 * to draw a tick box with a score-based key. Picking the wrong type once
 * locked everyone out, so the owner no longer has to know. Null if unsure.
 */
async function detectCaptchaType(siteKey, site) {
  try {
    const co = Buffer.from(`${new URL(site).origin}:443`).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const base = process.env.RECAPTCHA_ANCHOR_URL || 'https://www.google.com/recaptcha/api2/anchor';
    const page = await (await fetch(`${base}?ar=1&k=${encodeURIComponent(siteKey)}&co=${co}&hl=en&size=normal`,
      { signal: AbortSignal.timeout(5000) })).text();
    return /Invalid (input|key type)/i.test(page) ? 'v3' : 'v2';
  } catch (e) { return null; }
}

const typeChecked = new Set();
r.get('/auth/captcha', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  let k = await captchaKeys();
  // Keys saved with the wrong type (a score key as a tick box) show Google's
  // "Invalid key type". Check once per key and put it right.
  if (k.site && !k.proven && !typeChecked.has(k.site)) {
    typeChecked.add(k.site);
    const real = await detectCaptchaType(k.site, siteUrl(req));
    if (real && real !== k.type) {
      await q.setSetting('captcha_type', real);
      await audit(null, 'captcha.typeCorrected', { from: k.type, to: real }, req.ip);
      captchaCache = null; k = await captchaKeys();
    }
  }
  res.json({ siteKey: k.site || null, type: k.type });
}));

/** "Chrome on Windows", from a user-agent string, for emails and the device list. */
function deviceLabel(ua) {
  ua = String(ua || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Check a code of the given purpose; burn it and its siblings if good. */
async function useCode(user, code, purpose) {
  const row = await q.findLoginToken(`${purpose}:${user.id}:${code}`);
  if (!row || row.purpose !== purpose) return 'That code is not right. Check it and try again.';
  if (row.used_at) return 'That code has already been used. Ask for a new one.';
  if (new Date(row.expires_at) < new Date()) return 'That code has expired. Ask for a new one.';
  await q.useLoginToken(row.token);
  await q.expireOtherCodes(user.id, purpose).catch(() => {});
  return null;
}

/** Check a code and hand back a short-lived token to set the password with. */
r.post('/auth/verify-code', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length !== 6) return res.status(400).json({ error: 'The code is six digits' });

  const user = await q.userByEmail(email);
  if (!user || user.active === false) return res.status(401).json({ error: 'That code is not right. Check it and try again.' });

  const problem = await useCode(user, code, 'otp');
  if (problem) return res.status(401).json({ error: problem });

  // Swap the code for a token the set-password step accepts
  const token = crypto.randomBytes(32).toString('hex');
  await q.addLoginToken(token, user.id, new Date(Date.now() + 15 * 60000).toISOString(), req.ip, 'setpassword');
  await audit(user.id, 'auth.codeVerified', {}, req.ip);
  res.json({ token, name: user.name, email: user.email });
}));

/* ── Sign up ──
 * Anyone can make an account with their own email and password, confirmed
 * by a code. A rep whose email is on their Zoho contact is linked to their
 * rings straight away. Anyone else gets an account that shows nothing until
 * the office links it — so signing up never opens up member data. */

/** Their Zoho rep contact, if this email is one. */
async function zohoRepFor(email) {
  const rings = (await zoho.coql(queries.repsOnRings())).map(fromZoho.ring);
  const names = new Map();
  rings.forEach(r => { if (r.repZohoId && !names.has(r.repZohoId)) names.set(r.repZohoId, r.repName); });
  if (!names.size) return null;
  const contacts = (await zoho.coql(queries.contactsByIds([...names.keys()]))).map(fromZoho.member);
  const c = contacts.find(x => String(x.email || '').trim().toLowerCase() === email);
  return c ? { ...c, repName: names.get(c.id) } : null;
}

r.post('/auth/signup', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  // Cheap checks first; the robot check (a call to Google) only for a real attempt
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That does not look like an email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters for your password' });
  if (!(await humanCheck(req, res))) return;

  let user = await q.userByEmail(email);
  if (user && user.email_verified !== false) {
    return res.status(409).json({ error: 'There is already an account for that email. Sign in, or use "Forgotten your password?"' });
  }

  if (user) {
    // Signed up before but never confirmed: take the new details, send a new code
    await q.updateSignup(user.id, name, auth.hash(password));
  } else {
    if (await q.anyUserByEmail(email)) {        // exists but switched off
      return res.status(409).json({ error: 'That account has been switched off. Ask the office to turn it back on.' });
    }
    // The app's own sign-up does the Zoho lookup later, while the code email is
    // on its way (see /auth/resend-verification), so pressing Create is quick.
    const rep = req.body?.sendLater ? null
      : await zohoRepFor(email).catch(e => { console.error('[signup] Zoho lookup failed:', e.message); return null; });
    // One account per Zoho contact; a second address for the same rep stays unlinked
    const taken = rep && (await q.allUsers()).some(u => u.zoho_owner_id === rep.id);
    const id = 'u_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    await q.insertUser({
      id, email, name, phone: rep?.phone || null, role: 'rep', region: rep?.region || null,
      password_hash: auth.hash(password), zoho_owner_id: rep && !taken ? rep.id : null,
      email_verified: false,
    });
    await audit(id, 'user.signedUp', { email, linked: !!(rep && !taken) }, req.ip);
  }
  user = await q.userByEmail(email);
  if (req.body?.sendLater) return res.status(201).json({ ok: true, email, sending: true });

  const recent = await q.recentTokenCount(user.id, 'verify');
  if ((recent?.c || 0) >= 8) {
    return res.status(429).json({ error: 'Several codes have been sent already. Use one of those, or wait a few minutes.' });
  }
  const sent = await sendCode(user, req, 'verify');
  if (sent && sent.ok === false) {
    return res.status(503).json({ error: sent.skipped
      ? 'Email is not switched on for this site, so the confirmation code could not be sent.'
      : 'The confirmation code could not be emailed just now. Try again in a minute.' });
  }
  res.status(201).json({ ok: true, email, linked: !!user.zoho_owner_id });
}));

/** The code from the sign-up email. Confirms the address and signs them in. */
r.post('/auth/verify-email', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length !== 6) return res.status(400).json({ error: 'The code is six digits' });

  const user = await q.userByEmail(email);
  if (!user) return res.status(401).json({ error: 'That code is not right. Check it and try again.' });
  if (user.email_verified !== false) return res.status(409).json({ error: 'That email is already confirmed. Sign in with your password.' });

  const problem = await useCode(user, code, 'verify');
  if (problem) return res.status(401).json({ error: problem });

  // The Zoho rep lookup already ran while the code email went out; not again here
  await Promise.all([q.markVerified(user.id), q.touchLogin(user.id), audit(user.id, 'auth.emailVerified', {}, req.ip)]);
  const fresh = await q.userById(user.id);
  notifyOfficeOfSignup(fresh).catch(() => {});
  res.json({ token: auth.issue(fresh), user: await auth.withAccess(fresh) });
}));

r.post('/auth/resend-verification', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = await q.userByEmail(email);
  if (!user || user.email_verified !== false) return res.status(400).json({ error: 'Nothing waiting to be confirmed for that email.' });
  const recent = await q.recentTokenCount(user.id, 'verify');
  if ((recent?.c || 0) >= 8) {
    return res.status(429).json({ error: 'Several codes have been sent already. Use one of those, or wait a few minutes.' });
  }
  // The code email and the Zoho rep lookup side by side: neither waits on the other
  const [sent] = await Promise.all([sendCode(user, req, 'verify'), linkRepIfUnlinked(user)]);
  if (sent && sent.ok === false) return res.status(503).json({ error: 'The code could not be emailed just now. Try again in a minute.' });
  res.json({ ok: true });
}));

/** A new account whose email is a rep's in Zoho gets that rep's rings. Never throws. */
async function linkRepIfUnlinked(user) {
  if (!user || user.zoho_owner_id || user.role !== 'rep') return;
  try {
    const rep = await zohoRepFor(String(user.email).toLowerCase());
    if (!rep) return;
    if ((await q.allUsers()).some(u => u.zoho_owner_id === rep.id)) return;   // one account per rep
    await q.linkZoho(user.id, rep.id, rep.phone || null, rep.region || null);
    await audit(user.id, 'user.linkedToZoho', { contactId: rep.id }, null);
  } catch (e) { console.error('[signup] Zoho lookup failed:', e.message); }
}

/** Tell the office someone joined, and whether they still need linking. */
async function notifyOfficeOfSignup(user) {
  const office = await q.allOffice();
  const linked = !!user.zoho_owner_id;
  for (const o of office) {
    await reminders.sendEmail(o.email, `New Rep Hub sign-up: ${user.name}`,
      `<p><strong>${esc(user.name)}</strong> (${esc(user.email)}) has created a Rep Hub account.</p>
       <p>${linked
         ? 'Their email matches a rep in Zoho, so they already see their own rings.'
         : 'Their email is not on a rep\'s contact in Zoho, so they see nothing yet. If they should, link them from Admin → Accounts, or remove the account if you don\'t know them.'}</p>`,
      { userId: o.id, kind: 'signup' });
  }
}

async function sendPasswordLink(user, req, { invite, from, queue } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  // An invitation sent by the office may sit in an inbox over a weekend
  const hours = from ? 168 : invite ? 72 : 2;
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  await q.addLoginToken(token, user.id, expires, req.ip, 'setpassword');
  const url = `${siteUrl(req)}/?setup=${token}`;
  // From the office: into the outbox, sent in the background (no waiting on Gmail)
  return (queue ? reminders.queueEmail : reminders.sendEmail)(user.email,
    from ? `${(from.name || 'Symbiz').split(' ')[0]} has invited you to Rep Hub` : invite ? 'Set up your Rep Hub password' : 'Reset your Rep Hub password',
    from ? welcomeEmail({ name: user.name, email: user.email, url, from, site: siteUrl(req) }) : passwordLinkEmail({ name: user.name, url, invite, hours }),
    { userId: user.id, kind: invite ? 'invite' : 'reset', replyTo: from ? from.email : undefined });
}

/** The invitation a rep gets from the office: what Rep Hub is, and three steps */
function welcomeEmail({ name, email, url, from, site }) {
  const first = esc((name || '').split(' ')[0] || 'Hello'), by = esc(from.name || 'The Symbiz office');
  const step = (n, t) => `<tr><td style="vertical-align:top;padding:0 10px 10px 0"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;
    background:#2E5132;color:#fff;font-size:12px;font-weight:700;text-align:center;line-height:22px">${n}</span></td>
    <td style="padding:0 0 10px;font-size:14px;line-height:1.5;color:#1E2A20">${t}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#F2F5EC;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:26px 18px;">
    <h1 style="font-size:19px;color:#1E2A20;margin:0 0 8px;">Welcome to Rep Hub</h1>
    <p style="color:#3A4537;font-size:14.5px;line-height:1.6;margin:0 0 14px;">${first}, ${by} has set up your Rep Hub account.
      It shows the Growth Rings you look after, who is due a call, your ring meetings on a calendar, and where to log
      your calls, visits, hours and expenses — on your phone, tablet or computer.</p>
    <table style="border-collapse:collapse;margin:0 0 16px">
      ${step(1, 'Tap the button below and choose a password.')}
      ${step(2, `Sign in with this email address: <strong>${esc(email)}</strong>`)}
      ${step(3, 'On a phone or tablet, add it to your home screen so it opens like an app: in Safari tap Share → <em>Add to Home Screen</em>; in Chrome tap ⋮ → <em>Add to Home screen</em>.')}
    </table>
    <a href="${url}" style="display:inline-block;background:#2E5132;color:#fff;text-decoration:none;
       padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;">Choose my password</a>
    <p style="color:#5A6455;font-size:13px;line-height:1.6;margin:18px 0 0;">The button works once, for the next 7 days. After that,
      go to <a href="${esc(site)}" style="color:#2E5132">${esc(site.replace(/^https?:\/\//, ''))}</a>, tap <em>Invited? Email me a link to set up my account</em> and enter your email for a fresh one.</p>
    <p style="color:#5A6455;font-size:13px;line-height:1.6;margin:10px 0 0;">Questions? Just reply to this email and it goes to ${by}.</p>
    <p style="color:#8A9284;font-size:11.5px;margin-top:18px;word-break:break-all;">${esc(url)}</p>
    <p style="color:#8A9284;font-size:12px;margin-top:16px;">Symbiz Network · {{SUPPORT}}</p>
  </div></body></html>`;
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
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · {{SUPPORT}}</p>
  </div></body></html>`;
}

/** "I've forgotten my password." Same answer whether or not the account exists. */
r.post('/auth/forgot', wrap(async (req, res) => {
  if (!(await humanCheck(req, res))) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const same = { ok: true, message: 'If that address has an account, a code is on its way.' };
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'That does not look like an email address' });

  const user = await findOrCreateAccount(email);
  if (!user) return res.status(404).json({ error: NO_ACCOUNT, noAccount: true });

  // Generous, and counted only against codes. The old limit was shared with
  // sign-in links, so a few attempts silently stopped anything being sent.
  const recent = await q.recentTokenCount(user.id, 'otp');
  if ((recent?.c || 0) >= 8) {
    return res.status(429).json({ error: 'Several codes have been sent already. Use the most recent one, or wait a few minutes.' });
  }

  const sent = await sendCode(user, req, 'otp');
  if (sent && sent.ok === false) {
    // Not configured and "the mail server said no" need different fixes, so
    // do not report both as the first.
    return res.status(503).json({ error: sent.skipped
      ? 'Email is not switched on for this site, so no code could be sent. Ask the office to reset it for you.'
      : 'The code could not be emailed just now. Try again in a minute, or ask the office to reset it for you.' });
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

/** Set the password. It does not sign them in: they do that next, the normal way. */
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
  // Getting here took a code or link from their inbox, so the address is theirs
  if (user.email_verified === false) await q.markVerified(user.id);
  await audit(user.id, 'auth.passwordSet', {}, req.ip);
  // A new password signs out every remembered device
  await q.forgetDevicesFor(user.id).catch(() => {});
  res.json({ ok: true, email: user.email, name: user.name });
}));

/** Old one-tap sign-in links, still sitting in inboxes. They no longer sign anyone in. */
r.post('/auth/verify-link', wrap(async (req, res) => {
  res.status(410).json({ error: 'Sign-in links are no longer used. Sign in with your email and password, ' +
    'or use "Forgotten your password?" to set one.' });
}));

r.post('/auth/login', wrap(async (req, res) => {
  const { email, password, device } = req.body || {};
  // Google's robot check and the password check run together. Nothing is
  // answered until both are done, so a failed robot check still reveals nothing.
  // Nothing is written (failed attempts, sign-in records) until it passes.
  const human = humanCheck(req, res);
  const out = await auth.login(email, password, req.ip, device, human);
  if (!(await human)) return;       // humanCheck has already answered
  if (!out) return res.status(401).json({ error: 'Email or password is incorrect' });
  if (out.locked) {
    return res.status(429).json({ error: `Too many wrong passwords. For your safety this account is paused for ${auth.LOCK_MINUTES} minutes — ` +
      'or use "Forgot password?" to set a new one now.', locked: true });
  }
  if (out.unverified) {
    const recent = await q.recentTokenCount(out.user.id, 'verify');
    if ((recent?.c || 0) < 8) await sendCode(out.user, req, 'verify');
    return res.status(403).json({
      error: 'Confirm your email first. We have sent a code to ' + out.user.email + '.',
      needsVerification: true, email: out.user.email,
    });
  }
  if (out.twoStep) {
    // Like Google's 2-Step Verification: the password alone is not enough
    if (!cfg.mail.enabled) {
      // Email is not set up on this site at all. Demanding a code nobody can
      // receive would lock every director out, so fall back to the password.
      await audit(out.user.id, 'login.twoStepSkipped', { reason: 'mail not configured' }, req.ip);
      return res.json(await auth.finishLogin(out.user, req.ip));
    }
    // The app asks for the code screen straight away and has the email sent
    // by a second call, so nobody stares at "Signing in…" while Gmail answers.
    if (req.body?.sendLater) {
      return res.json({ twoStep: true, challenge: auth.challengeFor(out.user), sentTo: auth.maskEmail(out.user.email), sending: true });
    }
    const recent = await q.recentTokenCount(out.user.id, '2sv');
    let sent = null;
    if ((recent?.c || 0) < 8) sent = await sendCode(out.user, req, '2sv');
    if (sent && sent.ok === false && sent.skipped) {
      // Email is not set up on this site at all. Demanding a code nobody can
      // receive would lock every director out, so fall back to the password
      // and leave a trace of it.
      await audit(out.user.id, 'login.twoStepSkipped', { reason: 'mail not configured' }, req.ip);
      return res.json(await auth.finishLogin(out.user, req.ip));
    }
    if (sent && sent.ok === false) {
      return res.status(503).json({ error: 'Your sign-in code could not be emailed just now. Try again in a minute.' });
    }
    return res.json({ twoStep: true, challenge: auth.challengeFor(out.user), sentTo: auth.maskEmail(out.user.email) });
  }
  res.json(out);
}));

const CODE_TRIES = 5;
/** Second step: the code from the email. Optionally remember this device. */
r.post('/auth/login/code', wrap(async (req, res) => {
  const userId = auth.readChallenge(req.body?.challenge);
  if (!userId) return res.status(401).json({ error: 'That took too long. Sign in again.', restart: true });
  const user = await q.userById(userId);
  if (!user || user.active === false) return res.status(401).json({ error: 'That account is no longer active', restart: true });
  if (((await q.recentAuditCount(user.id, 'login.codeFailed', 15))?.c || 0) >= CODE_TRIES) {
    return res.status(429).json({ error: 'Too many wrong codes. Sign in again to get a new one.', restart: true });
  }
  const code = String(req.body?.code || '').replace(/\D/g, '');
  const problem = code.length === 6 ? await useCode(user, code, '2sv') : 'The code is six digits';
  if (problem) {
    await audit(user.id, 'login.codeFailed', {}, req.ip);
    return res.status(401).json({ error: problem });
  }
  const out = await auth.finishLogin(user, req.ip);
  if (req.body?.trust) {
    out.device = await auth.trustDevice(user.id, deviceLabel(req.headers['user-agent']));
    await audit(user.id, 'device.trusted', { label: deviceLabel(req.headers['user-agent']) }, req.ip);
  }
  res.json(out);
}));

r.post('/auth/login/resend', wrap(async (req, res) => {
  const userId = auth.readChallenge(req.body?.challenge);
  if (!userId) return res.status(401).json({ error: 'That took too long. Sign in again.', restart: true });
  const user = await q.userById(userId);
  if (!user) return res.status(401).json({ error: 'Sign in again.', restart: true });
  const recent = await q.recentTokenCount(user.id, '2sv');
  if ((recent?.c || 0) >= 8) return res.status(429).json({ error: 'Several codes have been sent. Use the newest one, or wait a few minutes.' });
  const sent = await sendCode(user, req, '2sv');
  if (sent && sent.ok === false) return res.status(503).json({ error: 'The code could not be emailed just now.' });
  res.json({ ok: true, sentTo: auth.maskEmail(user.email) });
}));

/** Devices that skip the code, for "Your devices" in Access & security. */
r.get('/auth/devices', auth.authRequired, wrap(async (req, res) => {
  const mine = auth.sha(String(req.headers['x-device'] || ''));
  res.json((await q.devicesFor(req.user.id)).map(d => ({ id: d.token_hash.slice(0, 16), label: d.label,
    added: d.created_at, lastUsed: d.last_used_at, expires: d.expires_at, current: d.token_hash === mine })));
}));
r.delete('/auth/devices/:id', auth.authRequired, wrap(async (req, res) => {
  const d = (await q.devicesFor(req.user.id)).find(x => x.token_hash.startsWith(String(req.params.id)) && req.params.id.length === 16);
  if (!d) return res.status(404).json({ error: 'No such device' });
  await q.forgetDevice(d.token_hash, req.user.id);
  await audit(req.user.id, 'device.forgotten', { label: d.label }, req.ip);
  res.json({ ok: true });
}));

/** Re-type the password before changing who can do what. */
r.post('/auth/elevate', auth.authRequired, wrap(async (req, res) => {
  if (req.user.role === 'rep') return res.status(403).json({ error: 'Not allowed' });
  const [u, failRow] = await Promise.all([q.userById(req.user.id), q.recentAuditCount(req.user.id, 'elevate.failed', 15)]);
  if ((failRow?.c || 0) >= 5) return res.status(429).json({ error: 'Too many wrong passwords. Wait 15 minutes and try again.' });
  if (!auth.verify(String(req.body?.password || ''), u.password_hash)) {
    await audit(u.id, 'elevate.failed', {}, req.ip);
    return res.status(401).json({ error: 'That password is not right' });
  }
  // The owner's screen needs the settings next anyway: fetch them alongside
  // the log entry and send them now, saving a round trip
  const [, payload] = await Promise.all([audit(u.id, 'elevate.ok', {}, req.ip), req.user.owner ? accessPayload() : null]);
  res.json({ elevation: auth.elevate(u), minutes: 15, access: payload || undefined });
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
       <p><a href="${cfg.appUrl}/?view=approvals">Review it</a></p>`, { userId: u.id, kind: 'approval' });
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
  } else if (b.status && b.status !== current.status && current.status === 'pending' && !req.user.perms.approvals) {
    return res.status(403).json({ error: 'Your account cannot approve rings. Ask the owner.' });
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
    chunk(ringIds, 20).map(batch => zoho.coql(queries.groupMembersFor(batch)))
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
    chunk([...byContact.keys()], 50).map(batch => zoho.coql(queries.contactsByIds(batch)))
  );
  const contacts = contactBatches.flat();
  const tiers = await membershipsByContact();
  res.json(contacts.map(c => {
    const m = withMembership(fromZoho.member(c), tiers);
    const link = byContact.get(c.id) || {};
    return { ...m, ringIds: link.ringIds || [], ringNames: link.ringNames || [], roles: link.roles || [] };
  }));
}));

/**
 * Each member's membership (Zoho "Memberships", the renamed Deals module):
 * the tier — Seedling, Sapling, Mighty Oak, Bookshelf — and the real renewal
 * date. The contact's own "type" only ever says "Member". One read for all.
 */
async function membershipsByContact() {
  const rows = await zoho.coql(`select Contact_Name, Membership_Tier, Stage, Renewal_Date, Expiry_Date, Start_Date
    from Deals where Contact_Name is not null limit 200`).catch(() => []);
  const rank = s => /active/i.test(s || '') ? 3 : /new|invoice/i.test(s || '') ? 2 : 1;   // the current one wins
  const by = new Map();
  rows.forEach(d => {
    const id = d.Contact_Name?.id;
    if (!id) return;
    const cur = by.get(id);
    if (!cur || rank(d.Stage) > rank(cur.Stage) || (rank(d.Stage) === rank(cur.Stage) && String(d.Start_Date || '') > String(cur.Start_Date || ''))) by.set(id, d);
  });
  return by;
}
function withMembership(m, by) {
  const d = by.get(m.id);
  if (!d) return m;
  return { ...m, tier: d.Membership_Tier || '', membershipStage: d.Stage || '',
    renewalDate: d.Renewal_Date || d.Expiry_Date || null };
}

/**
 * Members with no Growth Ring at all — Keturah's request #1.
 * Worked out by diffing active members against the join table, because
 * Contacts cannot be filtered on the group lookup.
 */
r.get('/members/no-ring', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  // Page the join table and the member list in parallel — these are the two
  // slowest calls in the app and they do not depend on each other.
  // Every row of each (paged inside zoho.coql). A failure is reported, not
  // turned into a shorter list that looks right.
  const [links, members] = await Promise.all([
    zoho.coql(queries.allGroupMembers()), zoho.coql(queries.allActiveMembers()),
  ]);
  const linkPages = [links], memberPages = [members];
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
  const tiers = await membershipsByContact();
  res.json(out.map(m => withMembership(m, tiers)));
}));

/** Events the office has flagged Show_on_Portal — requests #2 and #4. */
r.get('/events', auth.authRequired, wrap(async (req, res) => {
  const rows = await zoho.coql(queries.portalEvents());
  res.json(rows.map(fromZoho.event));
}));

/**
 * Registrations for one event, with every guest.
 *
 * Fetched through the search API, NOT COQL. Symbiz keep guest details in a
 * `Guests` subform on the registration — name, type, business, email, phone,
 * address — and COQL cannot read subforms, so it returned nothing for them.
 * Only one registration in forty-six has the flat Guest_* fields filled; the
 * rest are all subform. Both are read below.
 */
/** Every guest row for one event, paging past COQL's 200-row limit. */
async function guestsForEvent(eventId) {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const page = await zoho.coql(
      `select Guest_First_Name, Guest_Last_Name, Guest_Type, Guest_Organization, Guest_Email, Guest_Phone,
              Guest_City, Guest_State, Guest_Street, Guest_Zip_Code, Guest_Attended, Registration_Status,
              Same_As_Main_Registrant, Parent_Id
       from Guests where Parent_Id.Event = '${eventId}' limit ${offset}, 200`);
    out.push(...page);
    if (page.length < 200) break;
  }
  return out;
}

r.get('/events/:id/registrations', auth.authRequired, wrap(async (req, res) => {
  const eventId = String(req.params.id).replace(/[^0-9]/g, '');
  /**
   * Guests are read straight from the Guests subform, all of an event's in
   * one query. Zoho's list and search APIs never return subform rows — only
   * a one-record fetch does — so every guest used to arrive nameless
   * ("guest name not in Zoho") even though Zoho had the name.
   */
  const [rows, guestRows] = await Promise.all([
    zoho.getRecords(M.REGISTRATION, { criteria: `(Event:equals:${eventId})`, perPage: 200 })
      .catch(() => zoho.coql(queries.registrationsFor(eventId)).catch(() => [])),
    guestsForEvent(eventId).catch(e => { console.error('[registrations] guests query failed:', e.message); return []; }),
  ]);
  const guestsByReg = {};
  guestRows.forEach(g => { const id = g.Parent_Id?.id; if (id) (guestsByReg[id] = guestsByReg[id] || []).push(g); });

  res.json((rows || []).map(z => {
    const base = fromZoho.registration(z);

    // Guests from the subform, then the flat fields as a fallback.
    const sub = guestsByReg[z.id] || (Array.isArray(z.Guests) ? z.Guests : []);
    const nameOf = g => [g.Guest_First_Name, g.Guest_Last_Name].filter(Boolean).join(' ').trim();
    // A row ticked "Same as main registrant" is the registrant themselves, entered
    // on the guest list with the name left blank. Shown as a nameless guest, it
    // looked like the registrant was missing. Use it for their name if the
    // registration has none, and don't list them a second time as a guest.
    if (!base.name) {
      const self = sub.find(g => g.Same_As_Main_Registrant === true && nameOf(g)) || null;
      if (self) base.name = nameOf(self);
    }
    // Still no name: say which record it is, so it can be found and fixed in Zoho
    if (!base.name) base.name = base.ref ? `No name in Zoho (registration ${base.ref})` : 'No name in Zoho';
    const guests = sub.filter(g => !(g.Same_As_Main_Registrant === true)).map(g => ({
      name: nameOf(g),
      type: g.Guest_Type || 'Guest',
      business: g.Guest_Organization || '',
      email: g.Guest_Email || '',
      phone: g.Guest_Phone || '',
      city: g.Guest_City || '',
      state: g.Guest_State || '',
      address: [g.Guest_Street, g.Guest_City, g.Guest_State, g.Guest_Zip_Code].filter(Boolean).join(', '),
      attended: g.Guest_Attended || '',
      status: g.Registration_Status || '',
      sameAsRegistrant: g.Same_As_Main_Registrant === true,
    }));

    if (!guests.length && base.bringingGuest && base.guestName) {
      guests.push({
        name: base.guestName, type: base.guestType || 'Guest',
        business: base.guestBusiness || '', email: base.guestEmail || '',
        phone: base.guestPhone || '', city: base.guestCity || '',
        address: '', attended: base.guestAttended || '', status: '',
      });
    }
    // Someone marked as bringing a guest with no detail recorded anywhere
    if (!guests.length && base.bringingGuest) {
      guests.push({ name: '', type: base.guestType || 'Guest', business: '',
                    email: '', phone: '', city: '', address: '', attended: '', status: '' });
    }

    return { ...base, guests, guestCount: guests.length };
  }));
}));

/**
 * Leads from an event's guest list (Mel). Each person becomes a Lead in Zoho,
 * noted as met at the event and whose guest they were. Anyone already in Zoho
 * as a lead (same email, phone or name) or as a member (same email) is skipped.
 */
r.post('/events/:id/leads', auth.authRequired, auth.requireOffice, writesAllowed, wrap(async (req, res) => {
  if (!(req.user.perms.approvals || req.user.perms.members)) return res.status(403).json({ error: 'Your account cannot add leads. Ask the owner.' });
  const eventId = String(req.params.id).replace(/[^0-9]/g, '');
  const people = (Array.isArray(req.body?.people) ? req.body.people : []).slice(0, 300);
  if (!people.length) return res.status(400).json({ error: 'Nobody was picked' });
  const ev = await zoho.getRecord(M.EVENT, eventId).catch(() => null);
  const eventName = ev ? ev.Name : 'an event';
  const clean = (v, n) => String(v || '').trim().slice(0, n || 120);
  const sq = v => String(v).replace(/'/g, "\\'");
  const created = [], skipped = [], failed = [], toMake = [];
  for (const p of people) {
    const name = clean(p.name), email = clean(p.email, 200).toLowerCase(), phone = clean(p.phone, 40);
    if (!name) continue;
    const words = name.split(/\s+/), lastName = words.length > 1 ? words.pop() : words[0], firstName = words.length ? words.join(' ') : '';
    // Already in Zoho?
    let why = null;
    try {
      if (email) {
        if ((await zoho.coql(`select id from Leads where Email = '${sq(email)}' limit 1`).catch(() => [])).length) why = 'already a lead (same email)';
        else if ((await zoho.coql(`select id from ${M.CONTACT} where Email = '${sq(email)}' limit 1`).catch(() => [])).length) why = 'already in Zoho as a member or contact (same email)';
      }
      if (!why && phone && (await zoho.coql(`select id from Leads where Phone = '${sq(phone)}' limit 1`).catch(() => [])).length) why = 'already a lead (same phone)';
      if (!why && (await zoho.coql(`select id from Leads where Full_Name = '${sq(name)}' limit 1`).catch(() => [])).length) why = 'already a lead (same name)';
    } catch (_) { /* a check that fails never blocks the lead */ }
    if (why) { skipped.push({ name, why }); continue; }
    const how = p.guestOf ? `${clean(p.type, 40) || 'Guest'} of ${clean(p.guestOf)}` : clean(p.type, 60) || 'Registered';
    toMake.push({ name, record: toZoho.lead({ firstName, lastName, company: clean(p.business) || undefined, email: email || undefined,
      phone: phone || undefined, city: clean(p.city, 60) || undefined, state: clean(p.state, 30) || undefined,
      notes: `Met at ${eventName} (${how}). Added from Rep Hub by ${req.user.name}.` }) });
  }
  if (toMake.length) {
    const out = await zoho.insertRecords('Leads', toMake.map(x => x.record)).catch(e => toMake.map(() => ({ message: e.message })));
    toMake.forEach((x, i) => {
      const r0 = out[i];
      if (r0 && (r0.code === 'SUCCESS' || r0.status === 'success')) created.push({ name: x.name, id: r0.details && r0.details.id });
      else failed.push({ name: x.name, why: (r0 && r0.message) || 'Zoho did not accept it' });
    });
  }
  await audit(req.user.id, 'event.leadsFromGuests', { eventId, created: created.length, skipped: skipped.length, failed: failed.length }, req.ip);
  res.json({ created, skipped, failed });
}));

/**
 * Growth Ring visit schedule — Keturah's request #4.
 * Combines the Last/Next Rep Visit dates held on each ring with the visits
 * already logged in Rep_Visit_Trackings.
 */
r.get('/visits', auth.authRequired, wrap(async (req, res) => {
  const [{ rings, ringIds }, planRows] = await Promise.all([scopeRings(req.user, req.query.as), q.visitPlans().catch(() => [])]);
  const plans = new Map(planRows.map(p => [p.ring_id, p]));
  const out = [];

  rings.forEach(r => {
    // The date lives on the ring in Zoho; the time, place and notes typed in Rep Hub
    const plan = plans.get(r.id);
    const same = plan && String(plan.visit_date instanceof Date ? plan.visit_date.toISOString() : plan.visit_date).slice(0, 10) === String(r.nextRepVisit || '').slice(0, 10);
    if (r.nextRepVisit) out.push({
      id: `next_${r.id}`, ringId: r.id, ringName: r.name, repZohoId: r.repZohoId,
      date: r.nextRepVisit, status: 'Scheduled', source: 'ring',
      time: same ? plan.visit_time || '' : '', location: same && plan.location ? plan.location : (r.regionName || ''),
      notes: same ? plan.notes || '' : '',
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
  // The real field is Meeting_Datetime (there is no Meeting_Date or Notes), so
  // the old query failed every time and the calendar never showed a ring
  // meeting. Four months back and everything ahead.
  const since = `${addDays(today(), -120)}T00:00:00+00:00`;
  const batches = await Promise.all(
    chunk(ringIds, 20).map(b => zoho.coql(
      `select id, Name, Growth_Ring_Group, Meeting_Datetime, Meeting_Status, Meeting_Location, Other_City, Other_State,
              Growth_Ring_Meeting_Link, Internal_Meeting_Notes, Regional_Rep
       from ${M.MEETING}
       where Growth_Ring_Group in (${b.map(i => `'${String(i).replace(/'/g,'')}'`).join(',')}) and Meeting_Datetime >= '${since}'
       order by Meeting_Datetime desc limit 200`
    ))
  );
  // Zoho stores the moment; the groups meet on US Eastern time
  const eastern = iso => {
    const d = new Date(iso);
    if (isNaN(d)) return { date: String(iso || '').slice(0, 10), time: '' };
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true })
      .formatToParts(d).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}` };
  };
  res.json(batches.flat().filter(z => z.Meeting_Datetime).map(z => {
    const when = eastern(z.Meeting_Datetime);
    const status = String(z.Meeting_Status || '');
    return {
      id: z.id,
      ringId: z.Growth_Ring_Group?.id || null,
      ringName: z.Growth_Ring_Group?.name || '',
      date: when.date, time: when.time,
      // Completed / Complete, Scheduled, Tentative, Cancelled / Canceled
      status: /^complete/i.test(status) ? 'held' : /^cancel/i.test(status) ? 'cancelled' : 'planned',
      place: [z.Other_City, z.Other_State].filter(Boolean).join(', ')
        || (z.Meeting_Location === 'Host Address' ? "At the host's home" : (z.Meeting_Location || '')),
      link: z.Growth_Ring_Meeting_Link || '',
      notes: z.Internal_Meeting_Notes || '',
      repZohoId: z.Regional_Rep?.id || null,
    };
  }));
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
/**
 * Every active member on a map — Mel's request. Positions come from the
 * geocodes table; addresses not placed yet are looked up in the background
 * and appear on the next load.
 */
const geo = require('./lib/geocode');
async function activeMemberAddresses() {
  const contacts = await zoho.coql(queries.allActiveMembers());
  return contacts.map(fromZoho.member).filter(m => /^active$/i.test(m.status))
    .map(m => ({ ...m, state: m.region }));
}
let mapCache = null;
/* The office with Members access sees every member; a rep sees only the
   members of their own rings (decided here, never in the browser). */
function mapGuard(req, res, next) {
  if (req.user.role === 'rep') return req.user.zoho_owner_id ? next() : res.status(403).json({ error: 'Your login is not linked to a Zoho contact yet' });
  if (!req.user.perms || !req.user.perms.members) return res.status(403).json({ error: 'Your account does not have access to members. Ask the owner.' });
  next();
}
const forViewer = (req, body) => req.user.role !== 'rep' ? body : (() => {
  const mine = body.members.filter(m => (m.repIds || []).includes(req.user.zoho_owner_id));
  return { ...body, members: mine, located: mine.filter(m => m.lat != null).length, total: mine.length,
    noAddress: undefined, pending: mine.filter(m => m.lat == null && m.address).length ? body.pending : 0 };
})();
r.get('/members/map', auth.authRequired, mapGuard, wrap(async (req, res) => {
  // Built from five Zoho lists, so kept ready: 5 minutes, or 1 while addresses
  // are still being placed so new pins keep appearing
  if (mapCache && req.query.fresh !== '1' && Date.now() - mapCache.at < (mapCache.body.pending ? 60000 : 300000)) {
    return res.json(forViewer(req, mapCache.body));
  }
  const [members, links, ringRows, tiers, cached] = await Promise.all([
    activeMemberAddresses(), zoho.coql(queries.allGroupMembers()), zoho.coql(queries.ringsForRep(null)),
    membershipsByContact(), q.allGeocodes(),
  ]);
  const rings = new Map(ringRows.map(fromZoho.ring).map(r => [r.id, r]));
  const inRings = new Map();
  links.forEach(l => { const c = l.Members?.id, g = l.Growth_Ring_Groups?.id; if (c && g) (inRings.get(c) || inRings.set(c, []).get(c)).push(g); });
  const pos = new Map(cached.filter(r => r.lat != null).map(r => [r.address_key, r]));
  const out = members.map(m => {
    const p = pos.get(geo.keyOf(m));
    const rg = (inRings.get(m.id) || []).map(id => rings.get(id)).filter(Boolean);
    const t = tiers.get(m.id);
    return { id: m.id, name: m.name, business: m.business, address: m.address, phone: m.phone,
      lat: p ? p.lat : null, lng: p ? p.lng : null, tier: t ? t.Membership_Tier || '' : '',
      rings: rg.map(r => r.name), rep: rg[0] ? (rg[0].repName || '') : '', repId: rg[0] ? (rg[0].repZohoId || null) : null,
      repIds: [...new Set(rg.map(r => r.repZohoId).filter(Boolean))] };
  });
  const pending = geo.missing(members, new Map(cached.map(r => [r.address_key, r]))).length;
  const site = netlifySite(req);
  // Place the rest without making anyone wait
  if (pending) {
    if (site) await kickBackground(site, 'geocode-background');
    else await geo.geocodeMissing(members, { budgetMs: 4000 }).catch(e => console.error('[geocode]', e.message));
  }
  const body = { members: out, located: out.filter(m => m.lat != null).length, total: out.length,
    noAddress: members.filter(m => !geo.hasAddress(m)).length, pending, at: new Date().toISOString() };
  // Placed here and now (no background worker): this answer is already stale
  if (!pending || site) mapCache = { at: Date.now(), body };
  res.json(forViewer(req, body));
}));

/* ═══════════ SUMMITS (Mel: history, planning, checklists, forms) ═══════════
 * The summits themselves live in Zoho (Symbiz_Events, Regional and Global
 * Summit). The planning around them — checklist, forms and documents, notes
 * on what to do differently — is kept here, per summit. */
const SUMMIT_TYPES = ['Regional Summit', 'Global Summit'];
/* Every new summit starts from this list. Days are relative to the summit. */
/* Mel's Regional Summit Planning Checklist (his Google Sheet, Oct 2026),
   with each deadline turned into days before the summit (his sheet was laid
   out for a summit on 11/4/2025). [stage, days from the summit, task] */
const SUMMIT_CHECKLIST = [
  ['4–6 months prior', -120, 'Schedule facility'],
  ['4–6 months prior', -120, 'Schedule caterer'],
  ['4–6 months prior', -120, 'Determine a theme'],
  ['4–6 months prior', -120, 'Moderator'],
  ['1–3 months prior', -70, 'Create invitations & tickets'],
  ['1–3 months prior', -60, 'MINTalk #1 speaker and topic'],
  ['1–3 months prior', -60, 'MINTalk #2 speaker and topic'],
  ['1–3 months prior', -60, 'MINTalk #3 speaker and topic'],
  ['1–3 months prior', -60, 'Growth Ring Experience leader'],
  ['1–3 months prior', -60, 'Panel moderator'],
  ['1–3 months prior', -60, 'Panel questions'],
  ['1–3 months prior', -60, 'Send out invitations & tickets'],
  ['1–3 months prior', -45, '3–5 panelists'],
  ['1–3 months prior', -45, 'Marketing'],
  ['1–3 months prior', null, 'Sponsorships'],
  ['1–4 weeks prior', -30, 'Greeter'],
  ['1–4 weeks prior', -15, 'Name tags (to be written on), agenda'],
  ['1–4 weeks prior', -15, 'Sound system / recordings / projector — record MINTalk audio, compile master slide deck'],
  ['1–4 weeks prior', -15, 'Registration complete'],
];
/* The standard list every new summit starts from. Rep Hub ships with the one
   above; the office can replace it with Symbiz's own (Summits → edit the
   standard checklist), and that is what new summits then use. */
/* ── The checklist kept in a Google Sheet (Mel's), read again every hour ──
   The sheet must be shared "Anyone with the link can view": Rep Hub reads it
   as a CSV export, with no Google sign-in. Laid out like Mel's: a "Date" row
   (the summit it was planned for), then Status / Deadline / Action / Action
   Owner / Note columns. Deadlines become days before the summit. */
function sheetCsvUrl(url) {
  const m = String(url || '').match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => String(x).trim()));
}
function sheetDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
const stageFor = off => off == null ? 'Anytime before' : off <= -120 ? '4–6 months prior' : off <= -31 ? '1–3 months prior'
  : off <= -8 ? '1–4 weeks prior' : off < 0 ? '1–7 days prior' : off === 0 ? 'Day of' : 'After';
function checklistFromCsv(text) {
  const rows = parseCsv(text);
  const h = rows.findIndex(r => r.some(x => /^action$/i.test(x)) && r.some(x => /^deadline$/i.test(x)));
  if (h < 0) throw new Error('The sheet needs a header row with "Deadline" and "Action" columns');
  const col = re => rows[h].findIndex(x => re.test(x));
  const cD = col(/^deadline$/i), cA = col(/^action$/i), cO = col(/owner/i), cN = col(/^note/i);
  const dateRow = rows.slice(0, h).find(r => /^date$/i.test(r[0] || ''));
  const base = dateRow ? dateRow.slice(1).map(sheetDate).find(Boolean) : null;
  const days = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
  const list = rows.slice(h + 1).filter(r => (r[cA] || '').trim()).map(r => {
    const due = sheetDate(r[cD]);
    const off = due && base ? days(due, base) : null;
    const note = cN >= 0 ? r[cN] : '';
    return { title: (r[cA] + (note ? ' — ' + note : '')).slice(0, 300), stage: stageFor(off), dueOffset: off,
      owner: cO >= 0 && r[cO] ? r[cO].slice(0, 120) : undefined };
  });
  if (!list.length) throw new Error('No tasks found under the "Action" column');
  return list;
}
async function syncChecklistSheet(url) {
  const csv = sheetCsvUrl(url);
  if (!csv) throw new Error('That is not a Google Sheets link');
  const res = await fetch(csv, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  if (!res.ok || /^\s*<!doctype html/i.test(text)) throw new Error('Rep Hub cannot open the sheet. In Google Sheets press Share and set General access to "Anyone with the link" (Viewer).');
  const list = checklistFromCsv(text);
  await q.setSetting('summit_sheet_cache', JSON.stringify({ at: Date.now(), list, error: null }));
  return list;
}
async function summitTemplate() {
  const sheet = await setting('summit_sheet_url', '');
  if (sheet) {
    let cache = null; try { cache = JSON.parse(await setting('summit_sheet_cache', 'null')); } catch { cache = null; }
    if (!cache || Date.now() - cache.at > 3600000) {
      try { const list = await syncChecklistSheet(sheet); cache = { at: Date.now(), list, error: null }; }
      catch (e) {
        cache = { ...(cache || { list: [] }), at: Date.now(), error: e.message };
        await q.setSetting('summit_sheet_cache', JSON.stringify(cache)).catch(() => {});
      }
    }
    if (cache && cache.list && cache.list.length) return { list: cache.list, custom: true, source: 'sheet', sheet, syncedAt: cache.at, error: cache.error };
    // The sheet could not be read: fall back, and say why
    const fallback = SUMMIT_CHECKLIST.map(([stage, dueOffset, title]) => ({ stage, dueOffset, title }));
    return { list: fallback, custom: false, source: 'sheet', sheet, error: cache && cache.error };
  }
  const raw = await setting('summit_checklist', '');
  try {
    const list = JSON.parse(raw || 'null');
    if (Array.isArray(list) && list.length) return { list, custom: true };
  } catch { /* fall back to the built-in list */ }
  return { list: SUMMIT_CHECKLIST.map(([stage, dueOffset, title]) => ({ stage, dueOffset, title })), custom: false };
}
function toEastern(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { date: String(iso || '').slice(0, 10), time: '' };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute} ${p.dayPeriod}` };
}
let summitCache = null;
/* The summits from Zoho. They change a few times a year, so the list is kept
   in the database for every copy of the server to share, for 15 minutes. When
   it is older, Zoho is asked, but a busy Zoho (the Overview fires a dozen
   requests at once) is not waited on for more than a few seconds: the saved
   list is shown instead, and the fresh one is saved as soon as it arrives. */
async function summitEvents(fresh) {
  if (!fresh && summitCache && Date.now() - summitCache.at < 300000) return summitCache.rows;
  let saved = null;
  try { saved = JSON.parse(await setting('summit_events_cache', 'null')); } catch { saved = null; }
  if (!fresh && saved && Array.isArray(saved.rows) && Date.now() - saved.at < 15 * 60000) { summitCache = saved; return saved.rows; }
  const live = zoho.coql(`select id, Name, Event_Type, Event_Date_and_Time, Event_City, Event_State, Event_Venue,
      Registration_Count, Total_Registered_People, Attendance_Count, Event_Status
    from ${M.EVENT} where Event_Type in (${SUMMIT_TYPES.map(t => `'${t}'`).join(',')}) limit 200`).then(rows => {
    const out = rows.filter(e => !/\btest\b/i.test(e.Name || '')).map(e => {
      const when = toEastern(e.Event_Date_and_Time);
      return { id: e.id, name: e.Name, type: e.Event_Type, date: when.date, time: when.time,
        city: String(e.Event_City || '').replace(/,\s*$/, ''), state: e.Event_State || '', venue: e.Event_Venue || '',
        registered: e.Total_Registered_People ?? e.Registration_Count ?? null, attended: e.Attendance_Count ?? null,
        status: e.Event_Status || '' };
    }).sort((a, b) => b.date.localeCompare(a.date));
    summitCache = { at: Date.now(), rows: out };
    q.setSetting('summit_events_cache', JSON.stringify(summitCache)).catch(() => {});
    return out;
  });
  if (fresh || !saved || !Array.isArray(saved.rows)) return live;
  live.catch(() => {});
  return Promise.race([live.catch(() => saved.rows), new Promise(r => setTimeout(() => r(saved.rows), 3000))]);
}
const summitGuard = [auth.authRequired, auth.requireOffice, access.requirePerm('summits')];

r.get('/summits', ...summitGuard, wrap(async (req, res) => {
  const [events, rows, notes] = await Promise.all([summitEvents(req.query.fresh === '1'), q.summitTaskRows(), q.allSummitNotes()]);
  const byEvent = new Map();
  rows.forEach(t => { if (!byEvent.has(t.event_id)) byEvent.set(t.event_id, []); byEvent.get(t.event_id).push(t); });
  const n = new Set(notes.filter(x => x.notes).map(x => x.event_id)), t0 = today();
  res.json(events.map(e => {
    const ts = byEvent.get(e.id) || [];
    const open = ts.filter(t => !t.done).map(t => ({ title: t.title, owner: t.owner, due: t.due_offset == null ? null : addDays(e.date, t.due_offset) }));
    const next = open.filter(t => t.due).sort((a, b) => a.due.localeCompare(b.due))[0] || open[0] || null;
    return { ...e, tasksDone: ts.length - open.length, tasksTotal: ts.length, hasNotes: n.has(e.id),
      tasksLate: open.filter(t => t.due && t.due < t0).length, nextTask: next };
  }));
}));

r.get('/summits/:id', ...summitGuard, wrap(async (req, res, next) => {
  if (req.params.id === 'mine' || req.params.id === 'template') return next();     // declared further down
  let events = await summitEvents();
  let e = events.find(x => x.id === req.params.id);
  // Added in Zoho since the list was last read: look again before saying no
  if (!e) { events = await summitEvents(true); e = events.find(x => x.id === req.params.id); }
  if (!e) return res.status(404).json({ error: 'That summit was not found in Zoho' });
  let [tasks, links, notes, allNotes] = await Promise.all([q.summitTasks(e.id), q.summitLinks(e.id), q.summitNotes(e.id), q.allSummitNotes()]);
  if (!tasks.length) {
    // First time it is opened: start from the standard checklist, in one write
    await q.addSummitTasks(e.id, (await summitTemplate()).list.map((t, i) => ({ ...t, position: i })));
    tasks = await q.summitTasks(e.id);
  }
  const notesBy = new Map(allNotes.map(x => [x.event_id, x.notes]));
  // History: earlier summits in the same state (or of the same kind), with what was learned
  const history = events.filter(x => x.id !== e.id && x.date < e.date && (x.state === e.state || (!e.state && x.type === e.type)))
    .map(x => ({ ...x, notes: notesBy.get(x.id) || '' }));
  res.json({ summit: e, tasks, links, notes: notes ? notes.notes : '', notesBy: notes ? notes.updated_by : null,
    notesAt: notes ? notes.updated_at : null, history });
}));

/* Who can be given a summit task: the office people who can see Summits.
   Anyone else (a volunteer, the venue) can still be typed in by name. */
async function summitTeam() {
  const users = (await q.allUsers()).filter(u => u.role !== 'rep');
  const out = [];
  for (const u of users) if ((await access.permsFor(u)).summits) out.push({ id: u.id, name: u.name, email: u.email });
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
/** "Who": a person from the team (by id), or any name typed in */
async function resolveOwner(b) {
  if (b.ownerId) {
    const p = (await summitTeam()).find(x => x.id === String(b.ownerId));
    if (p) return { owner: p.name, ownerId: p.id, person: p };
  }
  const name = String(b.owner || '').trim().slice(0, 120);
  return { owner: name || null, ownerId: null, person: null };
}
/** Tell someone a task is theirs, unless they gave it to themselves */
async function tellOwner(person, task, eventId, req) {
  if (!person || person.id === req.user.id || !person.email) return;
  const e = (await summitEvents()).find(x => x.id === eventId);
  const nice = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const dueIso = e && task.dueOffset != null ? addDays(e.date, task.dueOffset) : null;
  const due = dueIso ? nice(dueIso) + (dueIso < today() ? ' (already past)' : '') : null;
  const esc2 = v => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  reminders.sendEmail(person.email, `Summit task for you: ${task.title}`,
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#1E2A20;max-width:520px">
      <p>${esc2((person.name || '').split(' ')[0] || 'Hello')},</p>
      <p>${esc2(req.user.name || 'The office')} has given you a task for <strong>${esc2(e ? e.name : 'a summit')}</strong>${e && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(e.name) ? ' on ' + esc2(nice(e.date)) : ''}:</p>
      <p style="font-size:16px;background:#F2F5EC;border-radius:8px;padding:12px 14px"><strong>${esc2(task.title)}</strong>${due ? '<br><span style="color:#5A6455">Due ' + esc2(due) + '</span>' : ''}</p>
      <p><a href="${siteUrl(req)}/?summit=${encodeURIComponent(eventId)}" style="background:#2E5132;color:#fff;padding:9px 15px;border-radius:7px;text-decoration:none">Open this summit in Rep Hub</a></p>
      <p style="color:#8A9284;font-size:12px">It also shows in your notifications as the due date gets close.</p></div>`,
    { userId: person.id, kind: 'summit-task', replyTo: req.user.email }).catch(() => {});
}

r.get('/summits/template', ...summitGuard, wrap(async (req, res) => {
  const t = await summitTemplate();
  const by = t.custom ? await q.getSetting('summit_checklist_by').catch(() => null) : null;
  res.json({ ...t, by: by ? by.value : null, sheet: t.sheet || (await setting('summit_sheet_url', '')) || null });
}));
r.put('/summits/template', ...summitGuard, wrap(async (req, res) => {
  const list = (Array.isArray(req.body?.list) ? req.body.list : [])
    .map(t => ({ title: String(t.title || '').trim().slice(0, 300), stage: String(t.stage || '').trim().slice(0, 60) || 'Other',
      dueOffset: t.dueOffset === '' || t.dueOffset == null || isNaN(parseInt(t.dueOffset, 10)) ? null : Math.max(-730, Math.min(365, parseInt(t.dueOffset, 10))) }))
    .filter(t => t.title).slice(0, 100);
  if (!list.length) return res.status(400).json({ error: 'The list needs at least one task' });
  await q.setSetting('summit_checklist', JSON.stringify(list));
  await q.setSetting('summit_checklist_by', `${req.user.name || req.user.email}, ${today()}`);
  await audit(req.user.id, 'summit.templateSaved', { tasks: list.length }, req.ip);
  res.json({ list, custom: true });
}));
/* Follow a Google Sheet for the standard list (or stop following it) */
r.put('/summits/template/sheet', ...summitGuard, wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!sheetCsvUrl(url)) return res.status(400).json({ error: 'Paste the link to the Google Sheet' });
  let list;
  try { list = await syncChecklistSheet(url); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  await q.setSetting('summit_sheet_url', url);
  await audit(req.user.id, 'summit.templateSheet', { url, tasks: list.length }, req.ip);
  res.json(await summitTemplate());
}));
r.post('/summits/template/sheet/sync', ...summitGuard, wrap(async (req, res) => {
  const url = await setting('summit_sheet_url', '');
  if (!url) return res.status(400).json({ error: 'No sheet is linked' });
  try { await syncChecklistSheet(url); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(await summitTemplate());
}));
r.delete('/summits/template/sheet', ...summitGuard, wrap(async (req, res) => {
  await q.setSetting('summit_sheet_url', '');
  await q.setSetting('summit_sheet_cache', '');
  res.json(await summitTemplate());
}));
r.delete('/summits/template', ...summitGuard, wrap(async (req, res) => {
  await q.setSetting('summit_checklist', '');
  await audit(req.user.id, 'summit.templateReset', null, req.ip);
  res.json(await summitTemplate());
}));
/* Start one summit again from the standard list: only while nothing on it is done */
r.post('/summits/:id/tasks/restart', ...summitGuard, wrap(async (req, res) => {
  const tasks = await q.summitTasks(req.params.id);
  if (tasks.some(t => t.done)) return res.status(409).json({ error: 'Some tasks are already ticked off, so the list is kept. Add or remove tasks instead.' });
  await q.clearSummitTasks(req.params.id);
  await q.addSummitTasks(req.params.id, (await summitTemplate()).list.map((t, i) => ({ ...t, position: i })));
  await audit(req.user.id, 'summit.checklistRestarted', { id: req.params.id }, req.ip);
  res.json(await q.summitTasks(req.params.id));
}));

r.get('/summits/mine', ...summitGuard, wrap(async (req, res) => {
  const [team, mine, events] = await Promise.all([summitTeam(), q.summitTasksFor(req.user.id), summitEvents()]);
  const byId = new Map(events.map(e => [e.id, e]));
  res.json({ team, tasks: mine.filter(t => byId.has(t.event_id)).map(t => { const e = byId.get(t.event_id);
    return { id: t.id, title: t.title, eventId: e.id, summit: e.name, summitDate: e.date,
      due: t.due_offset == null ? null : addDays(e.date, t.due_offset) }; })
    .sort((a, b) => String(a.due || a.summitDate).localeCompare(String(b.due || b.summitDate))) });
}));

r.post('/summits/:id/tasks', ...summitGuard, wrap(async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'What needs doing?' });
  const n = (await q.summitTasks(req.params.id)).length;
  const dueOffset = req.body?.dueOffset === '' || req.body?.dueOffset == null ? null : parseInt(req.body.dueOffset, 10);
  const who = await resolveOwner(req.body || {});
  const task = { eventId: req.params.id, title, stage: 'Added', dueOffset: isNaN(dueOffset) ? null : dueOffset,
    owner: who.owner, ownerId: who.ownerId, position: n + 100 };
  await q.addSummitTask(task);
  if (req.body?.notify !== false) tellOwner(who.person, task, req.params.id, req);
  res.json(await q.summitTasks(req.params.id));
}));
r.patch('/summits/:id/tasks/:taskId', ...summitGuard, wrap(async (req, res) => {
  const cur = (await q.summitTasks(req.params.id)).find(t => String(t.id) === String(req.params.taskId));
  if (!cur) return res.status(404).json({ error: 'No such task' });
  const b = req.body || {};
  const changingWho = b.owner !== undefined || b.ownerId !== undefined;
  const who = changingWho ? await resolveOwner(b) : { owner: cur.owner, ownerId: cur.owner_id, person: null };
  await q.updateSummitTask(cur.id, req.params.id, {
    title: b.title != null ? String(b.title).slice(0, 300) : null,
    owner: who.owner, ownerId: who.ownerId,
    dueOffset: b.dueOffset !== undefined ? (b.dueOffset === '' || b.dueOffset == null ? null : parseInt(b.dueOffset, 10)) : cur.due_offset,
    done: b.done !== undefined ? !!b.done : cur.done, doneBy: req.user.name,
  });
  // The person asked whether to email them; a "no" (say, a slip of the list) sends nothing
  if (changingWho && who.ownerId && who.ownerId !== cur.owner_id && b.notify !== false) {
    tellOwner(who.person, { title: cur.title, dueOffset: cur.due_offset }, req.params.id, req);
  }
  res.json(await q.summitTasks(req.params.id));
}));
r.delete('/summits/:id/tasks/:taskId', ...summitGuard, wrap(async (req, res) => {
  await q.deleteSummitTask(parseInt(req.params.taskId, 10), req.params.id);
  res.json(await q.summitTasks(req.params.id));
}));
r.post('/summits/:id/links', ...summitGuard, wrap(async (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 200), url = String(req.body?.url || '').trim().slice(0, 1000);
  if (!label || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Give it a name and a link starting with https://' });
  await q.addSummitLink(req.params.id, label, url, req.user.name);
  res.json(await q.summitLinks(req.params.id));
}));
r.delete('/summits/:id/links/:linkId', ...summitGuard, wrap(async (req, res) => {
  await q.deleteSummitLink(parseInt(req.params.linkId, 10), req.params.id);
  res.json(await q.summitLinks(req.params.id));
}));
r.put('/summits/:id/notes', ...summitGuard, wrap(async (req, res) => {
  await q.saveSummitNotes(req.params.id, String(req.body?.notes || '').slice(0, 20000), req.user.name);
  res.json({ ok: true });
}));

/**
 * Retention, from Zoho Memberships (start and end dates), not the contact's
 * Inactive flag — which has no date, so "left this year" was unanswerable.
 *   left       = members with no current membership whose last one ended this year
 *   retention  = of the members whose membership was running on 1 January,
 *                the share still a member now
 */
let retentionCache = null;
r.get('/stats/retention', auth.authRequired, auth.requireOffice, access.requirePerm('reports'), wrap(async (req, res) => {
  // Membership history changes a few times a month; reading every membership
  // from Zoho on each visit was the slow part. Kept 10 minutes unless asked fresh.
  if (retentionCache && Date.now() - retentionCache.at < 600000 && req.query.fresh !== '1') return res.json(retentionCache.body);
  const yr = String(new Date().getFullYear()), jan1 = `${yr}-01-01`;
  const [deals, joins] = await Promise.all([
    zoho.coql(`select Contact_Name, Membership_Tier, Stage, Start_Date, Expiry_Date, Reason_For_Loss__s
      from Deals where Contact_Name is not null limit 200`),
    zoho.coql(`select id, Full_Name, Paid_Membership_StartDate from Contacts
      where (Active = true and Status = 'Active') and Paid_Membership_StartDate >= '${jan1}' limit 200`),
  ]);
  const isTest = n => /\btest\b/i.test(n || '');
  const live = s => !/inactive/i.test(s || '');             // Closed Won/Active, New, Invoice Generated…
  const byContact = new Map();
  deals.forEach(d => {
    const id = d.Contact_Name?.id; if (!id || isTest(d.Contact_Name?.name)) return;
    (byContact.get(id) || byContact.set(id, { name: d.Contact_Name.name, deals: [] }).get(id)).deals.push(d);
  });
  const left = [], leftNoDate = [], tiers = {};
  let base = 0, retained = 0;
  for (const [id, c] of byContact) {
    const current = c.deals.some(d => live(d.Stage));
    const latest = c.deals.slice().sort((a, b) => String(b.Expiry_Date || b.Start_Date || '').localeCompare(String(a.Expiry_Date || a.Start_Date || '')))[0];
    if (current) {
      const t = (c.deals.find(d => live(d.Stage)) || {}).Membership_Tier || 'Not set';
      tiers[t] = (tiers[t] || 0) + 1;
    } else if (latest.Expiry_Date && latest.Expiry_Date >= jan1) {
      left.push({ id, name: c.name, tier: latest.Membership_Tier || '', ended: latest.Expiry_Date, reason: latest.Reason_For_Loss__s || '' });
    } else if (!latest.Expiry_Date) {
      leftNoDate.push({ id, name: c.name, tier: latest.Membership_Tier || '' });
    }
    // Running on 1 January: started before then (or no start recorded) and not ended before then
    const runningJan1 = c.deals.some(d => (!d.Start_Date || d.Start_Date < jan1) && (!d.Expiry_Date || d.Expiry_Date >= jan1));
    if (runningJan1) { base++; if (current) retained++; }
  }
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, joined: 0, left: 0 }));
  joins.forEach(c => { const m = Number(String(c.Paid_Membership_StartDate || '').slice(5, 7)); if (!isTest(c.Full_Name) && m) months[m - 1].joined++; });
  left.forEach(l => { const m = Number(l.ended.slice(5, 7)); if (l.ended.slice(0, 4) === yr && m) months[m - 1].left++; });
  const reasons = {};
  left.forEach(l => { const k = l.reason || 'Not recorded'; reasons[k] = (reasons[k] || 0) + 1; });
  const joinedList = joins.filter(c => !isTest(c.Full_Name))
    .map(c => ({ id: c.id, name: c.Full_Name, joined: c.Paid_Membership_StartDate,
      tier: (byContact.get(c.id)?.deals.find(d => live(d.Stage)) || {}).Membership_Tier || '' }))
    .sort((a, b) => String(b.joined).localeCompare(String(a.joined)));
  const body = {
    year: yr, at: new Date().toISOString(), joinedList,
    joined: joins.filter(c => !isTest(c.Full_Name)).length,
    left: left.length, leftNoDate: leftNoDate.length,
    retention: base ? Math.round(retained / base * 1000) / 10 : null, base, retained,
    activeMemberships: Object.values(tiers).reduce((s, n) => s + n, 0), tiers,
    months: months.filter(m => m.month <= new Date().getMonth() + 1),
    reasons, leftList: left.sort((a, b) => b.ended.localeCompare(a.ended)), leftNoDateList: leftNoDate,
  };
  retentionCache = { at: Date.now(), body };
  res.json(body);
}));

/** The Overview's headline numbers, counted by Zoho — the same figure every time. */
r.get('/stats', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const year = String(new Date().getFullYear());
  const n = rows => Number((rows && rows[0] && (rows[0]['COUNT(id)'] ?? rows[0].count)) || 0);
  const [active, inactive, joined] = await Promise.all(queries.memberCounts(year).map(qq => zoho.coql(qq)));
  res.json({ activeMembers: n(active), inactiveMembers: n(inactive), joinedThisYear: n(joined), year, at: new Date().toISOString() });
}));

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

/* ═══════════ MEMBERS OVER 60 DAYS IN A/R (Mel) ═══════════
 * Unpaid invoices more than 60 days past due, from Zoho Books, matched to
 * the member (Books customers carry the member's CRM name, "Name #1234")
 * and through their ring to the rep, who calls to find out where the
 * membership stands. Reps get only their own members. */
let arCache = null;          // { at, list }
const memberNo = n => { const m = String(n || '').match(/#\s*(\d+)/); return m ? m[1].replace(/^0+/, '') : null; };
async function arOver(days) {
  if (arCache && Date.now() - arCache.at < 10 * 60 * 1000 && arCache.days === days) return arCache.list;
  const [invoices, links, ringRows] = await Promise.all([
    books.overdueInvoices(), zoho.coql(queries.allGroupMembers()), zoho.coql(queries.ringsForRep(null)),
  ]);
  const rings = new Map(ringRows.map(fromZoho.ring).map(r => [r.id, r]));
  // Member number -> the contact and their rings
  const byNo = new Map(), byName = new Map();
  links.forEach(l => {
    const c = l.Members, g = l.Growth_Ring_Groups; if (!c || !c.id) return;
    const k = memberNo(c.name);
    const e = (k && byNo.get(k)) || byName.get(normName(c.name)) || { contactId: c.id, name: c.name, rings: [] };
    if (g && rings.has(g.id) && !e.rings.some(x => x.id === g.id)) e.rings.push(rings.get(g.id));
    if (k) byNo.set(k, e); byName.set(normName(c.name), e);
  });
  // Counted from the INVOICE date (Keturah: "60 days from the invoice date"),
  // not the due date, which put members 30 days later than Symbiz wants
  const t = today(), cutoff = addDays(t, -days), by = new Map();
  const dated = i => i.date || i.due;
  invoices.filter(i => i.balance > 0 && dated(i) && dated(i) <= cutoff && !/\btest\b/i.test(i.customer || '')).forEach(i => {
    if (!by.has(i.customer)) by.set(i.customer, { customer: i.customer, invoices: [], balance: 0 });
    const e = by.get(i.customer);
    e.invoices.push({ number: i.number, date: dated(i), due: i.due, balance: i.balance, days: -daysUntil(dated(i)) });
    e.balance += i.balance;
  });
  const list = [...by.values()].map(e => {
    const m = byNo.get(memberNo(e.customer)) || byName.get(normName(e.customer)) || null;
    const ring = m && m.rings[0];
    return { name: e.customer, contactId: m ? m.contactId : null, balance: Math.round(e.balance * 100) / 100,
      days: Math.max(...e.invoices.map(x => x.days)), invoices: e.invoices.sort((a, b) => String(a.date).localeCompare(String(b.date))),
      rings: m ? m.rings.map(r => r.name) : [], repId: ring ? ring.repZohoId : null, repName: ring ? ring.repName : null,
      repIds: m ? [...new Set(m.rings.map(r => r.repZohoId).filter(Boolean))] : [] };
  }).sort((a, b) => b.days - a.days || b.balance - a.balance);
  arCache = { at: Date.now(), days, list };
  return list;
}
r.get('/members/ar', auth.authRequired, wrap(async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days || '60', 10) || 60));
  if (!(await books.configured())) return res.json({ connected: false, days, members: [] });
  if (req.query.fresh === '1' || req.headers['x-fresh']) arCache = null;
  let list;
  try { list = await arOver(days); }
  catch (e) { return res.json({ connected: true, days, error: e.message, members: [] }); }
  if (req.user.role === 'rep') list = list.filter(m => req.user.zoho_owner_id && m.repIds.includes(req.user.zoho_owner_id));
  else if (!req.user.perms || !(req.user.perms.members || req.user.perms.manager)) return res.status(403).json({ error: 'Your account does not have access to members.' });
  res.json({ connected: true, days, at: arCache ? new Date(arCache.at).toISOString() : null, members: list });
}));

/* ═══════════ SELF-REGISTRATION BY QR CODE ═══════════
 * Anyone with the link (or the QR on a poster) can register for a summit or
 * event on the portal. Nothing reaches Zoho on its own: it waits on the
 * Approvals screen like a rep's registration. Only events shown on the portal,
 * still to come, and not tests, can be registered for. */
async function openEvents() {
  const t = today();
  return (await zoho.coql(queries.portalEvents())).map(fromZoho.event)
    .filter(e => e.date && e.date >= t && !/\btest\b/i.test(e.title || ''));
}
/** The visitor's own address: Netlify passes it on; otherwise the first forwarded one */
const clientIp = req => String(req.headers['x-nf-client-connection-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();
const publicEvent = e => ({ id: e.id, name: e.title, type: e.type, date: e.date, time: e.time || '',
  venue: e.venue || '', city: e.city || '', state: e.state || '', format: e.format || '' });

r.get('/public/events', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const list = (await openEvents()).sort((a, b) => a.date.localeCompare(b.date));
  res.json(list.filter(e => req.query.summits !== '1' || /summit/i.test(e.type || '')).map(publicEvent));
}));
r.get('/public/events/:id', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const e = (await openEvents()).find(x => x.id === String(req.params.id));
  if (!e) return res.status(404).json({ error: 'Registration for this event is not open. It may have taken place already.' });
  res.json(publicEvent(e));
}));
r.post('/public/events/:id/register', wrap(async (req, res) => {
  if (!(await humanCheck(req, res))) return;
  const b = req.body || {};
  const clean = (v, n) => String(v || '').trim().slice(0, n || 120);
  const firstName = clean(b.firstName), lastName = clean(b.lastName), email = clean(b.email, 200).toLowerCase(), phone = clean(b.phone, 40);
  if (!firstName || !lastName) return res.status(400).json({ error: 'Please give your first and last name' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !phone) return res.status(400).json({ error: 'Please give an email address or a phone number, so we can confirm' });
  if (((await q.recentAuditByIp(clientIp(req), 'public.registration', 60))?.c || 0) >= 15) {
    return res.status(429).json({ error: 'Several registrations have come from here in the last hour. Please try again later, or call the office.' });
  }
  const e = (await openEvents()).find(x => x.id === String(req.params.id));
  if (!e) return res.status(404).json({ error: 'Registration for this event is not open.' });
  if (email && await q.pendingSelfRegistration(e.id, email)) {
    return res.json({ ok: true, already: true, event: e.title });
  }
  const dupes = await registrationDuplicates(e.id, { email, phone, name: `${firstName} ${lastName}` });
  if (dupes.some(d => d.where === 'zoho' && (d.why.includes('same email') || d.why.includes('same phone')))) {
    // Their place is already booked: nothing new for the office to approve
    await audit(null, 'public.registration.duplicate', { eventId: e.id }, clientIp(req));
    return res.json({ ok: true, already: true, event: e.title });
  }
  // A member already in Zoho is registered as themselves, not as a new lead
  let contactId;
  if (email) {
    const found = await zoho.coql(`select id from ${M.CONTACT} where Email = '${email.replace(/'/g, '')}' limit 1`).catch(() => []);
    contactId = found[0] ? found[0].id : undefined;
  }
  const g = !!b.bringingGuest;
  const payload = { eventId: e.id, contactId, firstName, lastName, name: `${firstName} ${lastName}`, email, phone,
    business: clean(b.business), city: clean(b.city, 60), state: clean(b.state, 20),
    registrantType: contactId ? 'Member' : 'Lead', bringingGuest: g,
    guestFirstName: g ? clean(b.guestFirstName) : undefined, guestLastName: g ? clean(b.guestLastName) : undefined,
    guestType: g ? (b.guestType === 'Spouse' ? 'Spouse' : 'Other Guest') : undefined, source: 'qr', eventName: e.title,
    duplicate: dupes.length ? dupes : undefined };
  const out = await q.addWriteRequest({ kind: 'registration', payload, repId: 'public', repName: 'Self-registered (QR code)',
    summary: `${payload.name}${contactId ? ' (member)' : ''} registered for ${e.title}${g ? ' with a guest' : ''}${dupes.length ? ' — possible duplicate' : ''}` });
  await audit(null, 'public.registration', { eventId: e.id, id: out[0]?.id, member: !!contactId }, clientIp(req));
  await notifyRegistrationApprovers(req, payload, { by: 'Registered themselves (QR code / portal)' }).catch(err => console.error('[registration] notify failed:', err.message));
  res.status(201).json({ ok: true, event: e.title });
}));

/* ── Someone is waiting to be approved: email the people named in Settings ──
 * (Access & security → Registrations). Queued, so the person registering
 * never waits on Gmail; one email per approver, with a link to Approvals. */
async function notifyRegistrationApprovers(req, p, { by } = {}) {
  const list = String(await setting('registrationApprovers', '')).split(/[\s,;]+/).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if (!list.length) return;
  const url = `${siteUrl(req)}/?view=approvals`;
  const line = (k, v) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#6B7468">${k}</td><td style="padding:3px 0">${esc(v)}</td></tr>` : '';
  const guest = p.bringingGuest ? [p.guestFirstName, p.guestLastName].filter(Boolean).join(' ') || 'Yes' : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;color:#1E2A20">
    <p style="font-size:15px"><strong>${esc(p.name || 'Someone')}</strong> has registered for <strong>${esc(p.eventName || 'an event')}</strong>. It is waiting for your approval.</p>
    <table style="font-size:14px;border-collapse:collapse">${line('Email', p.email)}${line('Phone', p.phone)}${line('Business', p.business)}
      ${line('Guest', guest)}${line('Sent by', by)}</table>
    ${p.duplicate ? '<p style="color:#9A4A1F;font-size:14px">This may be a duplicate: please check before approving.</p>' : ''}
    <p style="margin:18px 0"><a href="${url}" style="background:#2E5132;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Review and approve</a></p>
    <p style="font-size:12.5px;color:#6B7468">Nothing is added to Zoho until it is approved in Rep Hub.</p></div>`;
  for (const to of list) {
    await reminders.queueEmail(to, `Registration to approve: ${p.name || 'someone'} for ${p.eventName || 'an event'}`, html, { kind: 'registration' });
  }
  await sendQueuedMail(req);
}

/* ── Is this person already registered? ──
 * Checked against the event's registrations in Zoho and the requests still
 * waiting on Approvals: the same member, email, phone or name counts. */
const normName = v => String(v || '').replace(/#\s*\d+/g, '').replace(/[^a-z ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const normPhone = v => String(v || '').replace(/\D/g, '').slice(-10);
function samePerson(a, b) {
  const why = [];
  if (a.contactId && b.contactId && a.contactId === b.contactId) why.push('same member');
  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) why.push('same email');
  if (normPhone(a.phone).length === 10 && normPhone(a.phone) === normPhone(b.phone)) why.push('same phone');
  if (normName(a.name) && normName(a.name) === normName(b.name)) why.push('same name');
  return why;
}
async function registrationDuplicates(eventId, p, { exceptPendingId } = {}) {
  const me = { contactId: p.contactId || null, email: p.email || '', phone: p.phone || '',
    name: p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') };
  const [regs, waiting] = await Promise.all([
    zoho.coql(queries.registrationsFor(eventId)).catch(() => []),
    q.pendingRegistrationsFor(eventId).catch(() => []),
  ]);
  const inZoho = regs.filter(z => !/cancel/i.test(z.Registration_Status || '')).map(z => {
    const them = { contactId: z.Registrant_Name?.id || null, email: z.Guest_Email || '', phone: z.Phone || '',
      name: z.Registrant_Name?.name || z.Registrant_Name1 || '' };
    const why = samePerson(me, them);
    return why.length ? { where: 'zoho', id: z.id, name: them.name, date: z.Registration_Date || null, status: z.Registration_Status || '', why } : null;
  }).filter(Boolean);
  const pending = waiting.filter(w => String(w.id) !== String(exceptPendingId || '')).map(w => {
    const wp = typeof w.payload === 'string' ? JSON.parse(w.payload) : w.payload;
    const why = samePerson(me, { contactId: wp.contactId, email: wp.email, phone: wp.phone, name: wp.name || [wp.firstName, wp.lastName].join(' ') });
    return why.length ? { where: 'pending', id: w.id, name: wp.name, by: w.rep_name, date: String(w.created_at || '').slice(0, 10), why } : null;
  }).filter(Boolean);
  return [...inZoho, ...pending];
}
const dupText = d => d.where === 'zoho' ? `already registered in Zoho as ${d.name}${d.date ? ' (' + d.date + ')' : ''}`
  : `already waiting on Approvals${d.by ? ', sent by ' + d.by : ''}`;

/** A rep registers someone for an event. */
r.post('/pending/registration', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.eventId) return res.status(400).json({ error: 'Which event?' });
  if (!b.name && !b.contactId) return res.status(400).json({ error: 'A name is required' });

  const event = await zoho.getRecord(M.EVENT, b.eventId).catch(() => null);
  const eventName = event ? event.Name : 'an event';
  // Already registered, or already asked for? Say so first; the rep can still send it
  const dupes = await registrationDuplicates(b.eventId, b);
  if (dupes.length && !b.confirmDuplicate) {
    return res.status(409).json({ error: `${b.name || 'This person'} is ${dupText(dupes[0])}.`, duplicate: dupes });
  }
  const payload = { ...b, eventName, duplicate: dupes.length ? dupes : undefined, source: 'rep' };
  delete payload.confirmDuplicate;

  const out = await q.addWriteRequest({
    kind: 'registration',
    payload,
    repId: req.user.id,
    repName: req.user.name,
    repZohoId: req.user.zoho_owner_id,
    summary: `Register ${b.name || 'a member'} for ${eventName}` +
             (b.bringingGuest ? ' (bringing a guest)' : ''),
  });
  await audit(req.user.id, 'pending.registration', { eventId: b.eventId }, req.ip);
  await notifyRegistrationApprovers(req, payload, { by: req.user.name }).catch(err => console.error('[registration] notify failed:', err.message));
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

/** A rep asks for a new Growth Ring. Nothing is made in Zoho until the office approves. */
r.post('/pending/ring', auth.authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const clean = (v, n) => String(v || '').trim().slice(0, n || 120);
  const name = clean(b.name);
  if (!name) return res.status(400).json({ error: 'Give the ring a name' });
  if (!b.facId && !clean(b.facName)) return res.status(400).json({ error: 'Pick a facilitator or enter a name' });
  const payload = { name, facId: b.facId ? clean(b.facId, 40) : undefined, facName: clean(b.facName), facPhone: clean(b.facPhone, 40),
    facFreq: clean(b.facFreq, 30), memFreq: clean(b.memFreq, 30), meetingRhythm: clean(b.meetingRhythm, 30),
    capacity: Math.max(2, Math.min(20, parseInt(b.capacity, 10) || 8)) };
  const out = await q.addWriteRequest({
    kind: 'ring', payload, repId: req.user.id, repName: req.user.name, repZohoId: req.user.zoho_owner_id,
    summary: `Start a new Growth Ring: ${name}${payload.facName ? ' (facilitator ' + payload.facName + ')' : ''}`,
  });
  await audit(req.user.id, 'pending.ring', { name }, req.ip);
  for (const u of await q.allOffice()) {
    reminders.sendEmail(u.email, `New Growth Ring to approve: ${name}`,
      `<p>${req.user.name} asked to start <strong>${name}</strong>.</p><p><a href="${cfg.appUrl}/?view=approvals">Review it</a></p>`,
      { userId: u.id, kind: 'approval' }).catch(() => {});
  }
  res.status(201).json({ id: out[0]?.id, status: 'pending' });
}));

/**
 * The office approves, and only now does anything reach Zoho.
 * If the Zoho write fails the item stays pending with the reason, so nothing
 * is silently lost and the office can retry.
 */
r.post('/pending/:id/approve', auth.authRequired, auth.requireOffice, access.requirePerm('approvals'), writesAllowed, wrap(async (req, res) => {
  const row = await q.oneWriteRequest(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'No such request' });
  if (row.status !== 'pending') return res.status(409).json({ error: `Already ${row.status}` });

  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  try {
    let zohoId = null;

    if (row.kind === 'registration') {
      const dupes = (await registrationDuplicates(p.eventId, p, { exceptPendingId: row.id })).filter(d => d.where === 'zoho');
      if (dupes.length && !req.body?.confirmDuplicate) {
        return res.status(409).json({ error: `${p.name || 'This person'} is ${dupText(dupes[0])}. Approve anyway, or send it back.`, duplicate: dupes });
      }
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

    } else if (row.kind === 'ring') {
      // Zoho marks a ring live with its Active tick box; the facilitator is
      // linked when they are already a contact, and named in the description if not
      const desc = [p.facId ? '' : p.facName && `Facilitator: ${p.facName}${p.facPhone ? ', ' + p.facPhone : ''} (not yet in Zoho)`,
        p.meetingRhythm && `Meets: ${p.meetingRhythm}`, `Started from Rep Hub by ${row.rep_name || 'a rep'}`].filter(Boolean).join('. ');
      const out = await zoho.insertRecords(M.RING, [{ ...toZoho.ring({ name: p.name, facId: p.facId, repZohoId: row.rep_zoho_id || undefined,
        capacity: p.capacity, description: desc }), Active: true }]);
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
r.post('/pending/:id/reject', auth.authRequired, auth.requireOffice, access.requirePerm('approvals'), wrap(async (req, res) => {
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
// Everyone's hours and claims are accounting data: office accounts without
// that access see only their own, like a rep.
const seesAllClaims = u => u.role !== 'rep' && !!(u.perms && u.perms.accounting);

r.get('/time', auth.authRequired, wrap(async (req, res) => {
  const rows = seesAllClaims(req.user) ? await q.allTime() : await q.timeFor(req.user.id);
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

/* Decline: back to the rep with the reason, by email too */
async function declineClaim(req, res, kind) {
  const note = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!note) return res.status(400).json({ error: 'Say why, so the rep knows what to change' });
  const id = parseInt(req.params.id, 10);
  const rows = kind === 'time' ? await q.declineTime(id, req.user.id, note) : await q.declineExpense(id, req.user.id, note);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'That claim is not waiting for approval' });
  await audit(req.user.id, kind === 'time' ? 'time.declined' : 'expense.declined', { id, note }, req.ip);
  const rep = await q.userById(row.user_id).catch(() => null);
  if (rep && rep.email) {
    const what = kind === 'time' ? `${Number(row.hours)} hour${Number(row.hours) === 1 ? '' : 's'} (${row.category})`
      : `$${Number(row.amount).toFixed(2)} (${row.category})`;
    const day = String(row.entry_date instanceof Date ? row.entry_date.toISOString() : row.entry_date).slice(0, 10);
    const e2 = v => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    reminders.sendEmail(rep.email, `Your ${kind === 'time' ? 'hours' : 'expense'} for ${day} were sent back`,
      `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#1E2A20;max-width:520px">
        <p>${e2((rep.name || '').split(' ')[0] || 'Hello')},</p>
        <p>${e2(req.user.name || 'The office')} sent back your ${kind === 'time' ? 'hours' : 'expense'} of <strong>${e2(what)}</strong> on ${e2(day)}:</p>
        <p style="background:#F5DCD3;border-radius:8px;padding:12px 14px">${e2(note)}</p>
        <p>Open <a href="${siteUrl(req)}/?view=timesheet" style="color:#2E5132">Rep Hub</a> → Hours &amp; expenses to correct it and send it again. Reply to this email with any questions.</p></div>`,
      { userId: rep.id, kind: 'claim-declined', replyTo: req.user.email }).catch(() => {});
  }
  res.json({ ok: true });
}
r.post('/time/:id/decline', auth.authRequired, access.requirePerm('accounting'), wrap((req, res) => declineClaim(req, res, 'time')));
r.post('/expenses/:id/decline', auth.authRequired, access.requirePerm('accounting'), wrap((req, res) => declineClaim(req, res, 'exp')));

async function resubmitClaim(req, res, kind) {
  const b = req.body || {};
  const num = kind === 'time' ? parseFloat(b.hours) : parseFloat(b.amount);
  if (b.hours != null || b.amount != null) {
    if (!(num > 0) || (kind === 'time' && num > 24)) return res.status(400).json({ error: kind === 'time' ? 'Hours must be between 0 and 24' : 'The amount must be more than 0' });
  }
  const desc = b.description != null ? String(b.description).slice(0, 2000) : null;
  const id = parseInt(req.params.id, 10);
  const rows = kind === 'time' ? await q.resubmitTime(id, req.user.id, isNaN(num) ? null : num, desc)
    : await q.resubmitExpense(id, req.user.id, isNaN(num) ? null : num, desc);
  if (!rows.length) return res.status(404).json({ error: 'Only your own sent-back claims can be sent again' });
  await audit(req.user.id, kind === 'time' ? 'time.resubmitted' : 'expense.resubmitted', { id }, req.ip);
  res.json({ ok: true });
}
r.post('/time/:id/resubmit', auth.authRequired, wrap((req, res) => resubmitClaim(req, res, 'time')));
r.post('/expenses/:id/resubmit', auth.authRequired, wrap((req, res) => resubmitClaim(req, res, 'exp')));

r.post('/time/:id/approve', auth.authRequired, access.requirePerm('accounting'), wrap(async (req, res) => {
  await q.approveTime(parseInt(req.params.id, 10), req.user.id);
  res.json({ ok: true });
}));

r.get('/expenses', auth.authRequired, wrap(async (req, res) => {
  let rows = seesAllClaims(req.user) ? await q.allExpenses() : await q.expensesFor(req.user.id);
  // Whether a claim became a Zoho Books bill is shown only to Books access
  if (!req.user.perms.books) rows = rows.map(({ books_bill_id, books_error, books_queued, ...x }) => x);
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
    vendor: String(b.vendor || '').trim().slice(0, 120) || null,
  });
  await audit(req.user.id, 'expense.logged', { amount, category: b.category, receipt: !!b.receiptData }, req.ip);
  res.status(201).json({ id: out[0]?.id });
}));

/** The receipt itself, fetched only when someone opens it. */
r.get('/expenses/:id/receipt', auth.authRequired, wrap(async (req, res) => {
  const row = await q.receiptFor(parseInt(req.params.id, 10));
  if (!row || !row.receipt_data) return res.status(404).json({ error: 'No receipt on that expense' });
  // Your own receipts, or everyone's with accounting access — not anyone's by guessing a number
  if (row.user_id !== req.user.id && !seesAllClaims(req.user)) return res.status(404).json({ error: 'No receipt on that expense' });
  res.json({ name: row.receipt_name, type: row.receipt_type, data: row.receipt_data });
}));

r.post('/expenses/:id/approve', auth.authRequired, access.requirePerm('accounting'), wrap(async (req, res) => {
  await q.approveExpense(parseInt(req.params.id, 10), req.user.id);
  res.json({ ok: true });
}));

/** Everything approved, as one payload for accounting. */
r.get('/accounting/pending', auth.authRequired, access.requirePerm('accounting'), wrap(async (req, res) => {
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

/**
 * Email the approved items to accounting, mark them sent, and make the Zoho
 * Books bills. Given ids (an approved batch), sends only those still
 * approved; without, sends everything approved. Returns { status, body }.
 */
/** The key the background function checks, so only Rep Hub can start it. */
const kickKey = () => crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
/** Start the Zoho Books background run. Netlify answers 202 at once. */
async function kickBooks(site) {
  try {
    const res = await fetch(`${site}/.netlify/functions/books-background`, {
      method: 'POST', headers: { 'x-rephub-key': kickKey() }, signal: AbortSignal.timeout(3000) });
    return res.status === 202 || res.ok;
  } catch (e) {
    console.error('[books] background start failed, the 15-minute job will do it:', e.message);
    return true;   // queued either way; sync-flush finishes it
  }
}
/** Start any of Rep Hub's background functions. Netlify answers 202 at once. */
async function kickBackground(site, name) {
  try {
    const res = await fetch(`${site}/.netlify/functions/${name}`, {
      method: 'POST', headers: { 'x-rephub-key': kickKey() }, signal: AbortSignal.timeout(3000) });
    return res.status === 202 || res.ok;
  } catch (e) { console.error(`[${name}] could not start:`, e.message); return false; }
}
/** Where this site lives, when running on Netlify; null anywhere else. */
function netlifySite(req) {
  if (!process.env.NETLIFY && !process.env.URL && !process.env.AWS_LAMBDA_FUNCTION_NAME) return null;
  return process.env.URL || siteUrl(req);
}

async function deliverToAccounting({ timeIds, expenseIds, actor, ip, site } = {}) {
  const [time, exp] = await Promise.all([q.allTime(), q.allExpenses()]);
  const inSet = ids => x => !ids || ids.map(Number).includes(Number(x.id));
  const t = time.filter(x => x.status === 'Approved').filter(inSet(timeIds));
  const e = exp.filter(x => x.status === 'Approved').filter(inSet(expenseIds));
  if (!t.length && !e.length) return { status: 400, body: { error: 'Nothing approved to send' } };

  const to = await setting('accountingEmail', 'accounting@symbiz.org');
  if (!cfg.mail.enabled || !cfg.mail.host) {
    return { status: 503, body: {
      error: 'Email is not configured for this site, so nothing was sent. Nothing has been marked as claimed.',
      fix: 'Set MAIL_ENABLED, SMTP_HOST, SMTP_USER and SMTP_PASS, then try again.',
    } };
  }
  // Postgres hands DATE columns back as Date objects, which printed as
  // "Fri Sep 18 2026 00:00:00 GMT…". Accounting wants 2026-09-18.
  const day = d => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);

  /**
   * Receipts go with the expenses, one file per expense, named by its line
   * number (E1, E2…) so a person — or Claude reading this email to enter
   * bills in Zoho Books — can match each image to its line without guessing.
   */
  const MAX_ATTACH = 18 * 1024 * 1024;   // stay well under Gmail's 25 MB per message
  let attachedBytes = 0;
  const receipts = [];
  for (const [i, x] of e.entries()) {
    const ref = `E${i + 1}`;
    x.ref = ref;
    if (!x.receipt_name) { x.receiptNote = 'MISSING'; continue; }
    const row = await q.receiptFor(x.id).catch(() => null);
    const m = row && String(row.receipt_data || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) { x.receiptNote = 'MISSING'; continue; }
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    const type = row.receipt_type || m[1] || 'application/octet-stream';
    const ext = (String(row.receipt_name).match(/\.([a-z0-9]{2,5})$/i) || [])[1]
      || ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp', 'application/pdf': 'pdf' }[type] || 'bin');
    const slug = s => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 30);
    const filename = `${ref}-receipt-${slug(x.rep_name)}-${day(x.entry_date)}-${Number(x.amount).toFixed(2)}.${ext}`;
    if (attachedBytes + buf.length > MAX_ATTACH) { x.receiptNote = 'TOO LARGE — download from Rep Hub'; continue; }
    attachedBytes += buf.length;
    x.receiptNote = filename;
    x.receiptCid = /^image\//.test(type) ? `${ref.toLowerCase()}@rephub` : null;
    receipts.push({ filename, content: buf, contentType: type, ...(x.receiptCid ? { cid: x.receiptCid } : {}) });
  }

  const rows = [['Ref', 'Type', 'Rep', 'Date', 'Category', 'Vendor', 'Hours', 'Amount', 'Description', 'Receipt']];
  t.forEach((x, i) => rows.push([`H${i + 1}`, 'Hours', x.rep_name, day(x.entry_date), x.category, '', x.hours, '', x.description, '']));
  e.forEach(x => rows.push([x.ref, 'Expense', x.rep_name, day(x.entry_date), x.category, x.vendor || '', '', x.amount, x.description,
                            x.receiptNote]));
  const csv = rows.map(r => r.map(c => {
    const v = String(c ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\n');

  // Name who approved what, and reply to them. Sending from their own mailbox
  // would mean holding their password, which nobody should give an app.
  const approverIds = [...new Set([...t, ...e].map(x => x.approved_by).filter(Boolean))];
  const approverUsers = (await q.allUsers()).filter(u => approverIds.includes(u.id));
  const byLine = approverUsers.length ? `Approved by ${approverUsers.map(u => u.name).join(', ')}.` : '';

  const totalHours = t.reduce((s, x) => s + Number(x.hours), 0);
  const totalAmount = e.reduce((s, x) => s + Number(x.amount), 0);

  // The same rows as a PDF, for whoever files or prints it. The CSV stays the
  // one to import; the PDF is the one a person reads.
  const pdf = tablePDF({
    title: 'Rep hours and expenses',
    subtitle: `Approved for payment · ${today()}${byLine ? ' · ' + byLine : ''}`,
    columns: [
      { label: 'Ref', width: 4 }, { label: 'Type', width: 7 }, { label: 'Rep', width: 12 }, { label: 'Date', width: 9 },
      { label: 'Category', width: 10 }, { label: 'Vendor', width: 11 }, { label: 'Hours', width: 5, align: 'right' },
      { label: 'Amount', width: 8, align: 'right' }, { label: 'Description', width: 20 },
      { label: 'Receipt', width: 14 },
    ],
    rows: rows.slice(1).map(r => r.map((c, i) => (i === 7 && c !== '' ? '$' + Number(c).toFixed(2) : c))),
    footer: ['', 'Total', '', '', '', '', totalHours, '$' + totalAmount.toFixed(2), '', ''],
    note: 'Expenses marked MISSING have no receipt attached in Rep Hub.',
  });

  const cellStyle = 'padding:5px 8px;border-bottom:1px solid #E9ECDF;font-size:13px;text-align:left';
  const table = `<table style="border-collapse:collapse;width:100%;max-width:760px">
    <tr>${rows[0].map(h => `<th style="${cellStyle};border-bottom:2px solid #2E5132">${esc(h)}</th>`).join('')}</tr>
    ${rows.slice(1).map(r => `<tr>${r.map(c => `<td style="${cellStyle}">${esc(c)}</td>`).join('')}</tr>`).join('')}
  </table>`;

  // One block per expense with its receipt beside it, ready to key in as a
  // bill — or for Claude to read and enter in Zoho Books with the image
  // attached. The JSON at the end carries the same facts without any layout.
  const expenseBlocks = e.map(x => `
    <div style="border:1px solid #E9ECDF;border-radius:8px;padding:10px 12px;margin:0 0 12px;max-width:760px">
      <p style="margin:0 0 6px;font-size:14px"><strong>${esc(x.ref)} · $${Number(x.amount).toFixed(2)} · ${esc(x.category)}</strong></p>
      <p style="margin:0 0 6px;font-size:13px;color:#444">
        Rep: ${esc(x.rep_name)}<br>Date: ${esc(day(x.entry_date))}<br>
        Vendor / paid to: ${esc(x.vendor || '—')}<br>
        Description: ${esc(x.description || '—')}<br>
        Receipt: ${esc(x.receiptNote)}</p>
      ${x.receiptCid ? `<img src="cid:${x.receiptCid}" alt="Receipt ${esc(x.ref)}" style="max-width:420px;width:100%;border:1px solid #ddd;border-radius:6px">` : ''}
    </div>`).join('');

  const booksOn = await books.configured();
  const stamp = today();
  const missing = e.filter(x => x.receiptNote === 'MISSING').length;
  const sent = await reminders.sendEmail(to, `Rep hours and expenses — ${stamp}`,
    `<p>${t.length} time entries and ${e.length} expenses approved for payment. ${esc(byLine)}</p>
     <p>Total: ${totalHours} hours, $${totalAmount.toFixed(2)}</p>
     <p>Attached: the full list as a spreadsheet (CSV) and a PDF, and ${receipts.length} receipt${receipts.length === 1 ? '' : 's'},
        each named by its line (E1, E2…).${missing ? ` <strong>${missing} expense${missing === 1 ? ' has' : 's have'} no receipt.</strong>` : ''}</p>
     ${table}
     ${e.length ? `<h3 style="font-size:15px;margin:22px 0 10px">Expenses with receipts</h3>${expenseBlocks}` : ''}
     ${booksOn && (e.length || t.length) ? `<p style="color:#555;font-size:13px">These are also entered in Zoho Books as bills to each rep: each expense as RH-&lt;expense number&gt; with its receipt attached, and each rep's hours as one bill per week (RH-H…).</p>` : ''}`,
    { userId: actor?.id || null, kind: 'accounting',
      replyTo: approverUsers.length === 1 ? approverUsers[0].email : (actor?.email || undefined),
      attachments: [
        { filename: `rep-hours-and-expenses-${stamp}.csv`, content: csv, contentType: 'text/csv' },
        { filename: `rep-hours-and-expenses-${stamp}.pdf`, content: pdf, contentType: 'application/pdf' },
        ...receipts,
      ] });

  if (sent && sent.ok === false) {
    // Marking them claimed when the email failed would silently lose a month
    // of expenses — leave them approved so the office can retry.
    return { status: 502, body: { error: `The email could not be sent: ${sent.error}. Nothing was marked as claimed.` } };
  }

  await q.markTimeSentIds(t.map(x => x.id));
  await q.markExpensesSentIds(e.map(x => x.id));

  // Bills in Zoho Books, as many as fit in this request; the 15-minute job
  // finishes the rest. A Books problem never undoes the email that went.
  let booksOut = null;
  if (booksOn && (await setting('booksAuto', 'on')) !== 'off' && (e.length || t.length)) {
    await q.queueBills(e.map(x => x.id));
    await q.queueTimeBills(t.map(x => x.id));     // hours: one bill per rep per week
    // On Netlify the bills are made by a background function, so pressing
    // Send doesn't wait on Zoho Books (that was most of the delay). Anywhere
    // else — tests, a local server — they are made here, as before.
    const kicked = site ? await kickBooks(site) : false;
    booksOut = kicked ? { configured: true, queued: e.length, background: true }
      : await books.makeBills({ budgetMs: 5000 })
        .catch(err => ({ configured: true, made: 0, failed: 0, left: e.length, error: err.message }));
  }
  await audit(actor?.id || null, 'accounting.sent', { time: t.length, expenses: e.length, books: booksOut }, ip || null);
  return { status: 200, body: { sent: true, to, time: t.length, expenses: e.length, books: booksOut } };
}

/* ── An admin gives the final approval before anything goes to accounting ──
 *
 * Office staff (or the monthly schedule) put everything approved into a
 * batch. It waits on the admins' Approvals screen — nobody is emailed — and
 * an admin reviews it and sends it on, or returns it with a note. An admin
 * pressing Send themselves is the approval, so theirs goes straight through.
 */
const day10 = d => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);

async function createBatch({ actor, period } = {}) {
  const [time, exp] = await Promise.all([q.allTime(), q.allExpenses()]);
  const t = time.filter(x => x.status === 'Approved');
  const e = exp.filter(x => x.status === 'Approved');
  if (!t.length && !e.length) return { status: 400, body: { error: 'Nothing approved to send' } };
  // Asking again replaces the open request with everything approved now
  await q.supersedeBatches();
  await q.addBatch({ token: crypto.randomBytes(24).toString('hex'), period,
    timeIds: t.map(x => x.id), expenseIds: e.map(x => x.id), requestedBy: actor?.id || 'schedule', approver: 'admin' });
  const amount = e.reduce((s, x) => s + Number(x.amount), 0);
  await audit(actor?.id || null, 'accounting.batchCreated', { expenses: e.length, time: t.length, period }, null);
  return { status: 200, body: { awaitingApproval: true, expenses: e.length, time: t.length, amount } };
}

r.post('/accounting/send', auth.authRequired, access.requirePerm('accounting'), wrap(async (req, res) => {
  const out = req.user.role === 'admin'
    ? await deliverToAccounting({ actor: req.user, ip: req.ip, site: netlifySite(req) })
    : await createBatch({ actor: req.user });   // office staff: an admin with accounting access approves it
  if (req.user.role === 'admin' && out.status === 200) await q.supersedeBatches();   // nothing left waiting
  if (!req.user.perms.books && out.body) delete out.body.books;      // Books detail is the owner's business
  res.status(out.status).json(out.body);
}));

/** Vendor names from Zoho Books, to suggest while typing an expense. */
r.get('/books/vendors', auth.authRequired, wrap(async (req, res) => {
  try { res.json(await books.vendorNames()); }
  catch (e) { res.json([]); }        // suggestions are a nicety; never block the form
}));

/** The batch waiting for final approval (and the last one sent back), for both screens. */
r.get('/accounting/batches', auth.authRequired, access.requirePerm('accounting'), wrap(async (req, res) => {
  const [pending, returned] = await Promise.all([q.pendingBatches(), q.lastReturnedBatch()]);
  const names = Object.fromEntries((await q.everyUser()).map(u => [u.id, u.name]));
  const shape = b => ({ id: b.id, period: b.period, createdAt: b.created_at, status: b.status, note: b.note || '',
    requestedBy: b.requested_by === 'schedule' ? 'the monthly schedule' : (names[b.requested_by] || ''),
    decidedBy: names[b.decided_by] || '', decidedAt: b.decided_at,
    expenses: JSON.parse(b.expense_ids).length, time: JSON.parse(b.time_ids).length });
  res.json({ pending: pending.map(shape), returned: returned ? shape(returned) : null });
}));

async function pendingBatch(id) {
  const b = await q.batchById(parseInt(id, 10));
  if (!b) return { status: 404, error: 'That batch was not found' };
  if (b.status !== 'pending') {
    return { status: 409, error: b.status === 'approved' ? 'This has already been sent to accounting.'
      : b.status === 'returned' ? 'This was sent back to the office.' : 'A newer batch has replaced this one.' };
  }
  return { batch: b };
}

/** Everything in a batch, for the admin to review. Receipts open via /expenses/:id/receipt. */
r.get('/accounting/batches/:id', auth.authRequired, access.requirePerm('accounting'), wrap(async (req, res) => {
  const b = await q.batchById(parseInt(req.params.id, 10));
  if (!b) return res.status(404).json({ error: 'That batch was not found' });
  const ids = { t: JSON.parse(b.time_ids).map(Number), e: JSON.parse(b.expense_ids).map(Number) };
  const [time, exp] = await Promise.all([q.allTime(), q.allExpenses()]);
  res.json({
    id: b.id, status: b.status, period: b.period, createdAt: b.created_at,
    expenses: exp.filter(x => ids.e.includes(Number(x.id))).map(x => ({ id: x.id, rep: x.rep_name, date: day10(x.entry_date),
      amount: Number(x.amount), category: x.category, vendor: x.vendor || '', description: x.description || '',
      status: x.status, hasReceipt: !!x.receipt_name })),
    time: time.filter(x => ids.t.includes(Number(x.id))).map(x => ({ id: x.id, rep: x.rep_name, date: day10(x.entry_date),
      hours: Number(x.hours), category: x.category, description: x.description || '', status: x.status })),
  });
}));

r.post('/accounting/batches/:id/approve', auth.authRequired, auth.requireAdmin, access.requirePerm('accounting'), wrap(async (req, res) => {
  const { batch: b, error, status } = await pendingBatch(req.params.id);
  if (error) return res.status(status).json({ error });
  const out = await deliverToAccounting({ timeIds: JSON.parse(b.time_ids), expenseIds: JSON.parse(b.expense_ids),
    actor: req.user, ip: req.ip, site: netlifySite(req) });
  if (!req.user.perms.books && out.body) delete out.body.books;
  if (out.status === 200) {
    await q.decideBatch(b.id, 'approved', req.user.id, null);
    await audit(req.user.id, 'accounting.approved', { batch: b.id }, req.ip);
  }
  res.status(out.status).json(out.body);
}));

r.post('/accounting/batches/:id/return', auth.authRequired, auth.requireAdmin, access.requirePerm('accounting'), wrap(async (req, res) => {
  const { batch: b, error, status } = await pendingBatch(req.params.id);
  if (error) return res.status(status).json({ error });
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  await q.decideBatch(b.id, 'returned', req.user.id, note);
  await audit(req.user.id, 'accounting.returned', { batch: b.id, note }, req.ip);
  res.json({ ok: true });
}));

/**
 * The automatic run, called daily by the scheduler. On the day chosen in
 * Settings (1st, 15th or last of the month, US Eastern) it puts everything
 * approved in front of the admins — once per day, however often it runs.
 */
async function runAutoAccounting(now = new Date()) {
  const when = String(await setting('accountingDay', '1'));
  if (when === 'Off') return { skipped: 'off' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const due = when === 'Last' ? d === last : d === Number(when);
  if (!due) return { skipped: 'not today' };
  const period = `${parts.year}-${parts.month}-${parts.day}`;
  if (await q.batchByPeriod(period)) return { skipped: 'already done today' };
  const out = await createBatch({ period });
  return { period, status: out.status, ...out.body };
}
r.runAutoAccounting = runAutoAccounting;

/* ═══════════ BACKUP ═══════════
 * Everything people type into Rep Hub that lives only in our database (hours,
 * expenses, approvals, summit checklists, notes) — copied out so there is
 * always a second copy. Calls, registrations and leads already live in Zoho.
 * Never included: passwords, sign-in codes, or connection keys. */
const BACKUP_TABLES = ['time_entries', 'expenses', 'pending_writes', 'accounting_batches', 'summit_tasks', 'summit_links',
  'summit_notes', 'rep_goals', 'rep_notes', 'ring_notes', 'visit_plans', 'rep_messages'];
async function buildBackup({ receipts = false } = {}) {
  const out = { madeAt: new Date().toISOString(), site: cfg.appUrl, tables: {} };
  for (const t of BACKUP_TABLES) {
    const rows = await query(`SELECT * FROM ${t} ORDER BY 1`).catch(() => null);
    if (!rows) continue;
    out.tables[t] = receipts ? rows : rows.map(x => {
      if (!('receipt_data' in x)) return x;
      const { receipt_data, ...rest } = x; return { ...rest, has_receipt: !!receipt_data };
    });
  }
  out.tables.people = (await q.allUsers()).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, region: u.region,
    zoho_owner_id: u.zoho_owner_id, active: u.active, created_at: u.created_at }));
  out.tables.settings = (await query('SELECT key, value FROM settings ORDER BY key').catch(() => []))
    .filter(s => !/token|secret|password|key|cache/i.test(s.key));
  return out;
}
const csvOf = (rows, cols) => [cols.join(',')].concat(rows.map(r => cols.map(c => {
  const v = r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : r[c] == null ? '' : String(r[c]);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}).join(','))).join('\n');
async function backupTo() {
  const extra = String(await setting('backup_email', '') || '').split(/[,;\s]+/).filter(e => /@/.test(e));
  const oid = await access.ownerId();
  const owner = oid ? await q.userById(oid) : null;
  return [...new Set([owner && owner.email, ...extra].filter(Boolean))];
}
/** The nightly copy of Zoho, module by module, as kept in our database */
async function zohoCopy() {
  const rows = await query('SELECT module, data, missing_since FROM zoho_mirror ORDER BY module, id').catch(() => []);
  const out = {};
  rows.forEach(r => {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    (out[r.module] = out[r.module] || []).push(r.missing_since ? { ...d, _missing_from_zoho_since: r.missing_since } : d);
  });
  return out;
}
/** The whole backup as one compressed file, Zoho copy included */
async function backupFile() {
  const b = await buildBackup();
  b.zoho = await zohoCopy();
  const day = b.madeAt.slice(0, 10);
  const count = Object.fromEntries(Object.entries(b.tables).map(([k, v]) => [k, v.length]));
  const zCount = Object.fromEntries(Object.entries(b.zoho).map(([k, v]) => [k, v.length]));
  const zTotal = Object.values(zCount).reduce((s, n) => s + n, 0);
  const zip = require('zlib').gzipSync(Buffer.from(JSON.stringify(b)));
  return { b, zip, day, count, zCount, zTotal };
}
/** Into the Symbiz Google Drive folder, every night (whatever the email setting) */
async function driveBackup() {
  const drive = require('./lib/gdrive');
  if (!(await drive.status()).connected) return { skipped: 'Google Drive not connected' };
  try {
    const { zip, b } = await backupFile();
    const stamp = b.madeAt.slice(0, 16).replace('T', ' ').replace(':', '-');
    return await drive.upload(`Rep Hub backup ${stamp} UTC.json.gz`, zip);
  } catch (e) { await drive.noteFailure(e.message); return { error: e.message }; }
}
r.driveBackup = driveBackup;
async function sendBackup({ scheduled = false } = {}) {
  // Daily or weekly (Sundays, US Eastern), as chosen in Access & security → Backup
  if (scheduled && (await setting('backup_frequency', 'weekly')) !== 'daily') {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
    if (wd !== 'Sun') return { skipped: 'not the day' };
  }
  const to = await backupTo();
  if (!to.length) return { skipped: 'no one to send it to' };
  const { b, zip, day, count, zCount, zTotal } = await backupFile();
  const T = b.tables;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#1E2A20;max-width:560px">
    <p>A complete copy of Rep Hub's data, made ${esc(day)}.</p>
    <p><strong>Kept in Rep Hub:</strong> ${count.time_entries || 0} hours entries · ${count.expenses || 0} expenses · ${count.pending_writes || 0} approval requests · ${count.summit_tasks || 0} summit tasks · ${count.ring_notes || 0} ring notes</p>
    <p><strong>Copy of Zoho CRM:</strong> ${zTotal ? Object.entries(zCount).map(([k, n]) => `${n} ${esc(k.replace(/_/g, ' '))}`).join(' · ') : 'not made yet'}</p>
    <p>Keep this email. The spreadsheets open in Excel. The .json.gz file holds everything, Zoho records included with every field, and is what Rep Hub (or another developer) can be rebuilt from.
      Receipt pictures are too large for email; download them any time from Access & security → Backup.</p></div>`;
  const res = await reminders.sendEmail(to.join(','), `Rep Hub backup — ${day}`, html, { kind: 'backup', attachments: [
    { filename: `rephub-hours-${day}.csv`, content: csvOf(T.time_entries || [], ['id', 'rep_name', 'entry_date', 'hours', 'category', 'description', 'status', 'created_at', 'approved_at', 'approved_by']) },
    { filename: `rephub-expenses-${day}.csv`, content: csvOf(T.expenses || [], ['id', 'rep_name', 'entry_date', 'amount', 'category', 'vendor', 'description', 'status', 'has_receipt', 'created_at', 'approved_at', 'approved_by']) },
    { filename: `rephub-backup-${day}.json.gz`, content: zip, contentType: 'application/gzip' },
  ] });
  await q.setSetting('backup_last', JSON.stringify({ at: b.madeAt, to, ok: !!res.ok, error: res.error || null, zoho: zTotal, sizeKb: Math.round(zip.length / 1024) })).catch(() => {});
  return { to, ok: !!res.ok, error: res.error || null, count, zoho: zCount };
}
r.sendBackup = sendBackup;
/* Nightly: copy Zoho, then send the backup if it's due. Runs as a background
   function (up to 15 minutes); `sendNow` is the Email a copy now button. */
async function nightly({ sendNow = false, driveNow = false, budgetMs } = {}) {
  const mirror = require('./mirror');
  if (driveNow) return { drive: await driveBackup() };          // "Save to Drive now": just the upload
  const mirrorOut = await mirror.runMirror({ budgetMs }).catch(e => ({ error: e.message }));
  const queueOut = await mirror.processQueue({ budgetMs: 60000, limit: 1000 }).catch(e => ({ error: e.message }));
  // Keep Zoho's change notifications switched on (each lasts a day)
  const watchOut = process.env.URL ? await mirror.ensureWatch(process.env.URL, { force: true }).catch(e => ({ error: e.message })) : null;
  const driveOut = sendNow ? null : await driveBackup();
  const backupOut = await sendBackup({ scheduled: !sendNow }).catch(e => ({ error: e.message }));
  return { mirror: mirrorOut, queue: queueOut, watch: watchOut, drive: driveOut, backup: backupOut };
}
r.nightly = nightly;
r._buildBackup = buildBackup;
const backupGuard = [auth.authRequired, wrap(async (req, res, next) => {
  if (req.user.role === 'admin' || await access.isOwner(req.user)) return next();
  res.status(403).json({ error: 'Only the owner or a director can take a backup' });
})];
r.get('/admin/backup', ...backupGuard, wrap(async (req, res) => {
  const b = await buildBackup({ receipts: req.query.receipts === '1' });
  await audit(req.user.id, 'backup.downloaded', { receipts: req.query.receipts === '1' }, req.ip);
  res.set('Content-Disposition', `attachment; filename="rephub-backup-${b.madeAt.slice(0, 10)}.json"`);
  res.json(b);
}));
r.get('/admin/backup/status', ...backupGuard, wrap(async (req, res) => {
  let last = null; try { last = JSON.parse(await setting('backup_last', 'null')); } catch { last = null; }
  res.json({ to: await backupTo(), extra: await setting('backup_email', ''), last,
    frequency: await setting('backup_frequency', 'weekly'), mirror: await require('./mirror').mirrorStatus(),
    drive: await require('./lib/gdrive').status() });
}));
r.put('/admin/backup/frequency', ...backupGuard, wrap(async (req, res) => {
  const f = req.body?.frequency === 'daily' ? 'daily' : 'weekly';
  await q.setSetting('backup_frequency', f);
  res.json({ frequency: f });
}));
/* The Zoho copy, a module and a slice at a time (one response can't carry it all) */
r.get('/admin/backup/zoho', ...backupGuard, wrap(async (req, res) => {
  const mod = String(req.query.module || '');
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
  if (!mod) return res.json({ modules: (await require('./mirror').mirrorStatus()).modules });
  const rows = await query('SELECT data, missing_since FROM zoho_mirror WHERE module = $1 ORDER BY id LIMIT 1000 OFFSET $2', [mod, offset]);
  res.json({ module: mod, offset, records: rows.map(r => {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return r.missing_since ? { ...d, _missing_from_zoho_since: r.missing_since } : d;
  }), more: rows.length === 1000 });
}));
/* Google Drive for the nightly backup: a Symbiz Google account connects once */
const driveRedirect = req => `${(netlifySite(req) || siteUrl(req)).replace(/\/$/, '')}/api/google/callback`;
r.get('/admin/backup/google/start', ...backupGuard, wrap(async (req, res) => {
  const drive = require('./lib/gdrive');
  if (!drive.configured()) return res.status(400).json({ error: 'Google Drive is not set up on the server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).' });
  const state = require('jsonwebtoken').sign({ sub: req.user.id, purpose: 'gdrive' }, cfg.jwtSecret, { expiresIn: '15m' });
  res.json({ url: drive.authUrl(driveRedirect(req), state) });
}));
r.get('/google/callback', wrap(async (req, res) => {
  const back = msg => res.redirect(302, `/?view=access&drive=${encodeURIComponent(msg)}`);
  let claims; try { claims = require('jsonwebtoken').verify(String(req.query.state || ''), cfg.jwtSecret); } catch { return back('expired'); }
  if (claims.purpose !== 'gdrive') return back('expired');
  if (req.query.error || !req.query.code) return back('cancelled');
  try {
    const out = await require('./lib/gdrive').exchange(String(req.query.code), driveRedirect(req));
    await audit(claims.sub, 'backup.driveConnected', { email: out.email }, clientIp(req));
    // The first copy straight away, so the folder is there to see
    const site = netlifySite(req);
    if (site) await kickBackground(site, 'nightly-background?drive=1'); else await driveBackup();
    return back('connected');
  } catch (e) { return back('failed: ' + e.message.slice(0, 120)); }
}));
r.post('/admin/backup/google/upload', ...backupGuard, wrap(async (req, res) => {
  const site = netlifySite(req);
  if (site && await kickBackground(site, 'nightly-background?drive=1')) return res.json({ started: true });
  res.json(await driveBackup());
}));
/* Apps Script: no Google Cloud project needed. Rep Hub hands out the script
   (with its secret key in it); the person pastes back the web app address. */
r.get('/admin/backup/google/script', ...backupGuard, wrap(async (req, res) => {
  res.json({ source: await require('./lib/gdrive').scriptSource() });
}));
r.post('/admin/backup/google/script', ...backupGuard, wrap(async (req, res) => {
  const drive = require('./lib/gdrive');
  let out;
  try { out = await drive.connectScript(req.body?.url); } catch (e) { return res.status(400).json({ error: e.message }); }
  await audit(req.user.id, 'backup.driveConnected', { email: out.email, via: 'script' }, req.ip);
  // The first copy straight away
  const site = netlifySite(req);
  if (site) await kickBackground(site, 'nightly-background?drive=1'); else await driveBackup();
  res.json({ ok: true, ...out });
}));
/* Keep for years on a schedule (default), or keep every file */
r.put('/admin/backup/keep', ...backupGuard, wrap(async (req, res) => {
  const keep = req.body?.keep === 'all' ? 'all' : 'smart';
  await q.setSetting('backup_keep', keep);
  res.json({ keep });
}));
r.delete('/admin/backup/google', ...backupGuard, wrap(async (req, res) => {
  await require('./lib/gdrive').disconnect();
  await audit(req.user.id, 'backup.driveDisconnected', null, req.ip);
  res.json({ ok: true });
}));

/* Zoho tells us a record changed (no sign-in: checked by the secret token
   Rep Hub gave Zoho). Queued, then copied with every field. */
r.post('/zoho/notify', wrap(async (req, res) => {
  const mirror = require('./mirror');
  const out = await mirror.onNotify(req.body || {});
  if (!out.ok) return res.status(403).json({ ok: false });
  await mirror.processQueue({ budgetMs: 5000, limit: 50 }).catch(() => {});
  res.json({ ok: true });
}));
/* Live updates: an admin pastes a Self Client code with ZohoCRM.notifications.ALL */
r.post('/admin/backup/live', ...backupGuard, wrap(async (req, res) => {
  const mirror = require('./mirror');
  const code = String(req.body?.code || '').trim();
  if (!/^1000\.[\w.]+$/.test(code)) return res.status(400).json({ error: 'That does not look like a Zoho grant code (it starts with 1000.)' });
  try { await mirror.connectNotify(code); } catch (e) { return res.status(400).json({ error: e.message }); }
  const site = netlifySite(req) || siteUrl(req);
  try { await mirror.ensureWatch(site, { force: true }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  await audit(req.user.id, 'backup.liveConnected', null, req.ip);
  res.json((await mirror.mirrorStatus()).live);
}));

/* Copy Zoho now (in the background on the live site) */
r.post('/admin/backup/mirror', ...backupGuard, wrap(async (req, res) => {
  const site = netlifySite(req);
  if (site && await kickBackground(site, 'nightly-background')) return res.json({ started: true });
  const out = await require('./mirror').runMirror({ budgetMs: 8000 });
  res.json({ started: false, ...out });
}));
r.put('/admin/backup/email', ...backupGuard, wrap(async (req, res) => {
  const list = String(req.body?.email || '').split(/[,;\s]+/).filter(Boolean);
  if (list.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return res.status(400).json({ error: 'That does not look like an email address' });
  await q.setSetting('backup_email', list.join(', '));
  res.json({ to: await backupTo(), extra: list.join(', ') });
}));
r.post('/admin/backup/send', ...backupGuard, wrap(async (req, res) => {
  // On the live site it's made in the background: the Zoho copy makes it too big to build in the time a button gets
  const site = netlifySite(req);
  if (site && await kickBackground(site, 'nightly-background?send=1')) {
    await audit(req.user.id, 'backup.sent', { to: await backupTo(), background: true }, req.ip);
    return res.json({ started: true, to: await backupTo() });
  }
  const out = await sendBackup();
  await audit(req.user.id, 'backup.sent', { to: out.to }, req.ip);
  if (out.skipped) return res.status(400).json({ error: 'There is no email address to send it to' });
  if (!out.ok) return res.status(502).json({ error: out.error || 'The email could not be sent' });
  res.json(out);
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
/* Every rep named on a ring in Zoho, with their email and phone. Used by the
   Reps screen, each rep's page, invitations and messages. Read from Zoho at
   most every 10 minutes and shared in the database by every copy of the
   server; a busy Zoho is never waited on for more than 3 seconds (the saved
   list is used). Asking Zoho each time was most of the wait on those screens. */
const REPS_KEY = 'reps_directory_cache';
async function repsDirectoryFromZoho() {
  const rings = (await zoho.coql(queries.repsOnRings())).map(fromZoho.ring);
  const byRep = new Map();
  rings.forEach(ring => {
    if (!ring.repZohoId) return;
    if (!byRep.has(ring.repZohoId)) byRep.set(ring.repZohoId, { contactId: ring.repZohoId, name: ring.repName || 'Unnamed rep', rings: 0, ringNames: [], regions: [] });
    const e = byRep.get(ring.repZohoId);
    e.rings++;
    if (e.ringNames.length < 6) e.ringNames.push(ring.name);
    if (ring.regionName && !e.regions.includes(ring.regionName)) e.regions.push(ring.regionName);
  });
  const ids = [...byRep.keys()];
  const batches = await Promise.all(chunk(ids, 50).map(b => zoho.coql(queries.contactsByIds(b)).catch(() => [])));
  batches.flat().map(fromZoho.member).forEach(c => {
    const e = byRep.get(c.id);
    if (e) { e.email = c.email || ''; e.phone = c.phone || ''; e.business = c.business || ''; }
  });
  const list = [...byRep.values()];
  q.setSetting(REPS_KEY, JSON.stringify({ at: Date.now(), list })).catch(() => {});
  return list;
}
let repsDirMem = null;
async function repsDirectory(fresh) {
  if (!fresh && repsDirMem && Date.now() - repsDirMem.at < 10 * 60000) return repsDirMem.list;
  let saved = null; try { saved = JSON.parse(await setting(REPS_KEY, 'null')); } catch { saved = null; }
  if (!fresh && saved && Array.isArray(saved.list) && Date.now() - saved.at < 10 * 60000) { repsDirMem = saved; return saved.list; }
  const live = repsDirectoryFromZoho().then(list => { repsDirMem = { at: Date.now(), list }; return list; });
  if (fresh || !saved || !Array.isArray(saved.list)) return live;
  live.catch(() => {});
  return Promise.race([live.catch(() => saved.list), new Promise(r => setTimeout(() => r(saved.list), 3000))]);
}
r.get('/admin/reps-from-zoho', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const [list, existing] = await Promise.all([repsDirectory(req.query.fresh === '1'), q.allUsers()]);
  const byContact = new Map(existing.filter(u => u.zoho_owner_id).map(u => [u.zoho_owner_id, u]));
  res.json(list.map(e => ({ ...e, hasAccount: byContact.has(e.contactId), account: byContact.get(e.contactId) || null }))
    .sort((a, b) => b.rings - a.rings));
}));

/**
 * Director accounts are the keys to everything, so only the owner can make
 * one or reset, email or remove one. (Before an owner is claimed, directors
 * keep the say they always had.) Nobody can remove the owner.
 */
async function mayManageDirectors(user) {
  return user.owner || (!(await access.ownerId()) && user.role === 'admin');
}
async function guardTarget(req, res, target) {
  if (target.id === await access.ownerId() && req.user.id !== target.id) {
    res.status(403).json({ error: "That is the owner's account. Only the owner can change it." });
    return false;
  }
  if (target.role === 'admin' && !(await mayManageDirectors(req.user))) {
    res.status(403).json({ error: 'Only the owner can change a director account.' });
    return false;
  }
  return true;
}

/** Create an account straight from a Zoho rep, no typing of ids. */
r.post('/admin/users/from-zoho', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const { contactId, name, email, role } = req.body || {};
  if (!contactId || !name) return res.status(400).json({ error: 'A Zoho contact and name are required' });
  if (!email) return res.status(400).json({ error: 'That rep has no email in Zoho — add one there, or create the account manually' });
  if (role === 'admin' && !(await mayManageDirectors(req.user))) return res.status(403).json({ error: 'Only the owner can make someone a director.' });

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
    const sent = await sendPasswordLink({ id, name, email }, req, { invite: true, from: req.user, queue: true });
    emailed = !!(sent && sent.ok === true);
    if (emailed) await sendQueuedMail(req);
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
r.get('/admin/mail-status', auth.authRequired, access.requirePerm('system'), wrap(async (req, res) => {
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

  // Mail arriving for you but not for reps is almost always this. Sending as
  // noreply@symbiz.org through someone's Gmail fails the domain checks, and
  // Yahoo and iCloud (where most reps are) bin or bounce it. Your own inbox
  // trusts the account, so it looks fine from where you sit.
  const domainOf = s => (String(s || '').match(/@([^>\s]+)/) || [])[1]?.toLowerCase() || '';
  const fromDomain = domainOf(m.from), userDomain = domainOf(m.user);
  if (fromDomain && userDomain && /@/.test(m.user) && fromDomain !== userDomain) {
    problems.push(`MAIL_FROM is @${fromDomain} but mail is sent through ${userDomain}. ` +
      `Yahoo, iCloud and Outlook will reject or junk it. Set MAIL_FROM to an address at @${userDomain}, ` +
      `or send through a mailbox on ${fromDomain}.`);
  }

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
r.post('/admin/mail-test', auth.authRequired, access.requirePerm('system'), wrap(async (req, res) => {
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

r.get('/admin/users', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  res.json(await q.allUsers());
}));

r.post('/admin/users', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const { email, name, role, region, phone, password, zohoContactId } = req.body || {};
  if (!email || !name || !role) return res.status(400).json({ error: 'email, name and role are required' });
  if (!['rep', 'staff', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role === 'admin' && !(await mayManageDirectors(req.user))) return res.status(403).json({ error: 'Only the owner can make someone a director.' });
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
r.post('/admin/users/:id/reset-password', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const user = await q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such account' });
  if (!(await guardTarget(req, res, user))) return;
  const temp = Math.random().toString(36).slice(2, 10);
  await q.setPassword(auth.hash(temp), user.id);
  await audit(req.user.id, 'user.passwordReset', { id: user.id, email: user.email }, req.ip);
  res.json({ tempPassword: temp, email: user.email, name: user.name });
}));

/** Reset someone's password and email them the new one. */
r.post('/admin/users/:id/resend', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const users = await q.allUsers();
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'No such account' });
  if (!(await guardTarget(req, res, u))) return;
  // Prefer sending a link so they choose their own. Only fall back to a
  // generated password when email cannot go out, so nobody is locked out.
  const sent = await sendPasswordLink(u, req, { invite: false, queue: true });
  if (sent && sent.ok === true) {
    await sendQueuedMail(req);
    await audit(req.user.id, 'user.resetLinkSent', { id: u.id }, req.ip);
    return res.json({ emailed: true, sentTo: u.email });
  }
  const temp = makePassword();
  await q.setPassword(auth.hash(temp), u.id);
  await audit(req.user.id, 'user.passwordReset', { id: u.id }, req.ip);
  res.json({ tempPassword: temp, emailed: false });
}));

/**
 * Link an account to the rep's Zoho contact. When that rep already has an
 * account (invited at the email Zoho holds, while they signed up with
 * another), the two become one: keep = 'this' keeps this account's email and
 * password, 'other' keeps the other's. Hours, expenses and requests under
 * either stay, now under the one account.
 */
r.post('/admin/users/:id/link', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const contactId = String(req.body?.contactId || '').trim();
  if (!contactId) return res.status(400).json({ error: 'Pick the rep in Zoho' });
  const everyone = await q.everyUser();
  const target = everyone.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  if (target.role !== 'rep') return res.status(400).json({ error: 'Only rep accounts are linked to a Zoho rep' });
  if (!(await guardTarget(req, res, target))) return;
  const other = everyone.find(u => u.zoho_owner_id === contactId && u.id !== target.id);
  if (other && other.role !== 'rep') return res.status(409).json({ error: `That Zoho contact is already linked to ${other.name}'s office account` });
  if (other && !(await guardTarget(req, res, other))) return;
  let keep = target, drop = other || null;
  if (other && req.body?.keep === 'other') { keep = other; drop = target; }
  if (drop) await q.mergeUserInto(drop.id, keep.id);
  await q.linkZoho(keep.id, contactId);
  // Their hours and expenses carry the rep's name as Zoho has it
  if (req.body?.name) {
    const nm = String(req.body.name).slice(0, 120);
    await query('UPDATE time_entries SET rep_name = $1 WHERE user_id = $2', [nm, keep.id]);
    await query('UPDATE expenses SET rep_name = $1 WHERE user_id = $2', [nm, keep.id]);
  }
  await query('UPDATE pending_writes SET rep_zoho_id = $1 WHERE rep_id = $2 AND rep_zoho_id IS NULL', [contactId, keep.id]);
  await audit(req.user.id, 'user.linked', { kept: keep.id, keptEmail: keep.email, merged: drop ? drop.email : null, contactId }, req.ip);
  dropSnapshot();
  res.json({ ok: true, kept: { id: keep.id, email: keep.email }, merged: drop ? { id: drop.id, email: drop.email } : null });
}));

/* Change the email someone signs in with, and that Rep Hub writes to (Dave
   Mullet: his Symbiz address rather than his business one). Zoho is left as
   it is. Their password stays the same. */
r.put('/admin/users/:id/email', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That does not look like an email address' });
  const everyone = await q.everyUser();
  const target = everyone.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  if (!(await guardTarget(req, res, target))) return;
  const other = everyone.find(u => u.id !== target.id && String(u.email).toLowerCase() === email);
  if (other) return res.status(409).json({ error: `${email} is already used by ${other.name}'s account` });
  const before = target.email;
  await q.setEmail(target.id, email);
  await q.dropTokensFor(target.id).catch(() => {});        // old sign-in links stop working
  dropSnapshot();
  await audit(req.user.id, 'user.emailChanged', { id: target.id, from: before, to: email }, req.ip);
  // Tell both addresses, so a change nobody asked for is noticed
  const e = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<p>${e((target.name || '').split(' ')[0] || 'Hello')},</p><p>${e(req.user.name)} changed the email you sign in to Rep Hub with
    from <strong>${e(before)}</strong> to <strong>${e(email)}</strong>. Your password is the same.</p>
    <p><a href="${cfg.appUrl}">Open Rep Hub</a></p>`;
  for (const to of [email, before]) reminders.sendEmail(to, 'Your Rep Hub sign-in email changed', html, { userId: target.id, kind: 'email-changed' }).catch(() => {});
  res.json({ ok: true, email });
}));

/* Both office and rep, in one sign-in (Mel, Dale). An office account is linked
   to the person's own rep record in Zoho; it keeps its office access and gets
   a switch to their rep view, with their own rings, calls and hours. */
const mayGiveOffice = async u => u.role === 'admin' || await access.isOwner(u);
r.post('/admin/users/:id/rep-link', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const contactId = String(req.body?.contactId || '').replace(/[^0-9]/g, '');
  const everyone = await q.everyUser();
  const target = everyone.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  if (target.role === 'rep') return res.status(400).json({ error: 'This is already a rep account' });
  if (!(await guardTarget(req, res, target))) return;
  if (contactId) {
    const other = everyone.find(u => u.zoho_owner_id === contactId && u.id !== target.id);
    if (other && other.role !== 'rep') return res.status(409).json({ error: `That rep is already linked to ${other.name}'s office account` });
    if (other && !req.body?.merge) {
      return res.status(409).json({ error: `${other.name} already has a rep account (${other.email}).`, conflict: { id: other.id, email: other.email, name: other.name } });
    }
    // Their rep account folds into this one: one sign-in for both
    if (other) await q.mergeUserInto(other.id, target.id);
  }
  await q.setZohoContact(target.id, contactId || null);
  if (contactId) await query('UPDATE pending_writes SET rep_zoho_id = $1 WHERE rep_id = $2 AND rep_zoho_id IS NULL', [contactId, target.id]);
  dropSnapshot();
  await audit(req.user.id, 'user.repLink', { id: target.id, contactId: contactId || null }, req.ip);
  res.json({ ok: true, id: target.id, contactId: contactId || null });
}));
/* A rep who also works in the office (Dale): office access, keeping their rings */
r.post('/admin/users/:id/office-access', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  if (!(await mayGiveOffice(req.user))) return res.status(403).json({ error: 'Only the owner or a director can give office access' });
  const target = await q.userById(req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  if (!(await guardTarget(req, res, target))) return;
  const on = req.body?.on !== false;
  if (on && target.role !== 'rep') return res.status(400).json({ error: 'They already have office access' });
  if (!on && target.role !== 'staff') return res.status(400).json({ error: 'Only office staff can be made rep-only' });
  if (!on && !target.zoho_owner_id) return res.status(400).json({ error: 'They are not linked to a rep in Zoho' });
  await q.setRole(target.id, on ? 'staff' : 'rep');
  dropSnapshot();
  await audit(req.user.id, on ? 'user.officeGranted' : 'user.officeRemoved', { id: target.id }, req.ip);
  res.json({ ok: true, role: on ? 'staff' : 'rep' });
}));

r.delete('/admin/users/:id', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove your own account" });
  const everyone = await q.everyUser();
  const target = everyone.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  if (!(await guardTarget(req, res, target))) return;
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

r.get('/admin/audit', auth.authRequired, access.requirePerm('system'), wrap(async (req, res) => {
  res.json(await q.recentAudit(parseInt(req.query.limit || '100', 10)));
}));

/**
 * Settings the office can change. Listed explicitly: the same table holds
 * the Zoho tokens and the schema version, which nobody should overwrite from
 * a form. The accounting address used to live only in the browser, so the
 * server always mailed the default no matter what was typed in.
 */
const OFFICE_SETTINGS = {
  retryDays: '4', rescheduleDays: '7', dueWindow: String(cfg.reminders.dueWindowDays), announcement: '',
  accountingEmail: 'accounting@symbiz.org', accountingDay: '1',
  booksAuto: 'on', booksPayee: 'rep', booksAccount: books.DEFAULT_FALLBACK, booksAccountMap: '{}',
  supportName: 'Ashish Raj', supportPhone: '540-212-9403',
  registrationApprovers: '',
};

/** Who to ring for help — shown on the sign-in screen, so no sign-in needed. */
r.get('/support', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ name: await setting('supportName', OFFICE_SETTINGS.supportName), phone: await setting('supportPhone', OFFICE_SETTINGS.supportPhone) });
}));

r.get('/admin/settings', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const out = {};
  for (const [k, d] of Object.entries(OFFICE_SETTINGS)) out[k] = await setting(k, d);
  ['retryDays', 'rescheduleDays', 'dueWindow'].forEach(k => { out[k] = parseInt(out[k], 10); });
  res.json(out);
}));

// Accounting and Books settings need the "books" capability; the rest need "settings"
const BOOKS_SETTINGS = ['accountingEmail', 'accountingDay', 'booksAuto', 'booksPayee', 'booksAccount', 'booksAccountMap'];

r.put('/admin/settings', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const saved = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!(k in OFFICE_SETTINGS)) continue;
    const need = BOOKS_SETTINGS.includes(k) ? 'books' : 'settings';
    if (!req.user.perms[need]) {
      return res.status(403).json({ error: `Your account cannot change ${need === 'books' ? 'accounting or Zoho Books' : 'app'} settings. Ask the owner.` });
    }
    let val = String(v ?? '').trim().slice(0, 500);
    if (k === 'accountingEmail' && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      return res.status(400).json({ error: 'That accounting address does not look like an email' });
    }
    if (k === 'registrationApprovers') {
      const bad = val.split(/[\s,;]+/).filter(Boolean).find(x => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
      if (bad) return res.status(400).json({ error: `"${bad}" does not look like an email address` });
      val = val.split(/[\s,;]+/).filter(Boolean).map(x => x.toLowerCase()).join(', ');
    }
    if (k === 'accountingDay' && !['1', '15', 'Last', 'Off'].includes(val)) continue;
    if (k === 'booksPayee' && !['rep', 'vendor'].includes(val)) continue;
    if (k === 'booksAuto' && !['on', 'off'].includes(val)) continue;
    if (k === 'booksAccountMap') {
      // { category: account name } — stored as JSON, nothing else
      let m; try { m = typeof v === 'object' ? v : JSON.parse(val); } catch (_) { continue; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      val = JSON.stringify(Object.fromEntries(Object.entries(m).slice(0, 30)
        .map(([c, a]) => [String(c).slice(0, 60), String(a ?? '').slice(0, 120)])));
    }
    await q.setSetting(k, val);
    saved[k] = val;
  }
  await audit(req.user.id, 'settings.updated', saved, req.ip);
  res.json({ ok: true, saved });
}));

/* ═══════════ ACCESS & SECURITY (owner) ═══════════
 * Who can do what, and who signs in with a code. Reading and changing it
 * needs the owner AND their password re-typed in the last 15 minutes. */

/** Is there an owner yet? Any office account may ask (it drives the claim prompt). */
r.get('/admin/access/status', auth.authRequired, auth.requireOffice, wrap(async (req, res) => {
  const id = await access.ownerId();
  const owner = id ? await q.userById(id) : null;
  res.json({ claimed: !!owner, ownerName: owner ? owner.name : null, you: !!req.user.owner,
    canClaim: !owner && req.user.role === 'admin' });
}));

/** Becoming the owner, once. A director, their password, and nobody got there first. */
r.post('/admin/access/claim', auth.authRequired, auth.requireAdmin, auth.requireElevated, wrap(async (req, res) => {
  if (await access.ownerId()) return res.status(409).json({ error: 'Rep Hub already has an owner.' });
  await access.setOwner(req.user.id);
  await audit(req.user.id, 'access.ownerClaimed', {}, req.ip);
  // Every other director hears about it, so a wrong claim cannot go unnoticed
  const others = (await q.allOffice()).filter(u => u.role === 'admin' && u.id !== req.user.id);
  for (const u of others) {
    reminders.sendEmail(u.email, 'Rep Hub now has an owner',
      `<p>${esc(req.user.name)} (${esc(req.user.email)}) is now the owner of Rep Hub and controls who can do what.</p>
       <p>If that is not right, contact them or Prosynergy straight away.</p>`, { userId: u.id, kind: 'security' }).catch(() => {});
  }
  res.json({ ok: true, user: await auth.withAccess(await q.userById(req.user.id)) });
}));

async function accessPayload() {
  const [a, users, ck] = await Promise.all([access.load(), q.allUsers(), captchaKeys()]);   // side by side
  const people = users.filter(u => u.role !== 'rep')
    .map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, owner: u.id === a.ownerId }));
  return { caps: Object.fromEntries(Object.entries(access.CAPS).map(([k, c]) => [k, { label: c.label, detail: c.detail, group: c.group }])),
    perms: a.perms, twoStep: a.twoStep, people, ownerId: a.ownerId,
    captcha: { siteKey: ck.site || '', secretSet: !!ck.secret, type: ck.type, proven: ck.proven } };
}

r.get('/admin/access', auth.authRequired, access.requireOwner, auth.requireElevated, wrap(async (req, res) => {
  res.json(await accessPayload());
}));

r.put('/admin/access', auth.authRequired, access.requireOwner, auth.requireElevated, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.perms) await access.savePermissions(b.perms);
  if (b.twoStep) await access.saveTwoStep(b.twoStep);
  if (b.captcha) {
    // reCAPTCHA keys are 40 characters of letters, digits, - and _. Blank both to switch it off.
    const site = String(b.captcha.siteKey || '').trim(), secret = String(b.captcha.secret || '').trim();
    const ok = s => /^[A-Za-z0-9_-]{20,80}$/.test(s);
    captchaCache = null;
    if (!site && !secret) { await q.setSetting('captcha_site_key', ''); await q.setSetting('captcha_secret', ''); }
    else {
      if (!ok(site)) return res.status(400).json({ error: 'That site key does not look right — copy it again from Google.' });
      if (secret && !ok(secret)) return res.status(400).json({ error: 'That secret key does not look right — copy it again from Google.' });
      if (!secret && !(await captchaKeys()).secret) return res.status(400).json({ error: 'Paste the secret key as well.' });
      await q.setSetting('captcha_site_key', site);
      if (secret) await q.setSetting('captcha_secret', secret);
      const detected = await detectCaptchaType(site, siteUrl(req));
      await q.setSetting('captcha_type', detected || (b.captcha.type === 'v2' ? 'v2' : 'v3'));
      await q.setSetting('captcha_proven', '');     // new keys must prove themselves before they can block anyone
    }
  }
  captchaCache = null;
  await audit(req.user.id, 'access.changed', { perms: b.perms || undefined, twoStep: b.twoStep || undefined,
    captcha: b.captcha ? (b.captcha.siteKey ? 'on' : 'off') : undefined }, req.ip);
  res.json(await accessPayload());
}));

/** Change an office person's role (rep / office staff / director). */
r.post('/admin/access/role', auth.authRequired, access.requireOwner, auth.requireElevated, wrap(async (req, res) => {
  const { userId, role } = req.body || {};
  if (!['rep', 'staff', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (userId === req.user.id) return res.status(400).json({ error: "You can't change your own role" });
  const u = await q.userById(String(userId || ''));
  if (!u || u.active === false) return res.status(404).json({ error: 'No such account' });
  await q.setRole(u.id, role);
  await audit(req.user.id, 'access.roleChanged', { id: u.id, from: u.role, to: role }, req.ip);
  res.json(await accessPayload());
}));

/** Hand the keys to another director. The old owner becomes a director. */
r.post('/admin/access/transfer', auth.authRequired, access.requireOwner, auth.requireElevated, wrap(async (req, res) => {
  const u = await q.userById(String(req.body?.userId || ''));
  if (!u || u.active === false || u.role !== 'admin') return res.status(400).json({ error: 'Ownership can only go to a director' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You are already the owner' });
  await access.setOwner(u.id);
  await audit(req.user.id, 'access.ownerTransferred', { to: u.id }, req.ip);
  res.json({ ok: true });
}));

/* ═══════════ ZOHO BOOKS ═══════════ */
r.get('/admin/books-status', auth.authRequired, access.requirePerm('books'), wrap(async (req, res) => {
  const st = await books.status();
  const pending = st.configured ? (await q.billsToMake(500, true)) : [];
  const weeks = st.configured ? books.hourWeeks(await q.timeBillsToMake(1000, true)) : [];
  // Hours sent to accounting before hours were billed: offered to bill now
  const unbilled = st.configured ? (await query("SELECT COUNT(*)::int AS n FROM time_entries WHERE status = 'Reimbursed' AND books_bill_id IS NULL AND books_queued = FALSE").catch(() => [{ n: 0 }]))[0].n : 0;
  res.json({ ...st,
    waiting: pending.filter(x => !x.books_error).length + weeks.filter(g => !g.rows.some(r => r.books_error)).length,
    failed: [
      ...pending.filter(x => x.books_error).map(x => ({ id: 'E' + x.id, rep: x.rep_name, amount: Number(x.amount), error: x.books_error })),
      ...weeks.filter(g => g.rows.some(r => r.books_error)).map(g => ({ id: 'Hours ' + g.week.start, rep: g.rep,
        hours: g.rows.reduce((s, r) => s + Number(r.hours), 0), error: g.rows.find(r => r.books_error).books_error })),
    ],
    unbilledHours: unbilled,
  });
}));

/* Each rep's hourly rate, for the hours bills */
r.get('/admin/books/rates', auth.authRequired, access.requirePerm('books'), wrap(async (req, res) => {
  const rates = await books.hourlyRates();
  const reps = (await q.allUsers()).filter(u => u.role === 'rep').map(u => ({ id: u.id, name: u.name }));
  // Office people who log hours too (Mel works as a rep as well)
  const others = (await query('SELECT DISTINCT t.user_id AS id, u.name FROM time_entries t JOIN users u ON u.id = t.user_id').catch(() => []))
    .filter(x => !reps.some(r => r.id === x.id));
  res.json({ default: rates.def || null, rates: rates.map, people: [...reps, ...others].sort((a, b) => String(a.name).localeCompare(String(b.name))) });
}));
r.put('/admin/books/rates', auth.authRequired, access.requirePerm('books'), wrap(async (req, res) => {
  const b = req.body || {};
  const num = v => { const n = Math.round(Number(v) * 100) / 100; return n > 0 && n < 1000 ? n : null; };
  const map = {};
  Object.entries(b.rates || {}).slice(0, 300).forEach(([id, v]) => { const n = num(v); if (n) map[String(id).slice(0, 80)] = n; });
  await q.setSetting('repHourlyRates', JSON.stringify(map));
  if (b.default !== undefined) await q.setSetting('defaultHourlyRate', num(b.default) ? String(num(b.default)) : '');
  await audit(req.user.id, 'books.rates', { reps: Object.keys(map).length, default: num(b.default) }, req.ip);
  const rates = await books.hourlyRates();
  res.json({ default: rates.def || null, rates: rates.map });
}));

/** Try again, including ones that failed — after fixing an account name, say. */
r.post('/accounting/books-retry', auth.authRequired, access.requirePerm('books'), wrap(async (req, res) => {
  if (!(await books.configured())) return res.status(400).json({ error: 'Zoho Books is not connected yet' });
  // Hours already sent to accounting that never got a bill are billed now too
  const backfilled = await q.queueSentTimeWithoutBill();
  const out = await books.makeBills({ includeFailed: true, budgetMs: 8000 });
  out.backfilledHours = backfilled.length;
  await audit(req.user.id, 'books.retry', out, req.ip);
  res.json(out);
}));

/** An admin pastes a Self Client grant code; Rep Hub keeps the token. */
r.post('/admin/books-connect', auth.authRequired, auth.requireAdmin, access.requirePerm('books'), wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^1000\.[\w.]+$/.test(code)) return res.status(400).json({ error: 'That does not look like a Zoho grant code (it starts with 1000.)' });
  try { await books.connect(code); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  await audit(req.user.id, 'books.connected', {}, req.ip);
  res.json({ ok: true, ...(await books.status()) });
}));

r.post('/admin/books-disconnect', auth.authRequired, auth.requireAdmin, access.requirePerm('books'), wrap(async (req, res) => {
  await books.disconnect();
  await audit(req.user.id, 'books.disconnected', {}, req.ip);
  res.json({ ok: true });
}));

/* ═══════════ MANAGING THE REPS ═══════════
 * What Mel needs to run the team: early warnings, a visit plan, goals,
 * check-in notes, moving rings between reps and messaging them. All behind
 * the `manager` access, so a director has it without seeing the accounts.
 */
const manager = require('./manager');
const mgrGuard = [auth.authRequired, auth.requireOffice, access.requirePerm('manager')];
let snapCache = null;                  // { at, data } — the team picture is ~10 Zoho reads
async function snapshot(fresh) {
  if (!fresh && snapCache && Date.now() - snapCache.at < 5 * 60 * 1000) return snapCache.data;
  const data = await manager.teamSnapshot();
  snapCache = { at: Date.now(), data };
  return data;
}
// Moving rings changes who the reps are: forget the saved lists everywhere
const dropSnapshot = () => { snapCache = null; repEmailCache = null; repsDirMem = null; q.setSetting(REPS_KEY, '').catch(() => {}); };

r.get('/manager/snapshot', ...mgrGuard, wrap(async (req, res) => {
  const snap = await snapshot(!!req.headers['x-fresh'] || req.query.fresh === '1');
  const me = (await q.allUsers()).find(u => u.id === req.user.id);
  res.json({ ...snap, warnings: manager.warningsFrom(snap), digestEmail: me ? !!me.digest_email : false });
}));

r.put('/manager/digest', ...mgrGuard, wrap(async (req, res) => {
  await q.setDigestEmail(req.user.id, !!req.body?.on);
  await audit(req.user.id, 'manager.digestEmail', { on: !!req.body?.on }, req.ip);
  res.json({ ok: true, on: !!req.body?.on });
}));

/* What the last Monday email did: the run's own note, and the sends on record */
r.get('/manager/digest/last', ...mgrGuard, wrap(async (req, res) => {
  let last = null; try { last = JSON.parse(await setting('manager_digest_last', 'null')); } catch { last = null; }
  const sends = await query(`SELECT s.created_at, s.ok, s.error, u.email FROM sent_log s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.kind = 'manager-digest' ORDER BY s.created_at DESC LIMIT 12`).catch(() => []);
  res.json({ last, sends: sends.map(x => ({ at: x.created_at, ok: x.ok, error: x.error, to: x.email })) });
}));

r.post('/manager/digest/run', ...mgrGuard, wrap(async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  // "Send it to me now": this week's email, to the person asking only
  const out = await manager.runManagerDigest({ dryRun, onlyUserId: req.body?.onlyMe ? req.user.id : null });
  await audit(req.user.id, 'manager.digestRun', { dryRun }, req.ip);
  res.json({ dryRun, results: out });
}));

/* Quarterly goals: calls, visits and new members per rep */
const QUARTER_RE = /^\d{4}-Q[1-4]$/;
const goalNum = v => (v === '' || v == null) ? null : Math.max(0, Math.min(10000, parseInt(v, 10) || 0));
r.get('/reps/goals', ...mgrGuard, wrap(async (req, res) => {
  const quarter = QUARTER_RE.test(req.query.quarter || '') ? req.query.quarter : manager.quarterOf();
  const rows = await q.goalsFor(quarter);
  res.json({ quarter, goals: rows.map(g => ({ repId: g.rep_id, calls: g.calls, visits: g.visits, newMembers: g.new_members, setBy: g.set_by })) });
}));

r.put('/reps/goals/:repId', ...mgrGuard, wrap(async (req, res) => {
  const b = req.body || {};
  const quarter = QUARTER_RE.test(b.quarter || '') ? b.quarter : manager.quarterOf();
  const goal = { calls: goalNum(b.calls), visits: goalNum(b.visits), newMembers: goalNum(b.newMembers) };
  await q.setGoal(String(req.params.repId), quarter, goal, req.user.name || req.user.email);
  await audit(req.user.id, 'rep.goalSet', { repId: req.params.repId, quarter, ...goal }, req.ip);
  dropSnapshot();
  res.json({ ok: true, quarter, ...goal });
}));

/* A rep's own goals, for their Today screen */
r.get('/reps/my-goal', auth.authRequired, wrap(async (req, res) => {
  const quarter = manager.quarterOf();
  if (!req.user.zoho_owner_id) return res.json({ quarter, goal: null });
  const g = (await q.goalsFor(quarter)).find(x => x.rep_id === req.user.zoho_owner_id);
  res.json({ quarter, goal: g ? { calls: g.calls, visits: g.visits, newMembers: g.new_members } : null });
}));

/* Check-in notes, private to the office */
const noteOut = n => ({ id: n.id, repId: n.rep_id, author: n.author, note: n.note,
  nextCheckin: n.next_checkin ? String(n.next_checkin instanceof Date ? n.next_checkin.toISOString() : n.next_checkin).slice(0, 10) : null,
  at: n.created_at });
r.get('/reps/notes', ...mgrGuard, wrap(async (req, res) => {
  res.json((await q.allRepNotes()).map(noteOut));
}));
r.get('/reps/:id/notes', ...mgrGuard, wrap(async (req, res) => {
  res.json((await q.repNotes(String(req.params.id))).map(noteOut));
}));
r.post('/reps/:id/notes', ...mgrGuard, wrap(async (req, res) => {
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  const next = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.nextCheckin || '') ? req.body.nextCheckin : null;
  if (!note) return res.status(400).json({ error: 'Write a note first' });
  const row = await q.addRepNote(String(req.params.id), req.user.name || req.user.email, note, next);
  await audit(req.user.id, 'rep.noteAdded', { repId: req.params.id, nextCheckin: next }, req.ip);
  dropSnapshot();
  res.status(201).json(noteOut(row));
}));
r.delete('/reps/notes/:noteId', ...mgrGuard, wrap(async (req, res) => {
  await q.deleteRepNote(parseInt(req.params.noteId, 10) || 0);
  await audit(req.user.id, 'rep.noteDeleted', { id: req.params.noteId }, req.ip);
  dropSnapshot();
  res.json({ ok: true });
}));

/* Move a ring to another rep — saved on the ring in Zoho */
r.post('/rings/:id/reassign', ...mgrGuard, writesAllowed, wrap(async (req, res) => {
  const repZohoId = String(req.body?.repZohoId || '').replace(/[^0-9]/g, '');
  if (!repZohoId) return res.status(400).json({ error: 'Choose the rep to move it to' });
  const z = await zoho.getRecord(M.RING, req.params.id);
  if (!z) return res.status(404).json({ error: 'Unknown Growth Ring' });
  const from = fromZoho.ring(z);
  if (from.repZohoId === repZohoId) return res.json({ ok: true, unchanged: true });
  await zoho.updateRecords(M.RING, [{ id: req.params.id, Regional_Rep: { id: repZohoId } }]);
  zoho.clearCache();
  dropSnapshot();
  // A handover note travels with the ring, and goes to the new rep by email
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  if (note) {
    await q.addRingNote({ ringId: req.params.id, authorId: req.user.id, authorName: req.user.name, note, handover: true });
    const rep = (await q.allUsers()).find(u => u.zoho_owner_id === repZohoId);
    if (rep && rep.email) {
      const e = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      reminders.sendEmail(rep.email, `Ring ${from.name} is now yours`,
        `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#1E2A20;max-width:540px">
          <p>${e((rep.name || '').split(' ')[0] || 'Hello')},</p>
          <p>Ring <strong>${e(from.name)}</strong> has been moved to you${from.repName ? ' from ' + e(String(from.repName).replace(/\s*#\s*\d+$/, '')) : ''}. ${e(req.user.name)} left this for you:</p>
          <p style="white-space:pre-wrap;background:#F2F5EC;border-radius:8px;padding:12px 14px">${e(note)}</p>
          <p>It is also under <strong>Notes for whoever looks after this ring</strong> on the ring in Rep Hub, with any earlier notes.</p>
          <p><a href="${cfg.appUrl}" style="background:#2E5132;color:#fff;padding:9px 15px;border-radius:7px;text-decoration:none">Open Rep Hub</a></p></div>`,
        { userId: rep.id, kind: 'ring-handover', replyTo: req.user.email }).catch(() => {});
    }
  }
  await audit(req.user.id, 'ring.reassigned', { id: req.params.id, ring: from.name, from: from.repZohoId, to: repZohoId, note: !!note }, req.ip);
  res.json({ ok: true, ringId: req.params.id, from: from.repZohoId, to: repZohoId });
}));

/* Notes for whoever looks after a ring: passed from one rep to the next.
   The rep who has the ring now and the office can read and add to them. */
async function mayUseRing(user, ringId) {
  if (user.role !== 'rep') return true;
  const { ringIds } = await scopeRings(user);
  return ringIds.includes(String(ringId));
}
r.get('/rings/:id/notes', auth.authRequired, wrap(async (req, res) => {
  if (!(await mayUseRing(req.user, req.params.id))) return res.status(403).json({ error: 'Not your ring' });
  res.json(await q.ringNotes(req.params.id));
}));
r.post('/rings/:id/notes', auth.authRequired, wrap(async (req, res) => {
  if (!(await mayUseRing(req.user, req.params.id))) return res.status(403).json({ error: 'Not your ring' });
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  if (!note) return res.status(400).json({ error: 'Write the note first' });
  await q.addRingNote({ ringId: req.params.id, authorId: req.user.id, authorName: req.user.name, note });
  await audit(req.user.id, 'ring.note', { ringId: req.params.id }, req.ip);
  res.status(201).json(await q.ringNotes(req.params.id));
}));
r.delete('/rings/:id/notes/:noteId', auth.authRequired, wrap(async (req, res) => {
  const notes = await q.ringNotes(req.params.id);
  const n = notes.find(x => String(x.id) === String(req.params.noteId));
  if (!n) return res.status(404).json({ error: 'No such note' });
  // Your own note, or the office
  if (n.author_id !== req.user.id && req.user.role === 'rep') return res.status(403).json({ error: 'Only the person who wrote it can remove it' });
  await q.deleteRingNote(n.id, req.params.id);
  res.json(await q.ringNotes(req.params.id));
}));

/* Getting the reps signed in: who has started, and one-click invitations.
   A rep with no account gets one (linked to their Zoho contact) and a
   welcome email with a link to choose their password; a rep who has an
   account but never signed in gets a fresh link. */
async function repOnboarding() {
  const [reps, users, invites] = await Promise.all([repEmails(), q.allUsers(), q.lastInvites()]);
  const invited = new Map(invites.map(i => [i.user_id, i.at]));
  return reps.map(r => {
    const u = users.find(x => x.zoho_owner_id === r.id);
    const at = u && invited.get(u.id) ? new Date(invited.get(u.id)).toISOString() : null;
    const status = u && u.last_login_at ? 'active' : u && at ? 'invited' : u ? 'account' : r.email ? 'none' : 'noemail';
    return { id: r.id, name: r.name, email: (u && u.email) || r.email || '', status,
      lastLogin: u && u.last_login_at ? new Date(u.last_login_at).toISOString() : null, invitedAt: at };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
/* Inviting is open to whoever manages reps (Rep manager) or manages accounts (Reps screen) */
function inviteGuard(req, res, next) {
  if (!req.user.perms || !(req.user.perms.manager || req.user.perms.users)) {
    return res.status(403).json({ error: 'Your account does not have access to inviting reps. Ask the owner.' });
  }
  next();
}
const inviteGuards = [auth.authRequired, auth.requireOffice, inviteGuard];
r.get('/reps/onboarding', ...inviteGuards, wrap(async (req, res) => { res.json(await repOnboarding()); }));

/* Undo: remove rep accounts that were made but never used, so the reps can be
   invited afresh. An account anyone has signed in with is never touched. */
r.post('/admin/users/remove-unused', auth.authRequired, access.requirePerm('users'), wrap(async (req, res) => {
  const want = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
  const unused = (await q.allUsers()).filter(u => u.role === 'rep' && !u.last_login_at && u.zoho_owner_id && u.id !== req.user.id
    && (!want || want.has(u.id)));
  for (const u of unused) {
    await q.dropTokensFor(u.id);
    await q.hardDelete(u.id);
  }
  await audit(req.user.id, 'users.removedUnused', { count: unused.length, emails: unused.map(u => u.email) }, req.ip);
  dropSnapshot();
  res.json({ removed: unused.map(u => ({ id: u.id, name: u.name, email: u.email })) });
}));

r.post('/reps/invite', ...inviteGuards, wrap(async (req, res) => {
  const want = req.body?.repIds;
  const list = (await repOnboarding()).filter(x => want === 'all' ? x.status !== 'active' : (want || []).map(String).includes(x.id));
  const users = await q.allUsers();
  const out = [];
  for (const rep of list) {
    if (rep.status === 'active') { out.push({ id: rep.id, name: rep.name, skipped: 'already signed in' }); continue; }
    if (!rep.email) { out.push({ id: rep.id, name: rep.name, skipped: 'no email in Zoho' }); continue; }
    let u = users.find(x => x.zoho_owner_id === rep.id);
    if (!u) {
      if (users.some(x => String(x.email).toLowerCase() === rep.email.toLowerCase())) {
        out.push({ id: rep.id, name: rep.name, skipped: 'that email belongs to another account' }); continue;
      }
      const id = 'u_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
      await q.insertUser({ id, email: rep.email, name: splitName(rep.name), phone: null, role: 'rep', region: null,
        password_hash: unusablePassword(), zoho_owner_id: rep.id });
      u = { id, email: rep.email, name: splitName(rep.name) };
      await audit(req.user.id, 'user.createdFromZoho', { id, contactId: rep.id, email: rep.email, by: 'invite' }, req.ip);
    }
    const sent = await sendPasswordLink(u, req, { invite: true, from: req.user, queue: true });
    out.push({ id: rep.id, name: rep.name, sent: !!(sent && sent.ok), error: sent && !sent.ok ? (sent.error || 'not sent') : undefined });
  }
  await audit(req.user.id, 'reps.invited', { sent: out.filter(x => x.sent).length, asked: list.length }, req.ip);
  await sendQueuedMail(req);
  res.json({ results: out, sent: out.filter(x => x.sent).length });
}));
/* Send what is in the outbox: by the background job on the live site
   (answers at once), right here anywhere else */
async function sendQueuedMail(req) {
  const site = netlifySite(req);
  if (site && await kickBackground(site, 'mail-background')) return;
  await reminders.flushOutbox({ budgetMs: 8000 }).catch(() => {});
}
/* A password nobody knows, for an account that will set its own from the
   invitation. Worked out once: hashing a fresh one each time cost a tenth of
   a second per rep. */
let unusableHash = null;
const unusablePassword = () => unusableHash || (unusableHash = auth.hash(crypto.randomBytes(24).toString('hex')));
/* "Dale Savage #0842" → "Dale Savage": the number is Zoho's, not part of their name */
const splitName = n => String(n || '').replace(/\s*#\s*\d+\s*$/, '').trim() || 'Rep';

/* Message reps: one email, reps in BCC, replies go to the sender */
let repEmailCache = null;           // { at, list } — addresses rarely change; Zoho is slow to ask
async function repEmails(fresh) {
  if (!fresh && repEmailCache && Date.now() - repEmailCache.at < 10 * 60 * 1000) return repEmailCache.list;
  const list = await repEmailsFromZoho();
  repEmailCache = { at: Date.now(), list };
  return list;
}
async function repEmailsFromZoho() {
  // The same shared, saved list the Reps screen uses
  const dir = await repsDirectory();
  const ids = dir.map(d => d.contactId);
  const names = new Map(dir.map(d => [d.contactId, d.name]));
  const emails = new Map(dir.filter(d => d.email).map(d => [d.contactId, d.email]));
  // A rep's Rep Hub sign-in email wins over Zoho's, it is the one they read
  (await q.allUsers()).forEach(u => { if (u.zoho_owner_id && u.email && names.has(u.zoho_owner_id)) emails.set(u.zoho_owner_id, u.email); });
  return ids.map(id => ({ id, name: names.get(id) || 'Rep', email: emails.get(id) || '' }));
}

r.get('/messages/reps', ...mgrGuard, wrap(async (req, res) => {
  const [reps, history] = await Promise.all([repEmails(), q.recentRepMessages()]);
  res.json({ reps, history: history.map(m => ({ id: m.id, by: m.sent_by, subject: m.subject, body: m.body,
    recipients: String(m.recipients || '').split(',').filter(Boolean).length, at: m.created_at })) });
}));

r.post('/messages/reps', ...mgrGuard, wrap(async (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || '').trim().slice(0, 200);
  const body = String(b.body || '').trim().slice(0, 20000);
  if (!subject || !body) return res.status(400).json({ error: 'A subject and a message are both needed' });
  const all = await repEmails();
  const chosen = b.repIds === 'all' ? all : all.filter(x => (b.repIds || []).map(String).includes(x.id));
  const to = [...new Set(chosen.map(x => x.email).filter(Boolean))];
  if (!to.length) return res.status(400).json({ error: 'None of the chosen reps has an email address' });
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1E2A20;max-width:600px">
    ${esc(body).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}
    <p style="color:#5A6455;margin-top:22px">${esc(req.user.name || '')}<br>Symbiz</p>
    <p style="color:#8A9284;font-size:12px;margin-top:18px">Sent from <a href="${cfg.appUrl}" style="color:#2E5132">Rep Hub</a>. Reply to this email to answer ${esc((req.user.name || 'the sender').split(' ')[0])}.</p></div>`;
  // Reps go in BCC so nobody's address is shared with the whole team
  const sent = await reminders.sendEmail(req.user.email, subject, html, { userId: req.user.id, kind: 'rep-message', replyTo: req.user.email, bcc: to });
  if (!sent.ok) return res.status(502).json({ error: sent.error || 'The email could not be sent' });
  await q.addRepMessage(req.user.name || req.user.email, subject, body, chosen.map(x => x.id).join(','));
  await audit(req.user.id, 'reps.messaged', { subject, count: to.length }, req.ip);
  res.json({ ok: true, sent: to.length, missing: chosen.filter(x => !x.email).map(x => x.name) });
}));

/* Visits: plan one (the ring's Next Rep Visit) and file the report afterwards */
async function ringForVisit(req, res) {
  const z = await zoho.getRecord(M.RING, req.body?.ringId);
  const ring = z ? fromZoho.ring(z) : null;
  if (!ring) { res.status(400).json({ error: 'Unknown Growth Ring' }); return null; }
  if (req.user.role === 'rep') {
    if (!req.user.zoho_owner_id || ring.repZohoId !== req.user.zoho_owner_id) { res.status(403).json({ error: 'Not your ring' }); return null; }
  } else if (!req.user.perms?.manager && !req.user.perms?.visits) {
    res.status(403).json({ error: 'Your account does not have access to visits. Ask the owner.' }); return null;
  }
  return ring;
}
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

r.post('/visits', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const date = req.body?.date;
  if (!isDate(date)) return res.status(400).json({ error: 'Pick a date for the visit' });
  const ring = await ringForVisit(req, res); if (!ring) return;
  await zoho.updateRecords(M.RING, [{ id: ring.id, Next_Rep_Visit: date }]);
  const b = req.body || {};
  await q.setVisitPlan(ring.id, { date, time: String(b.time || '').slice(0, 40), location: String(b.location || '').slice(0, 300),
    notes: String(b.notes || '').slice(0, 2000) }, req.user.name || req.user.email);
  zoho.clearCache(); dropSnapshot();
  await audit(req.user.id, 'visit.planned', { ringId: ring.id, date, forRep: ring.repZohoId }, req.ip);
  res.status(201).json({ ok: true, id: `next_${ring.id}`, ringId: ring.id, date, repZohoId: ring.repZohoId });
}));

r.post('/visits/report', auth.authRequired, writesAllowed, wrap(async (req, res) => {
  const b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: 'When was the visit?' });
  const ring = await ringForVisit(req, res); if (!ring) return;
  // The report, as one readable note on the visit record
  const parts = [
    b.attendance ? `Attendance: ${b.attendance}` : '',
    b.went ? `How it went: ${b.went}` : '',
    b.concerns ? `Concerns: ${b.concerns}` : '',
    b.followUp ? `Follow-up: ${b.followUp}` : '',
    b.notes || '',
  ].filter(Boolean).map(s => String(s).trim().slice(0, 3000));
  const repZohoId = req.user.role === 'rep' ? req.user.zoho_owner_id : ring.repZohoId;
  const out = await zoho.insertRecords(M.ACTIVITY, [toZoho.activity({
    type: 'Ring Visit', date: b.date, notes: parts.join('\n\n'), ringId: ring.id, repZohoId, outcome: 'Connected', nextDue: null,
  })]);
  const patch = { id: ring.id };
  if (!ring.lastRepVisit || b.date > ring.lastRepVisit) patch.Last_Rep_Visit = b.date;
  if (ring.nextRepVisit && ring.nextRepVisit <= b.date) { patch.Next_Rep_Visit = null; await q.dropVisitPlan(ring.id).catch(() => {}); }
  if (Object.keys(patch).length > 1) await zoho.updateRecords(M.RING, [patch]);
  zoho.clearCache(); dropSnapshot();
  const id = out[0]?.details?.id;
  await audit(req.user.id, 'visit.reported', { id, ringId: ring.id, date: b.date }, req.ip);
  res.status(201).json({ ok: true, id, ringId: ring.id, date: b.date });
}));

/* ═══════════ REMINDERS (manual trigger / preview) ═══════════ */
r.post('/reminders/run', auth.authRequired, auth.requireOffice, access.requirePerm('reminders'), wrap(async (req, res) => {
  const kind = req.body?.kind || 'weekly';
  const dryRun = req.body?.dryRun !== false;   // default to preview, not blast
  const fn = kind === 'nudge' ? reminders.runOverdueNudge
    : kind === 'office' ? reminders.runOfficeSummary
    : reminders.runWeeklyDigest;
  const out = await fn({ dryRun });
  await audit(req.user.id, 'reminder.manual', { kind, dryRun }, req.ip);
  res.json({ kind, dryRun, results: out });
}));

r._checklistFromCsv = checklistFromCsv;      // for the tests
module.exports = r;

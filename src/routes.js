'use strict';
const express = require('express');
const crypto = require('crypto');
const zoho = require('./lib/zoho');
const cfg = require('./config');
const { q, audit, setting } = require('./db');
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

async function sendPasswordLink(user, req, { invite, from } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  // An invitation sent by the office may sit in an inbox over a weekend
  const hours = from ? 168 : invite ? 72 : 2;
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  await q.addLoginToken(token, user.id, expires, req.ip, 'setpassword');
  const url = `${siteUrl(req)}/?setup=${token}`;
  return reminders.sendEmail(user.email,
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
    <p style="color:#8A9284;font-size:12px;margin-top:16px;">Symbiz Network · 800-394-7970</p>
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
    <p style="color:#8A9284;font-size:12px;margin-top:20px;">Symbiz Network · 800-394-7970</p>
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
    const guests = sub.map(g => ({
      name: [g.Guest_First_Name, g.Guest_Last_Name].filter(Boolean).join(' '),
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
r.get('/members/map', auth.authRequired, auth.requireOffice, access.requirePerm('members'), wrap(async (req, res) => {
  // Built from five Zoho lists, so kept ready: 5 minutes, or 1 while addresses
  // are still being placed so new pins keep appearing
  if (mapCache && req.query.fresh !== '1' && Date.now() - mapCache.at < (mapCache.body.pending ? 60000 : 300000)) {
    return res.json(mapCache.body);
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
      rings: rg.map(r => r.name), rep: rg[0] ? (rg[0].repName || '') : '', repId: rg[0] ? (rg[0].repZohoId || null) : null };
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
  res.json(body);
}));

/* ═══════════ SUMMITS (Mel: history, planning, checklists, forms) ═══════════
 * The summits themselves live in Zoho (Symbiz_Events, Regional and Global
 * Summit). The planning around them — checklist, forms and documents, notes
 * on what to do differently — is kept here, per summit. */
const SUMMIT_TYPES = ['Regional Summit', 'Global Summit'];
/* Every new summit starts from this list. Days are relative to the summit. */
const SUMMIT_CHECKLIST = [
  ['3 months out', -90, 'Confirm the date and book the venue'],
  ['3 months out', -84, 'Choose the theme and invite the speakers'],
  ['2 months out', -60, 'Set the summit up in Zoho and show it on the portal'],
  ['2 months out', -56, 'Agree the meal, room layout and AV with the venue'],
  ['2 months out', -50, 'Open registration and send the first invitation'],
  ['1 month out', -30, 'Ask every rep to invite the members in their rings'],
  ['1 month out', -28, 'Confirm speakers, programme and running order'],
  ['1 month out', -25, 'Order printing: programmes, signage, handouts'],
  ['2 weeks out', -14, 'Send the reminder to everyone registered'],
  ['2 weeks out', -12, 'Give the venue the meal head-count'],
  ['2 weeks out', -10, 'Arrange volunteers: welcome desk, set-up, clear-up'],
  ['Week of', -5, 'Print name tags and the sign-in sheet'],
  ['Week of', -3, 'Final head-count to the venue; test the AV'],
  ['Week of', -2, 'Pack the event box: name tags, sign-in sheet, forms, gifts'],
  ['Day of', 0, 'Set up the room and welcome desk'],
  ['Day of', 0, 'Sign everyone in and collect guest details'],
  ['After', 2, 'Send thank-you emails to attendees and speakers'],
  ['After', 5, 'Record attendance in Zoho'],
  ['After', 7, 'Follow up new guests and leads with their rep'],
  ['After', 14, 'Debrief: note what worked and what to change next time'],
];
/* The standard list every new summit starts from. Rep Hub ships with the one
   above; the office can replace it with Symbiz's own (Summits → edit the
   standard checklist), and that is what new summits then use. */
async function summitTemplate() {
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
async function summitEvents(fresh) {
  if (!fresh && summitCache && Date.now() - summitCache.at < 300000) return summitCache.rows;
  const rows = await zoho.coql(`select id, Name, Event_Type, Event_Date_and_Time, Event_City, Event_State, Event_Venue,
      Registration_Count, Total_Registered_People, Attendance_Count, Event_Status
    from ${M.EVENT} where Event_Type in (${SUMMIT_TYPES.map(t => `'${t}'`).join(',')}) limit 200`);
  const out = rows.filter(e => !/\btest\b/i.test(e.Name || '')).map(e => {
    const when = toEastern(e.Event_Date_and_Time);
    return { id: e.id, name: e.Name, type: e.Event_Type, date: when.date, time: when.time,
      city: String(e.Event_City || '').replace(/,\s*$/, ''), state: e.Event_State || '', venue: e.Event_Venue || '',
      registered: e.Total_Registered_People ?? e.Registration_Count ?? null, attended: e.Attendance_Count ?? null,
      status: e.Event_Status || '' };
  }).sort((a, b) => b.date.localeCompare(a.date));
  summitCache = { at: Date.now(), rows: out };
  return out;
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
      <p><a href="${cfg.appUrl}" style="background:#2E5132;color:#fff;padding:9px 15px;border-radius:7px;text-decoration:none">Open Summits in Rep Hub</a></p>
      <p style="color:#8A9284;font-size:12px">It also shows in your notifications as the due date gets close.</p></div>`,
    { userId: person.id, kind: 'summit-task', replyTo: req.user.email }).catch(() => {});
}

r.get('/summits/template', ...summitGuard, wrap(async (req, res) => {
  const t = await summitTemplate();
  const by = t.custom ? await q.getSetting('summit_checklist_by').catch(() => null) : null;
  res.json({ ...t, by: by ? by.value : null });
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
  tellOwner(who.person, task, req.params.id, req);
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
  if (changingWho && who.ownerId && who.ownerId !== cur.owner_id) {
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
r.post('/pending/:id/approve', auth.authRequired, auth.requireOffice, access.requirePerm('approvals'), writesAllowed, wrap(async (req, res) => {
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
     ${booksOn && e.length ? `<p style="color:#555;font-size:13px">Each expense is also entered in Zoho Books as a bill numbered RH-&lt;expense number&gt;, with its receipt attached.</p>` : ''}`,
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
  if (booksOn && (await setting('booksAuto', 'on')) !== 'off' && e.length) {
    await q.queueBills(e.map(x => x.id));
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
    const sent = await sendPasswordLink({ id, name, email }, req, { invite: true, from: req.user });
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
  booksAuto: 'on', booksPayee: 'vendor', booksAccount: books.DEFAULT_FALLBACK, booksAccountMap: '{}',
  supportName: 'Ashish Raj', supportPhone: '540-212-9403',
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
  res.json({ ...st,
    waiting: pending.filter(x => !x.books_error).length,
    failed: pending.filter(x => x.books_error).map(x => ({ id: x.id, rep: x.rep_name, amount: Number(x.amount), error: x.books_error })),
  });
}));

/** Try again, including ones that failed — after fixing an account name, say. */
r.post('/accounting/books-retry', auth.authRequired, access.requirePerm('books'), wrap(async (req, res) => {
  if (!(await books.configured())) return res.status(400).json({ error: 'Zoho Books is not connected yet' });
  const out = await books.makeBills({ includeFailed: true });
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
const dropSnapshot = () => { snapCache = null; repEmailCache = null; };   // moving rings changes who the reps are

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
  await audit(req.user.id, 'ring.reassigned', { id: req.params.id, ring: from.name, from: from.repZohoId, to: repZohoId }, req.ip);
  res.json({ ok: true, ringId: req.params.id, from: from.repZohoId, to: repZohoId });
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
        password_hash: auth.hash(crypto.randomBytes(16).toString('hex')), zoho_owner_id: rep.id });
      u = { id, email: rep.email, name: splitName(rep.name) };
      await audit(req.user.id, 'user.createdFromZoho', { id, contactId: rep.id, email: rep.email, by: 'invite' }, req.ip);
    }
    const sent = await sendPasswordLink(u, req, { invite: true, from: req.user });
    out.push({ id: rep.id, name: rep.name, sent: !!(sent && sent.ok), error: sent && !sent.ok ? (sent.error || 'not sent') : undefined });
  }
  await audit(req.user.id, 'reps.invited', { sent: out.filter(x => x.sent).length, asked: list.length }, req.ip);
  res.json({ results: out, sent: out.filter(x => x.sent).length });
}));
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
  const rings = (await zoho.coql(queries.repsOnRings())).map(fromZoho.ring);
  const ids = [...new Set(rings.map(x => x.repZohoId).filter(Boolean))];
  const names = new Map(rings.map(x => [x.repZohoId, x.repName]));
  const emails = new Map();
  for (const batch of chunk(ids, 50)) {
    const cs = await zoho.coql(queries.contactsByIds(batch)).catch(() => []);
    cs.map(fromZoho.member).forEach(c => { if (c.email) emails.set(c.id, c.email); });
  }
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

module.exports = r;

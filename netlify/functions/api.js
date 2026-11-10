'use strict';
/**
 * The whole REST API as one Netlify Function.
 *
 * Express is wrapped with serverless-http so the same route code runs both
 * locally (`netlify dev`) and in production. netlify.toml redirects /api/*
 * here, so new routes need no config change.
 */
const express = require('express');
const serverless = require('serverless-http');
const helmet = require('helmet');
const cors = require('cors');

const routes = require('../../src/routes');
const zoho = require('../../src/lib/zoho');
const { migrate } = require('../../src/db');

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

/* How long each request took on the server, visible in the browser's network
   panel (Server-Timing) and logged when slow — so "it lags" can be traced. */
app.use((req, res, next) => {
  const t0 = Date.now();
  const end = res.end;
  // The app's "refresh" button: read Zoho afresh rather than the 2-minute cache
  if (req.headers['x-fresh']) zoho.clearCache();
  res.end = function (...args) {
    const ms = Date.now() - t0;
    if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${ms}`);
    if (ms > 2500) console.log(`[slow] ${req.method} ${req.url} ${ms}ms`);
    return end.apply(this, args);
  };
  next();
});

/**
 * Run the schema once per container, not per request. On a cold start this
 * costs one extra query; afterwards it's a no-op flag check.
 */
let migrated = false;
app.use(async (req, res, next) => {
  if (!migrated) {
    try { await migrate(); migrated = true; }
    catch (e) {
      console.error('[db] migrate failed:', e.message);
      // Be explicit: a missing DATABASE_URL is "not set up yet", not "wrong password".
      const notConfigured = /DATABASE_URL is not set/i.test(e.message);
      return res.status(503).json({
        error: notConfigured
          ? 'Database unavailable — DATABASE_URL is not set, so sign-in is not switched on yet.'
          : 'Database unavailable',
        setup: notConfigured ? 'Set DATABASE_URL in Netlify, then run scripts/seed-users.js' : undefined,
      });
    }
  }
  next();
});

/**
 * Netlify does not always rewrite the path before the function sees it: the
 * event can arrive as "/api/setup/status" OR "/.netlify/functions/api/setup/status"
 * depending on how the redirect is applied. Stripping a single fixed prefix is
 * therefore unreliable — normalise here instead, so every route matches
 * whichever form turns up.
 */
app.use((req, res, next) => {
  const strip = ['/.netlify/functions/api', '/api'];
  for (const prefix of strip) {
    if (req.url === prefix) { req.url = '/'; break; }
    if (req.url.startsWith(prefix + '/')) { req.url = req.url.slice(prefix.length); break; }
  }
  next();
});

app.get('/healthz', async (req, res) => {
  const out = { ok: true, time: new Date().toISOString() };
  try { out.zoho = await zoho.ping(); }
  catch (e) { out.ok = false; out.zoho = `error: ${e.message}`; }
  res.status(out.ok ? 200 : 503).json(out);
});

/*
 * Claude's connector: /api/mcp/<key> (see src/mcp.js). The key is a person's
 * private link; each tool call is answered by this same API, in-process,
 * signed in as them, so Claude never sees more than they do in the app.
 */
const mcp = require('../../src/mcp');
const auth = require('../../src/auth');
const { one: dbOne, query: dbQuery } = require('../../src/db');
app.get('/mcp/:key', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (MCP Streamable HTTP)' }));
app.post('/mcp/:key', async (req, res) => {
  const key = String(req.params.key || '');
  const link = /^[a-f0-9]{48}$/.test(key)
    ? await dbOne(`SELECT l.id, u.id AS user_id, u.role, u.name, u.email, u.active FROM claude_links l JOIN users u ON u.id = l.user_id
        WHERE l.key_hash = $1 AND l.revoked_at IS NULL`, [mcp.hashKey(key)]).catch(() => null)
    : null;
  if (!link || link.active === false) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This Rep Hub link is not valid or has been switched off' } });
  dbQuery('UPDATE claude_links SET last_used = now(), uses = uses + 1 WHERE id = $1', [link.id]).catch(() => {});
  const token = auth.issue({ id: link.user_id, role: link.role, name: link.name });
  const callApi = async path => {
    const [p, qs] = String(path).split('?');
    const out = await module.exports.handler({ httpMethod: 'GET', path: '/api' + p, rawUrl: `https://rephub.local/api${path}`,
      headers: { authorization: `Bearer ${token}`, 'x-via': 'claude' }, multiValueHeaders: {},
      queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : null, body: null, isBase64Encoded: false }, {});
    let data = null; try { data = JSON.parse(out.body || 'null'); } catch (_) { data = out.body; }
    return { status: out.statusCode, data };
  };
  const ctx = { callApi, who: `${link.name || 'a Rep Hub user'} (${link.role === 'rep' ? 'rep' : 'office'})` };
  const body = req.body;
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(m => mcp.handleMessage(m, ctx)))).filter(Boolean);
    return answers.length ? res.json(answers) : res.status(202).end();
  }
  const answer = await mcp.handleMessage(body, ctx);
  if (!answer) return res.status(202).end();
  res.json(answer);
});

app.use('/', routes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'ZohoError' ? 502 : 500);
  console.error(`[error] ${req.method} ${req.path}:`, err.message, err.stack ? err.stack.split('\n')[1] : '');

  /**
   * Show the real error to anyone signed in.
   *
   * This is an internal tool used by about a dozen known people, all behind a
   * login. Replacing the cause with "Something went wrong" protected nothing
   * and turned every fault into a round of guesswork.
   */
  const signedIn = !!(req.headers.authorization || '').startsWith('Bearer ');
  res.status(status).json({
    error: status === 502
      ? `Zoho CRM is not responding: ${err.message}`
      : (signedIn ? err.message : 'Something went wrong'),
    detail: signedIn ? err.message : undefined,
    where: signedIn ? `${req.method} ${req.path}` : undefined,
  });
});

// No basePath here: the middleware above normalises the path instead, which
// works whichever form Netlify delivers.
module.exports.handler = serverless(app);

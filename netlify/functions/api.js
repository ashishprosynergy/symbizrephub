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

app.get('/healthz', async (req, res) => {
  const out = { ok: true, time: new Date().toISOString() };
  try { out.zoho = await zoho.ping(); }
  catch (e) { out.ok = false; out.zoho = `error: ${e.message}`; }
  res.status(out.ok ? 200 : 503).json(out);
});

app.use('/', routes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'ZohoError' ? 502 : 500);
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  res.status(status).json({
    error: status === 502
      ? 'Zoho CRM is not responding. Your work is saved and will sync.'
      : 'Something went wrong',
    detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

module.exports.handler = serverless(app, {
  // Netlify mounts the function at /.netlify/functions/api — strip it so
  // Express sees the path the client actually asked for.
  basePath: '/.netlify/functions/api',
});

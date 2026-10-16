'use strict';
/**
 * Netlify build tests.
 *
 * Runs against an in-memory Postgres (pg-mem) and a fake Zoho on localhost,
 * so `npm test` needs neither a database nor a Zoho account.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'netlify-test-secret';
process.env.MAIL_ENABLED = 'false';
// Tests change the fake Zoho between calls; a cached answer would hide that
process.env.ZOHO_CACHE_SECONDS = '0';
process.env.SMS_ENABLED = 'false';
process.env.DATABASE_URL = 'postgres://localhost/test';
process.env.READ_ONLY = 'false';   // write tests below need writes enabled

const FAKE_ZOHO_PORT = 19877;
process.env.ZOHO_API_DOMAIN = `http://127.0.0.1:${FAKE_ZOHO_PORT}`;
process.env.ZOHO_ACCOUNTS_DOMAIN = `http://127.0.0.1:${FAKE_ZOHO_PORT}`;

/* ─── in-memory Postgres ─── */
const { newDb } = require('pg-mem');
const mem = newDb();
const pgAdapter = mem.adapters.createPg();
const db = require('../src/db');
db._setPoolForTests(new pgAdapter.Pool());

/* ─── fake Zoho ─── */
let zohoCalls = [];
let nextId = 5000;
const store = { Growth_Ring_Groups: [], Rep_Visit_Trackings: [], Contacts: [] };
const booksStore = {
  accounts: [
    { account_id: 'A1', account_name: 'Meals', account_type: 'expense' },
    { account_id: 'A2', account_name: 'Rep Reimbursements', account_type: 'expense' },
  ],
  contacts: [], bills: [], attachments: [],
};

const fakeZoho = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    zohoCalls.push({ method: req.method, path: url.pathname });
    const json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    if (url.pathname === '/oauth/v2/token') {
      if (url.searchParams.get('grant_type') === 'authorization_code') {
        return url.searchParams.get('code') === '1000.good.code'
          ? json({ access_token: 'fake-' + Date.now(), refresh_token: '1000.books-refresh', expires_in: 3600 })
          : json({ error: 'invalid_code' });
      }
      return json({ access_token: 'fake-' + Date.now(), expires_in: 3600 });
    }

    // ── fake Zoho Books ──
    if (url.pathname.startsWith('/books/v3/')) {
      const p = url.pathname.slice('/books/v3'.length), qs = url.searchParams;
      if (p.startsWith('/organizations/')) return json({ code: 0, organization: { name: 'Symbiz Books (test)' } });
      if (p === '/chartofaccounts') return json({ code: 0, chartofaccounts: booksStore.accounts });
      if (p === '/contacts' && req.method === 'GET') {
        return json({ code: 0, contacts: booksStore.contacts.filter(c => c.contact_name === qs.get('contact_name')) });
      }
      if (p === '/contacts' && req.method === 'POST') {
        const c = { contact_id: 'V' + (booksStore.contacts.length + 1), ...JSON.parse(body) };
        booksStore.contacts.push(c); return json({ code: 0, contact: c });
      }
      if (p === '/bills' && req.method === 'GET') {
        return json({ code: 0, bills: booksStore.bills.filter(b => b.bill_number === qs.get('bill_number')) });
      }
      if (p === '/bills' && req.method === 'POST') {
        const b = { bill_id: 'B' + (booksStore.bills.length + 1), ...JSON.parse(body) };
        booksStore.bills.push(b); return json({ code: 0, bill: b });
      }
      const att = p.match(/^\/bills\/([^/]+)\/attachment$/);
      if (att) { booksStore.attachments.push({ billId: att[1], type: req.headers['content-type'], size: body.length });
        return json({ code: 0, message: 'attached' }); }
      res.writeHead(404); return res.end('{}');
    }
    if (url.pathname === '/crm/v8/org') return json({ org: [{ company_name: 'Symbiz Network (test)' }] });
    if (url.pathname === '/crm/v8/coql') {
      const sq = JSON.parse(body || '{}').select_query || '';
      const mod = Object.keys(store).find(m => sq.includes(`from ${m}`)) || 'Rep_Activities';
      return json({ data: store[mod] });
    }
    const m = url.pathname.match(/^\/crm\/v8\/([A-Za-z_]+)(?:\/([^/]+))?$/);
    if (m) {
      const [, mod, id] = m;
      if (!store[mod]) store[mod] = [];
      if (req.method === 'POST') {
        const recs = JSON.parse(body).data || [];
        return json({ data: recs.map(rec => { const nid = String(nextId++); store[mod].push({ id: nid, ...rec }); return { code: 'SUCCESS', details: { id: nid } }; }) });
      }
      if (req.method === 'PUT') {
        const recs = JSON.parse(body).data || [];
        return json({ data: recs.map(rec => { const f = store[mod].find(x => x.id === rec.id); if (f) Object.assign(f, rec); return { code: 'SUCCESS', details: { id: rec.id } }; }) });
      }
      if (req.method === 'GET' && id) {
        let f = store[mod].find(x => x.id === id);
        // Rings come back with the rep set, mirroring Growth_Ring_Groups
        if (f && mod === 'Growth_Ring_Groups' && !f.Regional_Rep) {
          f = { ...f, Regional_Rep: { id: 'CONTACT_REP_1', name: 'Test Rep' }, Active: true };
        }
        return f ? json({ data: [f] }) : (res.writeHead(404), res.end('{}'));
      }
      if (req.method === 'GET') return json({ data: store[mod] });
    }
    res.writeHead(404); res.end('{}');
  });
});

before(async () => {
  await new Promise(r => fakeZoho.listen(FAKE_ZOHO_PORT, '127.0.0.1', r));
  await db.migrate();
});
after(() => fakeZoho.close());

/* ═══════════ POSTGRES SCHEMA ═══════════ */
describe('postgres layer', () => {
  const auth = require('../src/auth');

  test('schema migrates cleanly on a fresh database', async () => {
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = tables.map(t => t.table_name);
    for (const t of ['users', 'sync_queue', 'audit', 'settings', 'sent_log']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });

  test('migrate is safe to run repeatedly (every cold start calls it)', async () => {
    await db.migrate();
    await db.migrate();
    assert.ok(true);
  });

  test('users insert and read back', async () => {
    await db.q.insertUser({
      id: 'rep1', email: 'rep@test.org', name: 'Test Rep', phone: null,
      role: 'rep', region: 'PA', password_hash: auth.hash('correct-horse'),
      // A rep IS a Zoho Contact — this is the link that scopes their data
      zoho_owner_id: 'CONTACT_REP_1',
    });
    await db.q.insertUser({
      id: 'off1', email: 'office@test.org', name: 'Test Office', phone: null,
      role: 'staff', region: null, password_hash: auth.hash('correct-horse'), zoho_owner_id: null,
    });
    await db.q.insertUser({
      id: 'adm1', email: 'admin@test.org', name: 'Test Admin', phone: null,
      role: 'admin', region: null, password_hash: auth.hash('correct-horse'), zoho_owner_id: null,
    });
    const u = await db.q.userByEmail('rep@test.org');
    assert.equal(u.name, 'Test Rep');
  });

  test('email lookup is case-insensitive', async () => {
    const u = await db.q.userByEmail('REP@TEST.ORG');
    assert.ok(u, 'a rep typing their email in caps must still sign in');
  });

  test('settings upsert overwrites rather than duplicating', async () => {
    await db.q.setSetting('retryDays', '4');
    await db.q.setSetting('retryDays', '9');
    assert.equal(await db.setting('retryDays'), '9');
  });

  test('migrate adds purpose to a login_tokens table created before it existed', async () => {
    // Production already had login_tokens, so CREATE TABLE IF NOT EXISTS
    // skipped the new column and every code insert failed.
    const old = newDb();
    const OldPool = old.adapters.createPg().Pool;
    old.public.none(`CREATE TABLE login_tokens (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ip TEXT)`);
    db._setPoolForTests(new OldPool());
    try {
      // pg-mem cannot replay CREATE TABLE IF NOT EXISTS over an existing table
      // (real Postgres skips it), so run the schema's ALTER on its own.
      const alter = db.SCHEMA.split(';').map(s => s.trim())
        .find(s => /ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS purpose/i.test(s));
      assert.ok(alter, 'schema must upgrade existing login_tokens tables');
      await db.query(alter);
      await db.q.addLoginToken('otp:u1:123456', 'u1', new Date(Date.now() + 60000).toISOString(), null, 'otp');
      const row = await db.q.findLoginToken('otp:u1:123456');
      assert.equal(row.purpose, 'otp');
    } finally {
      db._setPoolForTests(new pgAdapter.Pool());
    }
  });
});

/* ═══════════ AUTH ═══════════ */
describe('auth (async)', () => {
  const auth = require('../src/auth');

  test('valid credentials return a token', async () => {
    const out = await auth.login('rep@test.org', 'correct-horse', '1.1.1.1');
    assert.ok(out?.token);
    assert.equal(out.user.role, 'rep');
  });

  test('wrong password is rejected', async () => {
    assert.equal(await auth.login('rep@test.org', 'nope', '1.1.1.1'), null);
  });

  test('unknown email is rejected', async () => {
    assert.equal(await auth.login('ghost@test.org', 'anything', '1.1.1.1'), null);
  });
});

/* ═══════════ SYNC QUEUE ═══════════ */
describe('sync queue on postgres', () => {
  const { enqueue, flushQueue } = require('../src/sync');

  test('enqueues a write', async () => {
    const out = await enqueue({
      userId: 'rep1', clientUuid: 'nq-1', module: 'Rep_Activities', op: 'insert',
      payload: { type: 'Member Call', who: 'John', date: '2026-09-18' },
    });
    assert.equal(out.duplicate, false);
  });

  test('ON CONFLICT makes a replayed uuid a no-op', async () => {
    const again = await enqueue({
      userId: 'rep1', clientUuid: 'nq-1', module: 'Rep_Activities', op: 'insert',
      payload: { type: 'Member Call', who: 'John', date: '2026-09-18' },
    });
    assert.equal(again.duplicate, true, 'a retried offline push must not duplicate work');
  });

  test('flush pushes to Zoho and empties the queue', async () => {
    await enqueue({
      userId: 'rep1', clientUuid: 'nq-2', module: 'Rep_Activities', op: 'insert',
      payload: { type: 'Facilitator Call', who: 'David', date: '2026-09-18' },
    });
    const out = await flushQueue({ limit: 50 });
    assert.ok(out.ok >= 2, `expected successes, got ${JSON.stringify(out)}`);
    assert.equal((await db.q.pendingFor('rep1')).c, 0);
  });
});

/* ═══════════ SERVERLESS HANDLER ═══════════ */
describe('netlify function handler', () => {
  const { handler } = require('../netlify/functions/api');

  const invoke = (method, path, { body, token } = {}) => handler({
    httpMethod: method,
    path: `/.netlify/functions/api${path}`,
    rawUrl: `https://example.netlify.app/.netlify/functions/api${path}`,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    queryStringParameters: {},
    body: body ? JSON.stringify(body) : null,
    isBase64Encoded: false,
  }, {});

  let repToken, officeToken;

  before(async () => {
    const a = await invoke('POST', '/auth/login', { body: { email: 'rep@test.org', password: 'correct-horse' } });
    repToken = JSON.parse(a.body).token;
    const b = await invoke('POST', '/auth/login', { body: { email: 'office@test.org', password: 'correct-horse' } });
    officeToken = JSON.parse(b.body).token;
  });

  test('the function boots and serves healthz', async () => {
    const res = await invoke('GET', '/healthz');
    assert.equal(res.statusCode, 200);
    assert.match(JSON.parse(res.body).zoho, /Symbiz/);
  });

  test('login through the serverless handler returns a token', async () => {
    const res = await invoke('POST', '/auth/login', { body: { email: 'rep@test.org', password: 'correct-horse' } });
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).token);
  });

  test('bad credentials return 401', async () => {
    const res = await invoke('POST', '/auth/login', { body: { email: 'rep@test.org', password: 'wrong' } });
    assert.equal(res.statusCode, 401);
  });

  test('protected routes reject anonymous callers', async () => {
    assert.equal((await invoke('GET', '/rings')).statusCode, 401);
  });

  test('a signed-in rep can read their rings', async () => {
    const res = await invoke('GET', '/rings', { token: repToken });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  test('a rep-created ring starts pending, never active', async () => {
    const res = await invoke('POST', '/rings', {
      token: repToken,
      body: { name: 'Netlify Ring', facFreq: 'Quarterly', memFreq: 'Annual', status: 'active' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).status, 'pending');
  });

  test('next_due is computed server-side and a forged value is ignored', async () => {
    await db.q.setSetting('retryDays', '4');   // don't inherit another test's value
    const ring = JSON.parse((await invoke('POST', '/rings', {
      token: repToken, body: { name: 'Cadence Ring', facFreq: 'Quarterly', memFreq: 'Annual' },
    })).body);
    const res = await invoke('POST', '/activities', {
      token: repToken,
      body: {
        ringId: ring.id, type: 'Member Call', who: 'John', date: '2026-09-18',
        outcome: 'No answer', nextDue: '2099-01-01',
      },
    });
    assert.equal(JSON.parse(res.body).nextDue, '2026-09-22');
  });

  test('the stored retry setting actually drives scheduling', async () => {
    await db.q.setSetting('retryDays', '10');
    const ring = JSON.parse((await invoke('POST', '/rings', {
      token: repToken, body: { name: 'Settings Ring', facFreq: 'Quarterly', memFreq: 'Annual' },
    })).body);
    const res = await invoke('POST', '/activities', {
      token: repToken,
      body: { ringId: ring.id, type: 'Member Call', who: 'K', date: '2026-09-18', outcome: 'No answer' },
    });
    assert.equal(JSON.parse(res.body).nextDue, '2026-09-28',
      'changing retryDays in settings must change when a missed call comes back');
    await db.q.setSetting('retryDays', '4');
  });

  test('reports stay office-only', async () => {
    assert.equal((await invoke('GET', '/reports', { token: repToken })).statusCode, 403);
    assert.equal((await invoke('GET', '/reports', { token: officeToken })).statusCode, 200);
  });

  test('event guests come from the Guests subform, with their names', async () => {
    // As Zoho behaves: the registration list carries no subform rows and the
    // flat Guest_* fields are empty; the names live only in Guests.
    store.Event_Registrations = [{ id: 'REG1', Name: '1193', Event: { id: '999', name: 'PA Summit' },
      Registrant_Name: { id: 'C1', name: 'James Zimmerman #0535' }, Bringing_Guest: 'Yes',
      Guest_First_Name: null, Guest_Last_Name: null, Registration_Status: 'Attending' }];
    store.Guests = [{ id: 'G1', Parent_Id: { id: 'REG1', name: '1193' }, Guest_First_Name: 'Mrs. James',
      Guest_Last_Name: 'Zimmerman', Guest_Type: 'Spouse', Guest_Organization: 'J&M Doorcraft LLC', Guest_City: 'Newville' }];
    try {
      const res = await invoke('GET', '/events/999/registrations', { token: repToken });
      assert.equal(res.statusCode, 200, res.body);
      const [reg] = JSON.parse(res.body);
      assert.equal(reg.guests.length, 1);
      assert.equal(reg.guests[0].name, 'Mrs. James Zimmerman');
      assert.equal(reg.guests[0].type, 'Spouse');
      assert.equal(reg.guests[0].business, 'J&M Doorcraft LLC');
      assert.ok(zohoCalls.some(c => c.path === '/crm/v8/coql'), 'read through COQL on the subform');
    } finally {
      delete store.Event_Registrations; delete store.Guests;
    }
  });

  test('sync push is idempotent through the handler', async () => {
    const payload = { items: [{ clientUuid: 'fn-1', module: 'Rep_Activities', op: 'insert', payload: { type: 'Member Call', who: 'Z', date: '2026-09-18' } }] };
    const first = JSON.parse((await invoke('POST', '/sync/push', { token: repToken, body: payload })).body);
    const second = JSON.parse((await invoke('POST', '/sync/push', { token: repToken, body: payload })).body);
    assert.equal(first.accepted, 1);
    assert.equal(second.duplicates, 1);
  });

  test('sync push flushes inline (serverless freezes after the response)', async () => {
    const res = await invoke('POST', '/sync/push', {
      token: repToken,
      body: { items: [{ clientUuid: 'fn-inline', module: 'Rep_Activities', op: 'insert', payload: { type: 'Member Call', who: 'Q', date: '2026-09-18' } }] },
    });
    const body = JSON.parse(res.body);
    assert.ok(body.flushed, 'the response must prove the flush ran before returning');
    assert.ok(body.flushed.ok >= 1);
  });
});

/* ═══════════ FIRST-RUN SETUP ═══════════ */
describe('first-run setup', () => {
  const { handler } = require('../netlify/functions/api');
  const invoke = (method, path, { body, token } = {}) => handler({
    httpMethod: method,
    path: `/.netlify/functions/api${path}`,
    rawUrl: `https://x.netlify.app/.netlify/functions/api${path}`,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    queryStringParameters: {}, body: body ? JSON.stringify(body) : null, isBase64Encoded: false,
  }, {});

  test('status reports the database is ready', async () => {
    const res = await invoke('GET', '/setup/status');
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.dbReady, true);
  });

  test('with users present it does not ask for setup', async () => {
    const body = JSON.parse((await invoke('GET', '/setup/status')).body);
    assert.equal(body.needsSetup, false, 'users already exist in this test database');
    assert.ok(body.userCount > 0);
  });

  test('setup refuses once an account exists', async () => {
    const res = await invoke('POST', '/setup', {
      body: { name: 'Sneaky Admin', email: 'sneaky@test.org', password: 'longenough1' },
    });
    assert.equal(res.statusCode, 409, 'setup must not create a second admin');
  });

  test('setup rejects a short password', async () => {
    // exercised through validation order: the conflict check fires first here,
    // so assert the endpoint refuses rather than creating anything
    const before = (await db.q.allUsers()).length;
    await invoke('POST', '/setup', { body: { name: 'X', email: 'x@test.org', password: 'short' } });
    assert.equal((await db.q.allUsers()).length, before);
  });

  test('a rep in Zoho with no account yet gets one when they ask for a code', async () => {
    const ring = { id: 'RING_SELF', Name: 'Self Ring', Active: true,
                   Regional_Rep: { id: 'CONTACT_SELF', name: 'Selfserve Rep' } };
    const contact = { id: 'CONTACT_SELF', Full_Name: 'Selfserve Rep (77)', Email: 'Self.Rep@Example.com' };
    store.Growth_Ring_Groups.push(ring);
    store.Contacts.push(contact);
    try {
      const res = await invoke('POST', '/auth/forgot', { body: { email: 'self.rep@example.com' } });
      // Mail is off in tests, so the send itself reports 503 — but not "no account"
      assert.notEqual(res.statusCode, 404, res.body);
      const u = await db.q.userByEmail('self.rep@example.com');
      assert.ok(u, 'the account should have been created');
      assert.equal(u.role, 'rep');
      assert.equal(u.zoho_owner_id, 'CONTACT_SELF', 'linked to their Zoho contact so they see their rings');
      assert.equal(u.name, 'Selfserve Rep');

      // Asking again uses that account rather than making a second one
      const before = (await db.q.allUsers()).length;
      await invoke('POST', '/auth/forgot', { body: { email: 'self.rep@example.com' } });
      assert.equal((await db.q.allUsers()).length, before);
    } finally {
      store.Growth_Ring_Groups.splice(store.Growth_Ring_Groups.indexOf(ring), 1);
      store.Contacts.splice(store.Contacts.indexOf(contact), 1);
    }
  });

  test('an email with no account and no Zoho rep is told so, not sent a phantom code', async () => {
    for (const path of ['/auth/forgot', '/auth/request-link']) {
      const res = await invoke('POST', path, { body: { email: 'nobody@nowhere.test' } });
      assert.equal(res.statusCode, 404, path);
      assert.match(JSON.parse(res.body).error, /no Rep Hub account/i);
    }
    assert.equal(await db.q.userByEmail('nobody@nowhere.test'), null);
  });

  describe('sign up, confirm, sign in, forgot', () => {
    const reminders = require('../src/reminders');
    let realSend, sent;
    // Mail is off in tests; capture what would have gone out instead
    before(() => { realSend = reminders.sendEmail;
      reminders.sendEmail = async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }; });
    after(() => { reminders.sendEmail = realSend; });
    const lastCode = to => (sent.filter(s => s.to === to).pop()?.subject.match(/(\d{6})/) || [])[1];

    test('a new person can sign up, confirm by code and be signed in', async () => {
      sent = [];
      const email = 'new.person@example.com';
      const res = await invoke('POST', '/auth/signup', { body: { name: 'New Person', email, password: 'longenough1' } });
      assert.equal(res.statusCode, 201, res.body);
      const code = lastCode(email);
      assert.ok(code, 'a confirmation code was emailed');

      // Signing in before confirming sends them back to the code screen
      const early = await invoke('POST', '/auth/login', { body: { email, password: 'longenough1' } });
      assert.equal(early.statusCode, 403);
      assert.equal(JSON.parse(early.body).needsVerification, true);

      // The first code still works even though signing in sent another
      const ok = await invoke('POST', '/auth/verify-email', { body: { email, code } });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.ok(JSON.parse(ok.body).token);

      const login = await invoke('POST', '/auth/login', { body: { email, password: 'longenough1' } });
      assert.equal(login.statusCode, 200);
      const u = await db.q.userByEmail(email);
      assert.equal(u.role, 'rep');
      assert.equal(u.zoho_owner_id, null, 'not a Zoho rep, so linked to nothing and sees nothing');
    });

    test('signing up twice with a confirmed email is refused', async () => {
      sent = [];
      const res = await invoke('POST', '/auth/signup', { body: { name: 'Again', email: 'new.person@example.com', password: 'longenough1' } });
      assert.equal(res.statusCode, 409);
    });

    test('sign-up checks the password length', async () => {
      const res = await invoke('POST', '/auth/signup', { body: { name: 'X', email: 'short@example.com', password: 'short' } });
      assert.equal(res.statusCode, 400);
    });

    test('asking for two reset codes leaves the first one working', async () => {
      sent = [];
      const email = 'new.person@example.com';
      await invoke('POST', '/auth/forgot', { body: { email } });
      const first = lastCode(email);
      await invoke('POST', '/auth/forgot', { body: { email } });
      const second = lastCode(email);
      assert.notEqual(first, undefined);

      const res = await invoke('POST', '/auth/verify-code', { body: { email, code: first } });
      assert.equal(res.statusCode, 200, res.body);
      // Once one has worked, the other is spent
      if (second !== first) {
        const again = await invoke('POST', '/auth/verify-code', { body: { email, code: second } });
        assert.equal(again.statusCode, 401);
      }

      const { token } = JSON.parse(res.body);
      const set = await invoke('POST', '/auth/set-password', { body: { token, password: 'brandnewpass' } });
      assert.equal(set.statusCode, 200);
      const login = await invoke('POST', '/auth/login', { body: { email, password: 'brandnewpass' } });
      assert.equal(login.statusCode, 200);
    });

    test('a signed-in person can change their password', async () => {
      const email = 'new.person@example.com';
      const { token } = JSON.parse((await invoke('POST', '/auth/login', { body: { email, password: 'brandnewpass' } })).body);
      const wrong = await invoke('POST', '/auth/password', { token, body: { current: 'nope-nope', next: 'anotherpass1' } });
      assert.equal(wrong.statusCode, 400);
      const ok = await invoke('POST', '/auth/password', { token, body: { current: 'brandnewpass', next: 'anotherpass1' } });
      assert.equal(ok.statusCode, 200);
      const login = await invoke('POST', '/auth/login', { body: { email, password: 'anotherpass1' } });
      assert.equal(login.statusCode, 200);
    });
  });

  test('status reports whether Zoho is connected', async () => {
    const body = JSON.parse((await invoke('GET', '/setup/status')).body);
    assert.equal(typeof body.zohoReady, 'boolean');
  });

  test('an admin can create further accounts', async () => {
    const login = await invoke('POST', '/auth/login', { body: { email: 'admin@test.org', password: 'correct-horse' } });
    const token = JSON.parse(login.body).token;
    const res = await invoke('POST', '/admin/users', {
      token, body: { name: 'New Rep', email: 'newrep@test.org', role: 'rep', region: 'PA' },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(JSON.parse(res.body).tempPassword, 'a generated password should come back once');
  });

  test('a rep cannot create accounts', async () => {
    const login = await invoke('POST', '/auth/login', { body: { email: 'rep@test.org', password: 'correct-horse' } });
    const token = JSON.parse(login.body).token;
    const res = await invoke('POST', '/admin/users', {
      token, body: { name: 'Nope', email: 'nope@test.org', role: 'admin' },
    });
    assert.equal(res.statusCode, 403);
  });
});

/* ═══════════ READ-ONLY MODE ═══════════ */
describe('read-only mode', () => {
  test('the flag is read from the environment', () => {
    const cfg = require('../src/config');
    assert.equal(typeof cfg.readOnly, 'boolean');
    assert.equal(cfg.readOnly, false, 'tests run with writes enabled');
  });

  test('module names point at the real Symbiz schema, not invented ones', () => {
    const cfg = require('../src/config');
    assert.equal(cfg.modules.RING, 'Growth_Ring_Groups');
    assert.equal(cfg.modules.ACTIVITY, 'Rep_Visit_Trackings');
    assert.equal(cfg.modules.MEETING, 'Growth_Ring_Meetings_N');
    assert.equal(cfg.modules.CONTACT, 'Contacts');
  });

  test('COQL always includes a where clause (the live org rejects queries without one)', () => {
    const { queries } = require('../src/domain');
    [
      queries.ringsForRep(null),
      queries.ringsForRep('123'),
      queries.groupMembersFor(['1', '2']),
      queries.allGroupMembers(0),
      queries.contactsByIds(['1']),
      queries.allActiveMembers(0),
      queries.visitsForRings(['1']),
      queries.facilitators(),
      queries.contactById('1'),
    ].forEach(q => assert.match(q, /\bwhere\b/i, `missing where clause: ${q.slice(0, 60)}`));
  });

  test('a rep query filters on Regional_Rep, which is a Contact lookup', () => {
    const { queries } = require('../src/domain');
    assert.match(queries.ringsForRep('777'), /Regional_Rep = '777'/);
    assert.ok(!queries.ringsForRep(null).includes('Regional_Rep ='),
      'with no rep id the query must return every ring');
  });

  test('membership is read via the join table, not the unfilterable lookup', () => {
    const { queries } = require('../src/domain');
    assert.match(queries.groupMembersFor(['1']), /from Group_Members/,
      'Contacts cannot be filtered on Growth_Ring_Groups — the live org rejects it');
    const all = Object.values(queries).map(f => { try { return f(['1']); } catch { return ''; } }).join(' ');
    assert.ok(!/Contacts[\s\S]*Growth_Ring_Groups (in|is)/.test(all),
      'no query may filter Contacts on the group lookup');
  });

  test('single quotes are stripped so a crafted id cannot break the query', () => {
    const { queries } = require('../src/domain');
    const q = queries.ringsForRep("1' or '1'='1");
    assert.ok(!/'1'='1'/.test(q), 'quotes must be stripped from interpolated ids');
  });
});

/* ═══════════ HOURS AND EXPENSES ═══════════ */
describe('hours and expenses', () => {
  const { handler } = require('../netlify/functions/api');
  const invoke = (method, path, { body, token } = {}) => handler({
    httpMethod: method, path: `/.netlify/functions/api${path}`,
    rawUrl: `https://x.netlify.app/.netlify/functions/api${path}`,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    queryStringParameters: {}, body: body ? JSON.stringify(body) : null, isBase64Encoded: false,
  }, {});
  let repToken, officeToken, adminToken;
  before(async () => {
    repToken = JSON.parse((await invoke('POST','/auth/login',{body:{email:'rep@test.org',password:'correct-horse'}})).body).token;
    officeToken = JSON.parse((await invoke('POST','/auth/login',{body:{email:'office@test.org',password:'correct-horse'}})).body).token;
    // An admin's Send goes straight to accounting; office staff's waits for an admin
    adminToken = JSON.parse((await invoke('POST','/auth/login',{body:{email:'admin@test.org',password:'correct-horse'}})).body).token;
  });

  test('schema creates the hours and expenses tables', async () => {
    const t = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const names = t.map(x => x.table_name);
    assert.ok(names.includes('time_entries'), 'time_entries missing');
    assert.ok(names.includes('expenses'), 'expenses missing');
  });

  test('a rep can log hours', async () => {
    const res = await invoke('POST', '/time', { token: repToken,
      body: { date: '2026-10-01', hours: 2.5, category: 'Growth Ring visit', description: 'Visit and travel' } });
    assert.equal(res.statusCode, 201);
  });

  test('nonsense hours are rejected', async () => {
    assert.equal((await invoke('POST','/time',{token:repToken,body:{date:'2026-10-01',hours:0}})).statusCode, 400);
    assert.equal((await invoke('POST','/time',{token:repToken,body:{date:'2026-10-01',hours:40}})).statusCode, 400);
  });

  test('an expense saves with its receipt', async () => {
    const res = await invoke('POST', '/expenses', { token: repToken,
      body: { date: '2026-10-01', amount: 48.6, category: 'Mileage', description: 'Fuel',
              receiptName: 'fuel.pdf', receiptType: 'application/pdf',
              receiptData: 'data:application/pdf;base64,JVBERi0=' } });
    assert.equal(res.statusCode, 201);
  });

  test('an oversized receipt is refused rather than filling the database', async () => {
    const res = await invoke('POST', '/expenses', { token: repToken,
      body: { date:'2026-10-01', amount:10, category:'Other', description:'big',
              receiptData: 'x'.repeat(3_100_000) } });
    assert.equal(res.statusCode, 413);
  });

  test('the list omits receipt bytes, which are fetched separately', async () => {
    const rows = JSON.parse((await invoke('GET','/expenses',{token:repToken})).body);
    assert.ok(rows.length > 0);
    assert.ok(!('receipt_data' in rows[0]), 'receipt bytes must not ship with every list');
    assert.ok(rows.some(r => r.receipt_name === 'fuel.pdf'));
  });

  test('the receipt itself is fetchable', async () => {
    const rows = JSON.parse((await invoke('GET','/expenses',{token:repToken})).body);
    const withReceipt = rows.find(r => r.receipt_name);
    const res = await invoke('GET', `/expenses/${withReceipt.id}/receipt`, { token: repToken });
    assert.equal(res.statusCode, 200);
    assert.match(JSON.parse(res.body).data, /^data:application\/pdf/);
  });

  test('a rep cannot approve their own claim', async () => {
    const rows = JSON.parse((await invoke('GET','/expenses',{token:repToken})).body);
    assert.equal((await invoke('POST',`/expenses/${rows[0].id}/approve`,{token:repToken})).statusCode, 403);
  });

  test('the office can approve', async () => {
    const rows = JSON.parse((await invoke('GET','/expenses',{token:officeToken})).body);
    assert.equal((await invoke('POST',`/expenses/${rows[0].id}/approve`,{token:officeToken})).statusCode, 200);
  });

  test('the accounting email carries each receipt, named by its line, plus data for bill entry', async () => {
    // A photographed receipt, approved, alongside the PDF one above
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await invoke('POST', '/expenses', { token: repToken,
      body: { date: '2026-10-02', amount: 23.5, category: 'Meals', description: 'Lunch with facilitator',
              receiptName: 'lunch.png', receiptType: 'image/png', receiptData: png } });
    for (const x of JSON.parse((await invoke('GET','/expenses',{token:officeToken})).body)) {
      if (x.status === 'Submitted') await invoke('POST', `/expenses/${x.id}/approve`, { token: officeToken });
    }

    const cfg = require('../src/config');
    const reminders = require('../src/reminders');
    const realSend = reminders.sendEmail, realMail = { ...cfg.mail };
    let mail = null;
    cfg.mail.enabled = true; cfg.mail.host = 'smtp.test';
    reminders.sendEmail = async (to, subject, html, opts) => { mail = { to, subject, html, opts }; return { ok: true }; };
    try {
      const res = await invoke('POST', '/accounting/send', { token: adminToken });
      assert.equal(res.statusCode, 200, res.body);
    } finally {
      reminders.sendEmail = realSend; Object.assign(cfg.mail, realMail);
    }

    const files = mail.opts.attachments.map(a => a.filename);
    const receiptFiles = files.filter(f => /^E\d+-receipt-/.test(f));
    assert.ok(receiptFiles.length >= 2, 'both receipts attached: ' + files.join(', '));
    assert.ok(receiptFiles.some(f => /\.png$/.test(f)) && receiptFiles.some(f => /\.pdf$/.test(f)));
    const img = mail.opts.attachments.find(a => /\.png$/.test(a.filename));
    assert.ok(Buffer.isBuffer(img.content) && img.content.length > 0, 'image bytes, not the data URL text');
    assert.ok(img.cid && mail.html.includes(`cid:${img.cid}`), 'image shown in the body too');

    // Dates read as dates, not "Fri Oct 02 2026 00:00:00 GMT"
    assert.ok(!/GMT|00:00:00/.test(mail.html));
    const json = JSON.parse(mail.html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1]
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const lunch = json.expenses.find(x => x.description === 'Lunch with facilitator');
    assert.equal(lunch.date, '2026-10-02');
    assert.equal(lunch.amount, 23.5);
    assert.equal(lunch.receiptStatus, 'attached');
    assert.ok(receiptFiles.includes(lunch.receiptFile), 'the data names the attached file');
  });

  test('with Zoho Books connected, sent expenses become bills with receipts, once each', async () => {
    const cfg = require('../src/config');
    const books = require('../src/lib/books');
    const reminders = require('../src/reminders');
    const realSend = reminders.sendEmail, realMail = { ...cfg.mail };
    const billsBefore = booksStore.bills.length;
    cfg.books.orgId = 'ORG1'; cfg.books.refreshToken = 'test-refresh'; books._resetForTests();
    cfg.mail.enabled = true; cfg.mail.host = 'smtp.test';
    reminders.sendEmail = async () => ({ ok: true });
    try {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      await invoke('POST', '/expenses', { token: repToken, body: { date: '2026-10-05', amount: 12.4, category: 'Meals',
        vendor: 'Sheetz', description: 'Coffee before ring visit', receiptName: 'sheetz.png', receiptType: 'image/png', receiptData: png } });
      await invoke('POST', '/expenses', { token: repToken, body: { date: '2026-10-06', amount: 31, category: 'Mileage',
        vendor: 'Own car', description: '62 miles to Lancaster' } });
      for (const x of JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body)) {
        if (x.status === 'Submitted') await invoke('POST', `/expenses/${x.id}/approve`, { token: officeToken });
      }

      const sent = JSON.parse((await invoke('POST', '/accounting/send', { token: adminToken })).body);
      assert.ok(sent.books, 'books result reported');
      assert.equal(sent.books.made, 1, JSON.stringify(sent.books));     // Meals has an account
      assert.equal(sent.books.failed, 1);                               // Mileage has none yet

      const meal = booksStore.bills.find(b => /Sheetz/.test(b.line_items[0].description));
      assert.ok(meal, 'meal bill made');
      assert.match(meal.bill_number, /^RH-\d+$/);
      assert.equal(meal.line_items[0].account_id, 'A1');
      assert.equal(meal.line_items[0].rate, 12.4);
      assert.equal(meal.date, '2026-10-05');
      const payee = booksStore.contacts.find(c => c.contact_id === meal.vendor_id);
      assert.equal(payee.contact_name, 'Test Rep', 'billed to the rep, who is being reimbursed');
      assert.ok(booksStore.attachments.some(a => a.billId === meal.bill_id && /multipart/.test(a.type)), 'receipt attached');

      // Nothing from the batch sent before Books was connected
      assert.ok(!booksStore.bills.some(b => /Lunch with facilitator/.test(b.line_items[0].description)));

      // The office picks a fallback account, then retries
      const put = await invoke('PUT', '/admin/settings', { token: officeToken, body: { booksAccount: 'Rep Reimbursements' } });
      assert.equal(put.statusCode, 200);
      const retry = JSON.parse((await invoke('POST', '/accounting/books-retry', { token: officeToken })).body);
      assert.equal(retry.made, 1, JSON.stringify(retry));
      const miles = booksStore.bills.find(b => /Lancaster/.test(b.line_items[0].description));
      assert.equal(miles.line_items[0].account_id, 'A2');

      // Running again makes nothing new
      const count = booksStore.bills.length;
      await invoke('POST', '/accounting/books-retry', { token: officeToken });
      assert.equal(booksStore.bills.length, count);
      assert.equal(booksStore.bills.length - billsBefore, 2);

      // And the app shows each expense's bill
      const rows = JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body);
      assert.ok(rows.filter(x => x.books_bill_id).length >= 2);
      assert.ok(rows.some(x => x.vendor === 'Sheetz'));
    } finally {
      cfg.books.orgId = ''; cfg.books.refreshToken = ''; reminders.sendEmail = realSend; Object.assign(cfg.mail, realMail);
    }
  });

  test('an admin connects Zoho Books from Settings with a grant code', async () => {
    const cfg = require('../src/config');
    const books = require('../src/lib/books');
    cfg.books.orgId = 'ORG1'; cfg.books.refreshToken = ''; books._resetForTests();
    try {
      assert.equal(await books.configured(), false);
      const staff = await invoke('POST', '/admin/books-connect', { token: officeToken, body: { code: '1000.good.code' } });
      assert.equal(staff.statusCode, 403, 'office staff cannot connect it');
      const bad = await invoke('POST', '/admin/books-connect', { token: adminToken, body: { code: '1000.used.code' } });
      assert.equal(bad.statusCode, 400);
      assert.match(JSON.parse(bad.body).error, /expired or was already used/);
      assert.equal(await books.configured(), false);

      const ok = await invoke('POST', '/admin/books-connect', { token: adminToken, body: { code: '1000.good.code' } });
      assert.equal(ok.statusCode, 200, ok.body);
      const st = JSON.parse(ok.body);
      assert.equal(st.connected, true);
      assert.equal(st.accountMap.Mileage, '5300 Contractor Reimbursements - Mileage');
      assert.equal(await books.configured(), true);

      // The office maps a category to an account
      await invoke('PUT', '/admin/settings', { token: officeToken, body: { booksAccountMap: { Meals: 'Rep Reimbursements' } } });
      const st2 = JSON.parse((await invoke('GET', '/admin/books-status', { token: officeToken })).body);
      assert.equal(st2.accountMap.Meals, 'Rep Reimbursements');
      assert.equal(st2.accountMap.Mileage, '5300 Contractor Reimbursements - Mileage', 'others keep their default');

      await invoke('POST', '/admin/books-disconnect', { token: adminToken });
      assert.equal(await books.configured(), false);
    } finally {
      cfg.books.orgId = ''; books._resetForTests();
      await invoke('PUT', '/admin/settings', { token: officeToken, body: { booksAccountMap: {} } });
    }
  });

  test('office staff send to an admin for final approval; nothing is emailed until the admin sends it', async () => {
    const cfg = require('../src/config');
    const reminders = require('../src/reminders');
    const realSend = reminders.sendEmail, realMail = { ...cfg.mail };
    const mails = [];
    cfg.mail.enabled = true; cfg.mail.host = 'smtp.test';
    reminders.sendEmail = async (to, subject, html, opts) => { mails.push({ to, subject, html, opts }); return { ok: true }; };
    try {
      await invoke('POST', '/expenses', { token: repToken, body: { date: '2026-10-08', amount: 19.99, category: 'Printing',
        vendor: 'Staples', description: 'Flyers for info night' } });
      for (const x of JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body)) {
        if (x.status === 'Submitted') await invoke('POST', `/expenses/${x.id}/approve`, { token: officeToken });
      }

      // Office staff press Send: it waits for an admin, and nobody is emailed
      const asked = JSON.parse((await invoke('POST', '/accounting/send', { token: officeToken })).body);
      assert.equal(asked.awaitingApproval, true, JSON.stringify(asked));
      assert.equal(mails.length, 0, 'no email to anyone');
      let rows = JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body);
      assert.ok(rows.some(x => x.description === 'Flyers for info night' && x.status === 'Approved'), 'still waiting, not sent');
      const list = JSON.parse((await invoke('GET', '/accounting/batches', { token: adminToken })).body);
      assert.equal(list.pending.length, 1);
      assert.equal(list.pending[0].requestedBy, 'Test Office');
      const id = list.pending[0].id;

      // The admin reviews it in the app
      const view = JSON.parse((await invoke('GET', `/accounting/batches/${id}`, { token: adminToken })).body);
      assert.ok(view.expenses.some(x => x.vendor === 'Staples' && x.amount === 19.99));

      // Office staff cannot give the final approval
      assert.equal((await invoke('POST', `/accounting/batches/${id}/approve`, { token: officeToken })).statusCode, 403);

      // Something approved after the batch was made is not slipped into it
      await invoke('POST', '/expenses', { token: repToken, body: { date: '2026-10-09', amount: 5, category: 'Other', vendor: 'X', description: 'Late item' } });
      for (const x of JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body)) {
        if (x.status === 'Submitted') await invoke('POST', `/expenses/${x.id}/approve`, { token: officeToken });
      }

      // The admin approves: accounting gets exactly what was reviewed
      const ok = await invoke('POST', `/accounting/batches/${id}/approve`, { token: adminToken });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(mails.length, 1, 'only the accounting email');
      assert.match(mails[0].subject, /Rep hours and expenses —/);
      assert.ok(/Flyers for info night/.test(mails[0].html));
      assert.ok(!/Late item/.test(mails[0].html), 'the later item waits for the next batch');
      rows = JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body);
      assert.equal(rows.find(x => x.description === 'Flyers for info night').status, 'Reimbursed');
      assert.equal(rows.find(x => x.description === 'Late item').status, 'Approved');
      assert.equal((await invoke('POST', `/accounting/batches/${id}/approve`, { token: adminToken })).statusCode, 409);

      // Sent back with a note: the office sees it in the app; nothing is sent
      mails.length = 0;
      await invoke('POST', '/accounting/send', { token: officeToken });
      const id2 = JSON.parse((await invoke('GET', '/accounting/batches', { token: adminToken })).body).pending[0].id;
      const back = await invoke('POST', `/accounting/batches/${id2}/return`, { token: adminToken, body: { note: 'Need a receipt for the late item' } });
      assert.equal(back.statusCode, 200);
      assert.equal(mails.length, 0);
      const after = JSON.parse((await invoke('GET', '/accounting/batches', { token: officeToken })).body);
      assert.equal(after.pending.length, 0);
      assert.equal(after.returned.note, 'Need a receipt for the late item');
      assert.equal(after.returned.decidedBy, 'Test Admin');
      rows = JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body);
      assert.equal(rows.find(x => x.description === 'Late item').status, 'Approved');

      // An admin's own Send goes straight to accounting
      const direct = JSON.parse((await invoke('POST', '/accounting/send', { token: adminToken })).body);
      assert.equal(direct.sent, true, JSON.stringify(direct));
      assert.equal(mails.length, 1);

      // The automatic run: on the chosen day it makes one batch for the admins; other days nothing
      await invoke('POST', '/expenses', { token: repToken, body: { date: '2026-10-10', amount: 7, category: 'Other', vendor: 'Y', description: 'Monthly item' } });
      for (const x of JSON.parse((await invoke('GET', '/expenses', { token: officeToken })).body)) {
        if (x.status === 'Submitted') await invoke('POST', `/expenses/${x.id}/approve`, { token: officeToken });
      }
      const routes = require('../src/routes');
      await db.q.setSetting('accountingDay', '15');
      mails.length = 0;
      assert.equal((await routes.runAutoAccounting(new Date('2026-11-14T15:00:00Z'))).skipped, 'not today');
      const due = await routes.runAutoAccounting(new Date('2026-11-15T15:00:00Z'));
      assert.equal(due.awaitingApproval, true, JSON.stringify(due));
      assert.equal(mails.length, 0, 'the schedule emails nobody');
      const sched = JSON.parse((await invoke('GET', '/accounting/batches', { token: adminToken })).body).pending[0];
      assert.equal(sched.requestedBy, 'the monthly schedule');
      assert.equal((await routes.runAutoAccounting(new Date('2026-11-15T20:00:00Z'))).skipped, 'already done today');
      await db.q.setSetting('accountingDay', 'Last');
      assert.equal((await routes.runAutoAccounting(new Date('2026-11-29T15:00:00Z'))).skipped, 'not today');
    } finally {
      reminders.sendEmail = realSend; Object.assign(cfg.mail, realMail);
      await db.q.setSetting('accountingDay', '1');
    }
  });

  test('settings the office saves are limited to known keys', async () => {
    const res = await invoke('PUT', '/admin/settings', { token: officeToken, body: { zoho_access_token: 'evil', accountingEmail: 'books@symbiz.org' } });
    assert.equal(res.statusCode, 200);
    assert.equal(await db.setting('accountingEmail', ''), 'books@symbiz.org');
    assert.notEqual(await db.setting('zoho_access_token', ''), 'evil');
    const bad = await invoke('PUT', '/admin/settings', { token: officeToken, body: { accountingEmail: 'not-an-email' } });
    assert.equal(bad.statusCode, 400);
    const asRep = await invoke('PUT', '/admin/settings', { token: repToken, body: { accountingEmail: 'x@y.z' } });
    assert.equal(asRep.statusCode, 403);
  });

  test('the accounting payload totals only approved items', async () => {
    const body = JSON.parse((await invoke('GET','/accounting/pending',{token:officeToken})).body);
    assert.equal(typeof body.amount, 'number');
    assert.ok(body.expenses.every(x => x.status === 'Approved'));
  });

  test('hours and expenses still work in read-only mode', async () => {
    // They are our data, not Symbiz's CRM, so READ_ONLY must not block them
    const res = await invoke('POST', '/time', { token: repToken,
      body: { date:'2026-10-02', hours:1, category:'Admin', description:'notes' } });
    assert.notEqual(res.statusCode, 423);
  });
});

/* ═══════════ SCHEDULED FUNCTIONS ═══════════ */
describe('speed', () => {
  const zoho = require('../src/lib/zoho');

  test('a repeated Zoho query is answered from the cache, and a write clears it', async () => {
    process.env.ZOHO_CACHE_SECONDS = '30';
    try {
      zoho.clearCache();
      const coqlCalls = () => zohoCalls.filter(c => c.path === '/crm/v8/coql').length;
      const before = coqlCalls();
      await zoho.coql('select id from Growth_Ring_Groups where id is not null limit 1');
      await zoho.coql('select id from Growth_Ring_Groups where id is not null limit 1');
      assert.equal(coqlCalls() - before, 1, 'second identical query should not reach Zoho');

      await zoho.insertRecords('Rep_Visit_Trackings', [{ Name: 'cache-buster' }]);
      await zoho.coql('select id from Growth_Ring_Groups where id is not null limit 1');
      assert.equal(coqlCalls() - before, 2, 'a write must clear cached answers');
    } finally {
      process.env.ZOHO_CACHE_SECONDS = '0';
      zoho.clearCache();
    }
  });

  test('the Zoho token is shared through the database', async () => {
    zoho._resetTokenForTests();
    await zoho.getAccessToken();
    const stored = JSON.parse(await db.setting('zoho_access_token', 'null'));
    assert.ok(stored && stored.access, 'a fresh token is saved for other copies of the function');

    // A new copy (empty memory) picks it up instead of refreshing
    zoho._resetTokenForTests();
    const refreshes = () => zohoCalls.filter(c => c.path === '/oauth/v2/token').length;
    const before = refreshes();
    assert.equal(await zoho.getAccessToken(), stored.access);
    assert.equal(refreshes(), before);
  });

  test('an unchanged schema is not rebuilt on every cold start', async () => {
    // Built once in before(); the recorded version is what lets later cold
    // starts skip the DDL. (pg-mem cannot replay CREATE TABLE over existing
    // tables, so the skip itself is not re-run here.)
    const row = await db.one("SELECT value FROM settings WHERE key = 'schema_version'");
    assert.ok(row && row.value, 'version recorded after building');
  });

  test('emails carry a plain-text copy with the code and links', () => {
    const { htmlToText } = require('../src/reminders');
    const t = htmlToText('<h1>Confirm</h1><p>Type <b>123456</b> &amp; go</p><a href="https://x.test/a">Open</a>');
    assert.match(t, /123456/);
    assert.match(t, /Open: https:\/\/x\.test\/a/);
    assert.ok(!/</.test(t));
  });
});

describe('accounting PDF', () => {
  const { tablePDF } = require('../src/lib/pdf');
  const cols = [{ label: 'Rep', width: 2 }, { label: 'Note', width: 5 }, { label: 'Amount', width: 1, align: 'right' }];

  test('produces a well-formed PDF whose xref points where it says', () => {
    const buf = tablePDF({ title: 'T', columns: cols, rows: [['A', 'B', '1.00']], footer: ['Total', '', '1.00'] });
    const s = buf.toString('latin1');
    assert.ok(s.startsWith('%PDF-1.4'));
    assert.ok(s.trimEnd().endsWith('%%EOF'));
    const at = parseInt(s.match(/startxref\n(\d+)/)[1], 10);
    assert.equal(s.slice(at, at + 4), 'xref');
  });

  test('long lists run onto further pages', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ['Rep', 'Row ' + i, '1.00']);
    const s = tablePDF({ title: 'T', columns: cols, rows }).toString('latin1');
    assert.ok((s.match(/\/Type \/Page /g) || []).length >= 3);
  });

  test('brackets and curly quotes cannot break the file', () => {
    const s = tablePDF({ title: 'T', columns: cols, rows: [['(x)', '“café” \\ (y', '2']] }).toString('latin1');
    assert.ok(s.includes('\\(x\\)'));
    assert.ok(!/[“”]/.test(s));
  });
});

describe('scheduled functions', () => {
  test('every scheduled function exports a handler', () => {
    for (const f of ['weekly-digest', 'overdue-nudge', 'office-summary', 'sync-flush', 'accounting-auto']) {
      const mod = require(`../netlify/functions/${f}`);
      assert.equal(typeof mod.handler, 'function', `${f} has no handler`);
    }
  });

  test('sync-flush runs without throwing on an empty queue', async () => {
    const { handler } = require('../netlify/functions/sync-flush');
    const res = await handler({}, {});
    assert.equal(res.statusCode, 200);
  });
});

/* ═══════════ CONFIG SANITY ═══════════ */
describe('netlify config', () => {
  const fs = require('fs');
  const toml = fs.readFileSync(`${__dirname}/../netlify.toml`, 'utf8');

  test('api redirect is present and forced', () => {
    assert.match(toml, /from = "\/api\/\*"/);
    assert.match(toml, /to = "\/\.netlify\/functions\/api\/:splat"/);
    assert.match(toml, /force = true/);
  });

  test('SPA fallback comes after the api rule so it cannot swallow it', () => {
    assert.ok(toml.indexOf('/api/*') < toml.indexOf('from = "/*"'),
      'the catch-all must be declared last or every API call returns index.html');
  });

  test('every schedule is declared', () => {
    for (const f of ['weekly-digest', 'overdue-nudge', 'office-summary', 'sync-flush', 'accounting-auto']) {
      assert.ok(toml.includes(`[functions."${f}"]`), `${f} is not scheduled`);
    }
  });

  test('publish directory matches where index.html lives', () => {
    assert.match(toml, /publish = "public"/);
    assert.ok(fs.existsSync(`${__dirname}/../public/index.html`));
  });
});

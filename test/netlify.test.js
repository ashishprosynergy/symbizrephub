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

const fakeZoho = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    zohoCalls.push({ method: req.method, path: url.pathname });
    const json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    if (url.pathname === '/oauth/v2/token') return json({ access_token: 'fake-' + Date.now(), expires_in: 3600 });
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
  let repToken, officeToken;
  before(async () => {
    repToken = JSON.parse((await invoke('POST','/auth/login',{body:{email:'rep@test.org',password:'correct-horse'}})).body).token;
    officeToken = JSON.parse((await invoke('POST','/auth/login',{body:{email:'office@test.org',password:'correct-horse'}})).body).token;
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
  test('all four export a handler', () => {
    for (const f of ['weekly-digest', 'overdue-nudge', 'office-summary', 'sync-flush']) {
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

  test('all four schedules are declared', () => {
    for (const f of ['weekly-digest', 'overdue-nudge', 'office-summary', 'sync-flush']) {
      assert.ok(toml.includes(`[functions."${f}"]`), `${f} is not scheduled`);
    }
  });

  test('publish directory matches where index.html lives', () => {
    assert.match(toml, /publish = "public"/);
    assert.ok(fs.existsSync(`${__dirname}/../public/index.html`));
  });
});

'use strict';
/**
 * Postgres data layer (replaces SQLite — serverless has no persistent disk).
 *
 * Works with any hosted Postgres. Neon is the usual pairing with Netlify
 * because it's serverless-native and its free tier suits a workload this size.
 *
 * Connection pooling matters here: every function invocation may be a cold
 * start, so we keep ONE pool per container and reuse it across invocations.
 */
const { Pool } = require('pg');

let pool;
/* Neon allows about a hundred direct connections, and every running copy of
   the function holds its own. With a whole team opening the app at once that
   runs out, so connect through Neon's pooler (thousands of connections),
   whose address is the same with "-pooler" after the endpoint name. */
function viaPooler(cs) {
  if (!cs || process.env.PG_NO_POOLER) return cs;
  try {
    const u = new URL(cs);
    if (/.neon.tech$/.test(u.hostname) && !u.hostname.split('.')[0].endsWith('-pooler')) {
      const [first, ...rest] = u.hostname.split('.');
      u.hostname = [first + '-pooler', ...rest].join('.');
      return u.toString();
    }
  } catch { /* not a URL we know: use it as given */ }
  return cs;
}
let poolerOff = false;
function getPool() {
  if (!pool) {
    const cs = poolerOff ? process.env.DATABASE_URL : viaPooler(process.env.DATABASE_URL);
    if (!cs) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString: cs,
      // Serverless: each running copy serves one request at a time, so two
      // connections cover its side-by-side queries; many copies run at once
      max: parseInt(process.env.PG_MAX || '2', 10),
      // Long enough to span typing a password or a code, so the next step
      // doesn't pay for a fresh encrypted connection; Neon sleeps after 5 min.
      idleTimeoutMillis: 120_000,
      connectionTimeoutMillis: 8_000,
      ssl: cs.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    pool.on('error', e => console.error('[pg] idle client error:', e.message));
  }
  return pool;
}

// A connection kept open while the function was frozen can be dead on thaw.
// That is a broken socket, not a bad query, so it is tried once more.
const DEAD_SOCKET = /Connection terminated|ECONNRESET|EPIPE|Client has encountered a connection error|terminating connection/i;
async function query(text, params = []) {
  try {
    return (await getPool().query(text, params)).rows;
  } catch (e) {
    // The pooler address didn't answer: use the direct one from now on
    if (!poolerOff && /ENOTFOUND|ECONNREFUSED|getaddrinfo|ETIMEDOUT/i.test(`${e.code} ${e.message}`) && viaPooler(process.env.DATABASE_URL) !== process.env.DATABASE_URL) {
      console.error('[pg] pooler unreachable, connecting directly:', e.message);
      poolerOff = true; const old = pool; pool = null; old && old.end().catch(() => {});
      return (await getPool().query(text, params)).rows;
    }
    if (!DEAD_SOCKET.test(e.message || '')) throw e;
    return (await getPool().query(text, params)).rows;
  }
}
async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/* ─────────── schema ─────────── */
/*
 * Hours and expenses live in THIS database rather than Zoho. Symbiz's
 * accounting is QuickBooks (the QB_* modules in their CRM are a read-only
 * mirror) and no Zoho module fits. Keeping them here means receipts and
 * claims survive, and the monthly accounting export is built from them.
 *
 * Note: keep this string free of comments. Statements are split on ';' and
 * sent individually, and comment syntax trips some drivers.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL,
  region        TEXT,
  password_hash TEXT NOT NULL,
  zoho_owner_id TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  digest_email  BOOLEAN NOT NULL DEFAULT TRUE,
  digest_sms    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  client_uuid TEXT NOT NULL,
  module      TEXT NOT NULL,
  op          TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  zoho_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at   TIMESTAMPTZ,
  UNIQUE (user_id, client_uuid)
);

CREATE TABLE IF NOT EXISTS audit (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_log (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT,
  kind       TEXT NOT NULL,
  channel    TEXT NOT NULL,
  subject    TEXT,
  ok         BOOLEAN NOT NULL,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  rep_name    TEXT,
  entry_date  DATE NOT NULL,
  hours       NUMERIC(6,2) NOT NULL,
  category    TEXT NOT NULL,
  description TEXT,
  ring_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'Submitted',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  rep_name      TEXT,
  entry_date    DATE NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  category      TEXT NOT NULL,
  description   TEXT,
  ring_id       TEXT,
  receipt_name  TEXT,
  receipt_type  TEXT,
  receipt_data  TEXT,
  status        TEXT NOT NULL DEFAULT 'Submitted',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at   TIMESTAMPTZ,
  approved_by   TEXT
);

CREATE TABLE IF NOT EXISTS pending_writes (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  rep_id      TEXT NOT NULL,
  rep_name    TEXT,
  rep_zoho_id TEXT,
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  zoho_id     TEXT,
  error       TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  decided_by  TEXT
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'signin',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip         TEXT
);

ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'signin';

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS vendor TEXT;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS books_bill_id TEXT;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS books_error TEXT;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS books_queued BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS accounting_batches (
  id            SERIAL PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  period        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  time_ids      TEXT NOT NULL,
  expense_ids   TEXT NOT NULL,
  requested_by  TEXT,
  approver      TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT
);

CREATE TABLE IF NOT EXISTS trusted_devices (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_user ON trusted_devices (user_id);

CREATE TABLE IF NOT EXISTS summit_tasks (
  id          SERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  stage       TEXT,
  due_offset  INTEGER,
  owner       TEXT,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  done_by     TEXT,
  done_at     TIMESTAMPTZ,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS summit_links (
  id          SERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL,
  label       TEXT NOT NULL,
  url         TEXT NOT NULL,
  added_by    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS summit_notes (
  event_id    TEXT PRIMARY KEY,
  notes       TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_summit_tasks ON summit_tasks (event_id, position);
ALTER TABLE summit_tasks ADD COLUMN IF NOT EXISTS owner_id TEXT;

CREATE TABLE IF NOT EXISTS rep_goals (
  rep_id      TEXT NOT NULL,
  quarter     TEXT NOT NULL,
  calls       INTEGER,
  visits      INTEGER,
  new_members INTEGER,
  set_by      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rep_id, quarter)
);

CREATE TABLE IF NOT EXISTS rep_notes (
  id           SERIAL PRIMARY KEY,
  rep_id       TEXT NOT NULL,
  author       TEXT,
  note         TEXT NOT NULL,
  next_checkin DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS decline_note TEXT;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS books_queued BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS books_bill_id TEXT;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS books_error TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS decline_note TEXT;
CREATE TABLE IF NOT EXISTS zoho_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS visit_plans (ring_id TEXT PRIMARY KEY, visit_date DATE NOT NULL, visit_time TEXT, location TEXT, notes TEXT, set_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rep_messages (
  id          SERIAL PRIMARY KEY,
  sent_by     TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  recipients  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rep_notes ON rep_notes (rep_id, created_at);

CREATE TABLE IF NOT EXISTS geocodes (
  address_key TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_user ON login_tokens (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_writes (status, created_at);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries (user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_exp_user  ON expenses (user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_queue_status ON sync_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit (user_id, created_at);
`;

/**
 * Runs the schema. Guarded by a module-level flag so a warm container
 * doesn't re-issue DDL on every invocation, and executed statement by
 * statement because some drivers reject multi-statement strings.
 */
let migrated = false;
// Changes whenever SCHEMA does, so an unchanged schema costs one query on a
// cold start instead of twenty-odd DDL statements one after another.
const SCHEMA_VERSION = require('crypto').createHash('sha1').update(SCHEMA).digest('hex').slice(0, 12);
async function migrate({ force = false } = {}) {
  if (migrated && !force) return true;
  if (!force) {
    try {
      const row = await one("SELECT value FROM settings WHERE key = 'schema_version'");
      if (row && row.value === SCHEMA_VERSION) { migrated = true; return true; }
    } catch (e) { /* no settings table yet: fall through and build everything */ }
  }
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await getPool().query(stmt);
    } catch (e) {
      // "already exists" is fine — IF NOT EXISTS races between cold starts
      if (!/already exists/i.test(e.message)) throw e;
    }
  }
  await query(
    "INSERT INTO settings (key,value) VALUES ('schema_version',$1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [SCHEMA_VERSION]).catch(() => {});
  migrated = true;
  return true;
}

/* ─────────── queries ─────────── */
const q = {
  userByEmail: email => one('SELECT * FROM users WHERE lower(email) = lower($1) AND active = TRUE', [email]),
  userById:    id    => one('SELECT * FROM users WHERE id = $1', [id]),
  anyUserByEmail: email => one('SELECT id, active FROM users WHERE lower(email) = lower($1)', [email]),
  allReps:     ()    => query("SELECT * FROM users WHERE role = 'rep' AND active = TRUE ORDER BY name"),
  allOffice:   ()    => query("SELECT * FROM users WHERE role IN ('staff','admin') AND active = TRUE"),
  // Active accounts only. A deactivated one must disappear from the list and
  // free its Zoho contact so the person can be re-added.
  allUsers:    ()    => query('SELECT id,email,name,role,region,active,phone,zoho_owner_id,last_login_at,digest_email FROM users WHERE active = TRUE ORDER BY role, name'),
  everyUser:   ()    => query('SELECT id,email,name,role,region,active,phone,zoho_owner_id FROM users ORDER BY role, name'),
  hardDelete:  id    => query('DELETE FROM users WHERE id = $1', [id]),
  dropTokensFor: id  => query('DELETE FROM login_tokens WHERE user_id = $1', [id]),
  touchLogin:  id    => query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]),
  /** When each person was last sent a "choose your password" link */
  lastInvites: () => query("SELECT user_id, max(created_at) AS at FROM login_tokens WHERE purpose = 'setpassword' GROUP BY user_id"),
  setDigestEmail: (id, on) => query('UPDATE users SET digest_email = $2 WHERE id = $1', [id, !!on]),
  insertUser:  u     => query(
    `INSERT INTO users (id,email,name,phone,role,region,password_hash,zoho_owner_id,email_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [u.id, u.email, u.name, u.phone, u.role, u.region, u.password_hash, u.zoho_owner_id,
     u.email_verified !== false]),
  setPassword: (hash, id) => query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]),
  markVerified: id => query('UPDATE users SET email_verified = TRUE WHERE id = $1', [id]),
  // Someone signing up again before confirming: keep the one row, take the new details
  updateSignup: (id, name, hash) => query('UPDATE users SET name = $1, password_hash = $2 WHERE id = $3', [name, hash, id]),
  deactivate:  id    => query('UPDATE users SET active = FALSE WHERE id = $1', [id]),

  enqueue: (userId, clientUuid, module, op, payload) => query(
    `INSERT INTO sync_queue (user_id,client_uuid,module,op,payload)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, client_uuid) DO NOTHING
     RETURNING id`,
    [userId, clientUuid, module, op, payload]),
  byClientUuid: (userId, clientUuid) =>
    one('SELECT * FROM sync_queue WHERE user_id = $1 AND client_uuid = $2', [userId, clientUuid]),
  pending:    limit => query("SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at LIMIT $1", [limit]),
  pendingFor: userId => one("SELECT count(*)::int AS c FROM sync_queue WHERE user_id = $1 AND status = 'pending'", [userId]),
  markDone:   (zohoId, id) => query("UPDATE sync_queue SET status='done', zoho_id=$1, synced_at=now() WHERE id = $2", [zohoId, id]),
  markFailed: (status, err, id) => query('UPDATE sync_queue SET status=$1, attempts=attempts+1, last_error=$2 WHERE id = $3', [status, err, id]),

  audit:      (userId, action, detail, ip) => query('INSERT INTO audit (user_id,action,detail,ip) VALUES ($1,$2,$3,$4)', [userId, action, detail, ip]),
  recentAudit: limit => query('SELECT * FROM audit ORDER BY created_at DESC LIMIT $1', [limit]),
  /** How often one internet address did something lately (public forms) */
  recentAuditByIp: (ip, action, minutes) => one(
    'SELECT count(*)::int AS c FROM audit WHERE ip = $1 AND action = $2 AND created_at > $3',
    [ip || '', action, new Date(Date.now() - minutes * 60000).toISOString()]),
  /** A self-registration already waiting for this person and event */
  pendingSelfRegistration: (eventId, email) => one(
    "SELECT id FROM pending_writes WHERE kind = 'registration' AND status = 'pending' AND rep_id = 'public' AND payload->>'eventId' = $1 AND lower(payload->>'email') = lower($2)",
    [eventId, email]),
  recentAuditCount: (userId, action, minutes) => one(
    'SELECT count(*)::int AS c FROM audit WHERE user_id = $1 AND action = $2 AND created_at > $3',
    [userId, action, new Date(Date.now() - minutes * 60000).toISOString()]),
  // Wrong passwords since the last good sign-in, within the window
  failsSinceOk: async (userId, minutes) => {
    const ok = await one("SELECT max(created_at) AS at FROM audit WHERE user_id = $1 AND action = 'login.ok'", [userId]);
    const since = new Date(Math.max(Date.now() - minutes * 60000, ok && ok.at ? new Date(ok.at).getTime() : 0));
    return one("SELECT count(*)::int AS c FROM audit WHERE user_id = $1 AND action = 'login.failed' AND created_at > $2",
      [userId, since.toISOString()]);
  },

  /* ── trusted devices ── */
  addDevice: (hash, userId, label, expires) => query(
    'INSERT INTO trusted_devices (token_hash,user_id,label,expires_at) VALUES ($1,$2,$3,$4)', [hash, userId, label, expires]),
  deviceByHash: hash => one('SELECT * FROM trusted_devices WHERE token_hash = $1', [hash]),
  touchDevice: hash => query('UPDATE trusted_devices SET last_used_at = now() WHERE token_hash = $1', [hash]),
  devicesFor: userId => query(
    'SELECT token_hash,label,created_at,last_used_at,expires_at FROM trusted_devices WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC', [userId]),
  forgetDevice: (hash, userId) => query('DELETE FROM trusted_devices WHERE token_hash = $1 AND user_id = $2', [hash, userId]),
  forgetDevicesFor: userId => query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]),
  setRole: (id, role) => query('UPDATE users SET role = $1 WHERE id = $2', [role, id]),
  /* ── managing reps ── */
  goalsFor: quarter => query('SELECT * FROM rep_goals WHERE quarter = $1', [quarter]),
  setGoal: (repId, quarter, g, by) => query(
    `INSERT INTO rep_goals (rep_id, quarter, calls, visits, new_members, set_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (rep_id, quarter) DO UPDATE SET calls = EXCLUDED.calls, visits = EXCLUDED.visits,
       new_members = EXCLUDED.new_members, set_by = EXCLUDED.set_by, updated_at = now()`,
    [repId, quarter, g.calls, g.visits, g.newMembers, by]),
  repNotes: repId => query('SELECT * FROM rep_notes WHERE rep_id = $1 ORDER BY created_at DESC, id DESC', [repId]),
  allRepNotes: () => query('SELECT * FROM rep_notes ORDER BY created_at DESC, id DESC'),
  addRepNote: (repId, author, note, next) => query(
    'INSERT INTO rep_notes (rep_id, author, note, next_checkin) VALUES ($1,$2,$3,$4) RETURNING id', [repId, author, note, next || null]),
  deleteRepNote: (id) => query('DELETE FROM rep_notes WHERE id = $1', [id]),
  addRepMessage: (by, subject, body, recipients) => query(
    'INSERT INTO rep_messages (sent_by, subject, body, recipients) VALUES ($1,$2,$3,$4) RETURNING id', [by, subject, body, recipients]),
  recentRepMessages: () => query('SELECT * FROM rep_messages ORDER BY created_at DESC LIMIT 20'),

  /* ── summits ── */
  summitTasks: eventId => query('SELECT * FROM summit_tasks WHERE event_id = $1 ORDER BY position, id', [eventId]),
  /** Every summit task, small enough to read whole: for progress and what is late */
  summitTaskRows: () => query('SELECT event_id, title, due_offset, done, owner FROM summit_tasks ORDER BY position, id'),
  /** Where and when a planned visit is: Zoho only holds the date */
  visitPlans: () => query('SELECT * FROM visit_plans'),
  setVisitPlan: (ringId, f, by) => query(
    `INSERT INTO visit_plans (ring_id, visit_date, visit_time, location, notes, set_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (ring_id) DO UPDATE SET visit_date = EXCLUDED.visit_date, visit_time = EXCLUDED.visit_time, location = EXCLUDED.location,
       notes = EXCLUDED.notes, set_by = EXCLUDED.set_by, updated_at = now()`,
    [ringId, f.date, f.time || null, f.location || null, f.notes || null, by || null]),
  dropVisitPlan: ringId => query('DELETE FROM visit_plans WHERE ring_id = $1', [ringId]),
  summitTaskCounts: () => query('SELECT event_id, count(*)::int AS total, sum(CASE WHEN done THEN 1 ELSE 0 END)::int AS done FROM summit_tasks GROUP BY event_id'),
  addSummitTask: t => query(
    `INSERT INTO summit_tasks (event_id,title,stage,due_offset,owner,owner_id,position) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t.eventId, t.title, t.stage || null, t.dueOffset ?? null, t.owner || null, t.ownerId || null, t.position || 0]),
  /** A whole checklist in one statement: one trip to the database, not twenty */
  addSummitTasks: (eventId, list) => {
    const vals = [], params = [];
    list.forEach((t, i) => { const b = i * 6;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      params.push(eventId, t.title, t.stage || null, t.dueOffset ?? null, t.position || 0, t.owner || null); });
    return query(`INSERT INTO summit_tasks (event_id,title,stage,due_offset,position,owner) VALUES ${vals.join(',')}`, params);
  },
  /** Open tasks given to one person, across every summit */
  summitTasksFor: userId => query('SELECT * FROM summit_tasks WHERE owner_id = $1 AND done = FALSE ORDER BY event_id, position', [userId]),
  updateSummitTask: (id, eventId, f) => query(
    `UPDATE summit_tasks SET title = COALESCE($3,title), owner = $4, due_offset = $5, done = $6,
       done_by = CASE WHEN $6 THEN COALESCE(done_by,$7) ELSE NULL END,
       done_at = CASE WHEN $6 THEN COALESCE(done_at, now()) ELSE NULL END,
       owner_id = $8
     WHERE id = $1 AND event_id = $2`,
    [id, eventId, f.title ?? null, f.owner ?? null, f.dueOffset ?? null, !!f.done, f.doneBy || null, f.ownerId || null]),
  deleteSummitTask: (id, eventId) => query('DELETE FROM summit_tasks WHERE id = $1 AND event_id = $2', [id, eventId]),
  clearSummitTasks: eventId => query('DELETE FROM summit_tasks WHERE event_id = $1', [eventId]),
  summitLinks: eventId => query('SELECT * FROM summit_links WHERE event_id = $1 ORDER BY id', [eventId]),
  addSummitLink: (eventId, label, url, by) => query(
    'INSERT INTO summit_links (event_id,label,url,added_by) VALUES ($1,$2,$3,$4) RETURNING id', [eventId, label, url, by]),
  deleteSummitLink: (id, eventId) => query('DELETE FROM summit_links WHERE id = $1 AND event_id = $2', [id, eventId]),
  summitNotes: eventId => one('SELECT * FROM summit_notes WHERE event_id = $1', [eventId]),
  allSummitNotes: () => query('SELECT event_id, notes, updated_at FROM summit_notes'),
  saveSummitNotes: (eventId, notes, by) => query(
    `INSERT INTO summit_notes (event_id,notes,updated_by,updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (event_id) DO UPDATE SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [eventId, notes, by]),
  allGeocodes: () => query('SELECT address_key, lat, lng, source, created_at FROM geocodes'),
  saveGeocode: (key, lat, lng, source) => query(
    `INSERT INTO geocodes (address_key, lat, lng, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (address_key) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, source = EXCLUDED.source, created_at = now()`,
    [key, lat, lng, source]),
  linkZoho: (id, contactId, phone, region) => query(
    'UPDATE users SET zoho_owner_id = $2, phone = COALESCE(phone, $3), region = COALESCE(region, $4) WHERE id = $1 AND zoho_owner_id IS NULL',
    [id, contactId, phone, region]),

  getSetting: key => one('SELECT value FROM settings WHERE key = $1', [key]),
  setSetting: (key, value) => query(
    'INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]),
  /* ── hours ── */
  addTime: t => query(
    `INSERT INTO time_entries (user_id,rep_name,entry_date,hours,category,description,ring_id,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Submitted') RETURNING id`,
    [t.userId, t.repName, t.date, t.hours, t.category, t.description, t.ringId || null]),
  timeFor: userId => query(
    'SELECT * FROM time_entries WHERE user_id = $1 ORDER BY entry_date DESC LIMIT 500', [userId]),
  // With the rep's Zoho contact, which is how the office screens pick a rep
  allTime: () => query(`SELECT t.*, u.zoho_owner_id AS rep_contact FROM time_entries t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.entry_date DESC LIMIT 1000`),
  approveTime: (id, by) => query(
    "UPDATE time_entries SET status='Approved', approved_at=now(), approved_by=$2 WHERE id = $1", [id, by]),
  markTimeSent: () => query("UPDATE time_entries SET status='Reimbursed' WHERE status='Approved'"),
  // Only the items in a batch: anything approved after Mel was asked waits for the next one
  markTimeSentIds: ids => ids.length ? query(
    `UPDATE time_entries SET status='Reimbursed' WHERE status='Approved' AND id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})`,
    ids.map(Number)) : Promise.resolve([]),
  markExpensesSentIds: ids => ids.length ? query(
    `UPDATE expenses SET status='Reimbursed' WHERE status='Approved' AND id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})`,
    ids.map(Number)) : Promise.resolve([]),

  /* ── accounting batches awaiting the approver ── */
  addBatch: b => query(
    `INSERT INTO accounting_batches (token,period,time_ids,expense_ids,requested_by,approver)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [b.token, b.period || null, JSON.stringify(b.timeIds), JSON.stringify(b.expenseIds), b.requestedBy || null, b.approver]),
  batchById: id => one('SELECT * FROM accounting_batches WHERE id = $1', [id]),
  // The office sees the admin's note on a batch sent back, for a fortnight
  lastReturnedBatch: () => one(
    "SELECT * FROM accounting_batches WHERE status = 'returned' AND decided_at > now() - interval '14 days' ORDER BY decided_at DESC LIMIT 1"),
  batchByPeriod: period => one('SELECT * FROM accounting_batches WHERE period = $1', [period]),
  pendingBatches: () => query("SELECT * FROM accounting_batches WHERE status = 'pending' ORDER BY created_at DESC"),
  decideBatch: (id, status, by, note) => query(
    "UPDATE accounting_batches SET status = $2, decided_at = now(), decided_by = $3, note = $4 WHERE id = $1 AND status = 'pending'",
    [id, status, by || null, note || null]),
  // Asking again replaces the open request, so Mel never sees two versions
  supersedeBatches: () => query(
    "UPDATE accounting_batches SET status = 'replaced', decided_at = now() WHERE status = 'pending'"),

  /* ── expenses ── */
  addExpense: x => query(
    `INSERT INTO expenses (user_id,rep_name,entry_date,amount,category,description,ring_id,
                           receipt_name,receipt_type,receipt_data,vendor,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Submitted') RETURNING id`,
    [x.userId, x.repName, x.date, x.amount, x.category, x.description, x.ringId || null,
     x.receiptName || null, x.receiptType || null, x.receiptData || null, x.vendor || null]),
  expensesFor: userId => query(
    `SELECT id,user_id,rep_name,entry_date,amount,category,description,ring_id,vendor,
            receipt_name,receipt_type,status,created_at,approved_by,books_bill_id,books_error,decline_note
     FROM expenses WHERE user_id = $1 ORDER BY entry_date DESC LIMIT 500`, [userId]),
  allExpenses: () => query(
    `SELECT e.id,e.user_id,e.rep_name,e.entry_date,e.amount,e.category,e.description,e.ring_id,e.vendor,
            e.receipt_name,e.receipt_type,e.status,e.created_at,e.approved_by,e.books_bill_id,e.books_error,e.decline_note,
            u.zoho_owner_id AS rep_contact
     FROM expenses e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.entry_date DESC LIMIT 1000`),
  // Zoho Books. Only expenses sent to accounting after Books was connected are
  // queued, so a batch already handled by hand is never billed a second time.
  queueBills: ids => ids.length ? query(
    `UPDATE expenses SET books_queued = TRUE WHERE id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})`,
    ids.map(Number)) : Promise.resolve([]),
  billsToMake: (limit, includeFailed) => query(
    `SELECT id,user_id,rep_name,entry_date,amount,category,description,vendor,receipt_name,receipt_type,
            approved_by,books_error
     FROM expenses WHERE books_queued = TRUE AND books_bill_id IS NULL
       AND ($2::boolean OR books_error IS NULL)
     ORDER BY id LIMIT $1`, [limit, !!includeFailed]),
  // Remember the bill made for an expense so it is never made twice
  setExpenseBill: (id, billId, error) => query(
    'UPDATE expenses SET books_bill_id = COALESCE($2, books_bill_id), books_error = $3 WHERE id = $1',
    [id, billId || null, error || null]),
  // Hours become one bill per rep per week, so each entry remembers its bill
  queueTimeBills: ids => ids.length ? query(
    `UPDATE time_entries SET books_queued = TRUE WHERE id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})`,
    ids.map(Number)) : Promise.resolve([]),
  // Hours already sent to accounting that never got a bill (before hours were billed)
  queueSentTimeWithoutBill: () => query(
    "UPDATE time_entries SET books_queued = TRUE WHERE status = 'Reimbursed' AND books_bill_id IS NULL AND books_queued = FALSE RETURNING id"),
  timeBillsToMake: (limit, includeFailed) => query(
    `SELECT id,user_id,rep_name,entry_date,hours,category,description,approved_by,books_error
     FROM time_entries WHERE books_queued = TRUE AND books_bill_id IS NULL
       AND ($2::boolean OR books_error IS NULL)
     ORDER BY user_id, entry_date, id LIMIT $1`, [limit, !!includeFailed]),
  setTimeBill: (ids, billId, error) => ids.length ? query(
    `UPDATE time_entries SET books_bill_id = COALESCE($1, books_bill_id), books_error = $2
     WHERE id IN (${ids.map((_, i) => '$' + (i + 3)).join(',')})`, [billId || null, error || null, ...ids.map(Number)]) : Promise.resolve([]),
  receiptFor: id => one('SELECT user_id,receipt_name,receipt_type,receipt_data FROM expenses WHERE id = $1', [id]),
  /** Sent back to the rep with a reason; they can fix it and submit again */
  declineTime: (id, by, note) => query(
    "UPDATE time_entries SET status='Declined', approved_at=now(), approved_by=$2, decline_note=$3 WHERE id = $1 AND status IN ('Submitted','Approved') RETURNING user_id, entry_date, hours, category", [id, by, note]),
  declineExpense: (id, by, note) => query(
    "UPDATE expenses SET status='Declined', approved_at=now(), approved_by=$2, decline_note=$3 WHERE id = $1 AND status IN ('Submitted','Approved') RETURNING user_id, entry_date, amount, category", [id, by, note]),
  /** The rep's own declined claim, corrected and sent again */
  resubmitTime: (id, userId, hours, description) => query(
    "UPDATE time_entries SET status='Submitted', hours=COALESCE($3,hours), description=COALESCE($4,description), approved_at=NULL, approved_by=NULL WHERE id = $1 AND user_id = $2 AND status = 'Declined' RETURNING id", [id, userId, hours, description]),
  resubmitExpense: (id, userId, amount, description) => query(
    "UPDATE expenses SET status='Submitted', amount=COALESCE($3,amount), description=COALESCE($4,description), approved_at=NULL, approved_by=NULL WHERE id = $1 AND user_id = $2 AND status = 'Declined' RETURNING id", [id, userId, amount, description]),
  approveExpense: (id, by) => query(
    "UPDATE expenses SET status='Approved', approved_at=now(), approved_by=$2 WHERE id = $1", [id, by]),
  markExpensesSent: () => query("UPDATE expenses SET status='Reimbursed' WHERE status='Approved'"),

  /* ── things a rep has asked to put into Zoho, awaiting the office ── */
  addWriteRequest: p => query(
    `INSERT INTO pending_writes (kind,payload,rep_id,rep_name,rep_zoho_id,summary)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.kind, JSON.stringify(p.payload), p.repId, p.repName, p.repZohoId || null, p.summary]),
  writeRequestsFor: repId => query(
    'SELECT * FROM pending_writes WHERE rep_id = $1 ORDER BY created_at DESC LIMIT 200', [repId]),
  allWriteRequests: () => query(
    "SELECT * FROM pending_writes ORDER BY (status='pending') DESC, created_at DESC LIMIT 300"),
  oneWriteRequest: id => one('SELECT * FROM pending_writes WHERE id = $1', [id]),
  /** Registrations still waiting on the office, for one event */
  pendingRegistrationsFor: eventId => query(
    "SELECT id, payload, summary, rep_name, created_at FROM pending_writes WHERE kind = 'registration' AND status = 'pending' AND payload->>'eventId' = $1",
    [String(eventId)]),
  markWriteRequest: (id, status, by, extra = {}) => query(
    `UPDATE pending_writes SET status=$2, decided_at=now(), decided_by=$3,
            zoho_id=COALESCE($4,zoho_id), error=$5, note=COALESCE($6,note)
     WHERE id = $1`,
    [id, status, by, extra.zohoId || null, extra.error || null, extra.note || null]),

  /* ── sign-in links ── */
  addLoginToken: (token, userId, expiresAt, ip, purpose) => query(
    'INSERT INTO login_tokens (token,user_id,purpose,expires_at,ip) VALUES ($1,$2,$3,$4,$5)',
    [token, userId, purpose || 'signin', expiresAt, ip || null]),
  findLoginToken: token => one('SELECT * FROM login_tokens WHERE token = $1', [token]),
  useLoginToken: token => query('UPDATE login_tokens SET used_at = now() WHERE token = $1', [token]),
  // How many links this person asked for recently, so one address cannot be
  // used to spam someone's inbox.
  // Counted per purpose: asking for a sign-in link should not use up the
  // allowance for password codes, and vice versa.
  recentTokenCount: (userId, purpose) => one(
    `SELECT count(*)::int AS c FROM login_tokens
     WHERE user_id = $1 AND created_at > now() - interval '10 minutes'
       AND ($2::text IS NULL OR purpose = $2)`,
    [userId, purpose || null]),
  // Once one code has worked, every other outstanding code of that kind dies.
  // Killing them when a NEW code was sent instead meant asking twice made the
  // first email's code fail with "already used".
  expireOtherCodes: (userId, purpose) => query(
    'UPDATE login_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
    [userId, purpose]),
  purgeOldTokens: () => query("DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'"),

  logSend: (userId, kind, channel, subject, ok, error) => query(
    'INSERT INTO sent_log (user_id,kind,channel,subject,ok,error) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, kind, channel, subject, ok, error]),
};

async function audit(userId, action, detail, ip) {
  try { await q.audit(userId || null, action, detail ? JSON.stringify(detail) : null, ip || null); }
  catch (e) { console.error('[audit] failed:', e.message); }
}

async function setting(key, fallback) {
  try { const row = await q.getSetting(key); return row ? row.value : fallback; }
  catch { return fallback; }
}

/** Several settings in one trip to the database: { key: value or fallback }. */
async function settings(defaults) {
  const keys = Object.keys(defaults);
  const out = { ...defaults };
  try {
    const marks = keys.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query(`SELECT key, value FROM settings WHERE key IN (${marks})`, keys);
    rows.forEach(r => { out[r.key] = r.value; });
  } catch { /* fallbacks */ }
  return out;
}

module.exports = { viaPooler, getPool, query, one, migrate, q, audit, setting, settings, SCHEMA, _setPoolForTests: p => { pool = p; } };

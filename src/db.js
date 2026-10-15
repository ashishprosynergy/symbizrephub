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
function getPool() {
  if (!pool) {
    const cs = process.env.DATABASE_URL;
    if (!cs) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString: cs,
      // Serverless: keep the pool tiny, connections are precious
      max: parseInt(process.env.PG_MAX || '3', 10),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: cs.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    pool.on('error', e => console.error('[pg] idle client error:', e.message));
  }
  return pool;
}

async function query(text, params = []) {
  const res = await getPool().query(text, params);
  return res.rows;
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
async function migrate({ force = false } = {}) {
  if (migrated && !force) return true;
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await getPool().query(stmt);
    } catch (e) {
      // "already exists" is fine — IF NOT EXISTS races between cold starts
      if (!/already exists/i.test(e.message)) throw e;
    }
  }
  migrated = true;
  return true;
}

/* ─────────── queries ─────────── */
const q = {
  userByEmail: email => one('SELECT * FROM users WHERE lower(email) = lower($1) AND active = TRUE', [email]),
  userById:    id    => one('SELECT * FROM users WHERE id = $1', [id]),
  allReps:     ()    => query("SELECT * FROM users WHERE role = 'rep' AND active = TRUE ORDER BY name"),
  allOffice:   ()    => query("SELECT * FROM users WHERE role IN ('staff','admin') AND active = TRUE"),
  // Active accounts only. A deactivated one must disappear from the list and
  // free its Zoho contact so the person can be re-added.
  allUsers:    ()    => query('SELECT id,email,name,role,region,active,phone,zoho_owner_id FROM users WHERE active = TRUE ORDER BY role, name'),
  everyUser:   ()    => query('SELECT id,email,name,role,region,active,phone,zoho_owner_id FROM users ORDER BY role, name'),
  hardDelete:  id    => query('DELETE FROM users WHERE id = $1', [id]),
  touchLogin:  id    => query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]),
  insertUser:  u     => query(
    `INSERT INTO users (id,email,name,phone,role,region,password_hash,zoho_owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u.id, u.email, u.name, u.phone, u.role, u.region, u.password_hash, u.zoho_owner_id]),
  setPassword: (hash, id) => query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]),
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
  allTime: () => query('SELECT * FROM time_entries ORDER BY entry_date DESC LIMIT 1000'),
  approveTime: (id, by) => query(
    "UPDATE time_entries SET status='Approved', approved_at=now(), approved_by=$2 WHERE id = $1", [id, by]),
  markTimeSent: () => query("UPDATE time_entries SET status='Reimbursed' WHERE status='Approved'"),

  /* ── expenses ── */
  addExpense: x => query(
    `INSERT INTO expenses (user_id,rep_name,entry_date,amount,category,description,ring_id,
                           receipt_name,receipt_type,receipt_data,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Submitted') RETURNING id`,
    [x.userId, x.repName, x.date, x.amount, x.category, x.description, x.ringId || null,
     x.receiptName || null, x.receiptType || null, x.receiptData || null]),
  expensesFor: userId => query(
    `SELECT id,user_id,rep_name,entry_date,amount,category,description,ring_id,
            receipt_name,receipt_type,status,created_at
     FROM expenses WHERE user_id = $1 ORDER BY entry_date DESC LIMIT 500`, [userId]),
  allExpenses: () => query(
    `SELECT id,user_id,rep_name,entry_date,amount,category,description,ring_id,
            receipt_name,receipt_type,status,created_at
     FROM expenses ORDER BY entry_date DESC LIMIT 1000`),
  receiptFor: id => one('SELECT receipt_name,receipt_type,receipt_data FROM expenses WHERE id = $1', [id]),
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
  markWriteRequest: (id, status, by, extra = {}) => query(
    `UPDATE pending_writes SET status=$2, decided_at=now(), decided_by=$3,
            zoho_id=COALESCE($4,zoho_id), error=$5, note=COALESCE($6,note)
     WHERE id = $1`,
    [id, status, by, extra.zohoId || null, extra.error || null, extra.note || null]),

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

module.exports = { getPool, query, one, migrate, q, audit, setting, SCHEMA, _setPoolForTests: p => { pool = p; } };

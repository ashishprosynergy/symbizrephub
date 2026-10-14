#!/usr/bin/env node
'use strict';
/**
 * Creates the initial logins in Postgres. Run once after the first deploy:
 *   DATABASE_URL="postgres://..." node scripts/seed-users.js
 * Prints temporary passwords — have each person change theirs immediately.
 */
require('dotenv').config();
const db = require('../src/db');
const auth = require('../src/auth');

const users = [
  { id: 'u_aaron',   email: 'aaron@symbiz.org',   name: 'Aaron Yoder',        role: 'rep',   region: 'Lancaster PA' },
  { id: 'u_miriam',  email: 'miriam@symbiz.org',  name: 'Miriam Hershberger', role: 'rep',   region: 'Holmes County OH' },
  { id: 'u_keturah', email: 'keturah@symbiz.org', name: 'Keturah Leid',       role: 'staff', region: null },
  { id: 'u_jeremy',  email: 'jeremy@symbiz.org',  name: 'Jeremy Sensenig',    role: 'admin', region: null },
];

(async () => {
  await db.migrate();
  let made = 0;
  for (const u of users) {
    const temp = Math.random().toString(36).slice(2, 10);
    try {
      await db.q.insertUser({ ...u, phone: null, password_hash: auth.hash(temp), zoho_owner_id: null });
      console.log(u.email.padEnd(24) + ' temp password: ' + temp);
      made++;
    } catch (e) {
      if (/duplicate|unique/i.test(e.message)) console.log(u.email.padEnd(24) + ' already exists, skipped');
      else throw e;
    }
  }
  console.log('\n' + made + ' user(s) created.');
  process.exit(0);
})().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });

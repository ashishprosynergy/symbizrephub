'use strict';
/**
 * Background: sends what is waiting in the outbox (invitations, sign-in
 * links). Started right after the office presses Invite, so the button
 * answers at once instead of waiting on Gmail. Anything that fails is tried
 * again by the 15-minute job.
 */
const crypto = require('crypto');
const cfg = require('../../src/config');
const { migrate } = require('../../src/db');
const reminders = require('../../src/reminders');

exports.handler = async (event) => {
  const want = crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
  const got = String((event.headers || {})['x-rephub-key'] || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { statusCode: 403 };
  try {
    await migrate();
    const out = await reminders.flushOutbox({ budgetMs: 10 * 60 * 1000, limit: 500 });
    console.log('[mail-background]', JSON.stringify(out));
  } catch (e) {
    console.error('[mail-background] failed:', e.message);
  }
  return { statusCode: 200 };
};

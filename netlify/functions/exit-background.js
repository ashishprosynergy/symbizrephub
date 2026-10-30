'use strict';
/**
 * Background: files exit interviews the way the office files the paper form
 * (src/exits.js): a PDF on the member in Zoho, a copy in the Drive folder,
 * and an email with it. Started as soon as a rep records one; anything
 * unfinished is tried again by the 15-minute job.
 */
const crypto = require('crypto');
const cfg = require('../../src/config');
const { migrate } = require('../../src/db');
const exits = require('../../src/exits');
const reminders = require('../../src/reminders');

exports.handler = async (event) => {
  const want = crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
  const got = String((event.headers || {})['x-rephub-key'] || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { statusCode: 403 };
  try {
    await migrate();
    const out = await exits.processExits({ budgetMs: 5 * 60 * 1000 });
    await reminders.flushOutbox({ budgetMs: 60 * 1000 });
    console.log('[exit-background]', JSON.stringify(out));
  } catch (e) {
    console.error('[exit-background] failed:', e.message);
  }
  return { statusCode: 200 };
};

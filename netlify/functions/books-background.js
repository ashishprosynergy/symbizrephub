'use strict';
/**
 * Background (the "-background" name tells Netlify): makes the Zoho Books
 * bills for expenses just sent to accounting. Netlify answers the caller with
 * 202 straight away and lets this run for up to 15 minutes, so the Send
 * button no longer waits on Zoho Books. Anything left over is picked up by
 * the 15-minute sync-flush job.
 */
const crypto = require('crypto');
const cfg = require('../../src/config');
const { migrate } = require('../../src/db');
const books = require('../../src/lib/books');

exports.handler = async (event) => {
  const want = crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
  const got = String((event.headers || {})['x-rephub-key'] || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return { statusCode: 403 };
  }
  try {
    await migrate();
    const out = await books.makeBills({ budgetMs: 12 * 60 * 1000, limit: 500 });
    console.log('[books-background]', JSON.stringify(out));
  } catch (e) {
    console.error('[books-background] failed:', e.message);
  }
  return { statusCode: 200 };
};

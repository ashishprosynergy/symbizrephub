'use strict';
/**
 * Scheduled: daily, 13:00 UTC (9 am US Eastern in summer, 8 am in winter).
 *
 * On the day chosen in Settings → Accounting, puts everything approved into
 * a batch and emails the approver (Mel) a link to review and approve it.
 * Nothing reaches accounting or Zoho Books until he does. With no approver
 * set, it sends straight to accounting instead. Asks at most once a day.
 */
const { schedule } = require('@netlify/functions');
const { migrate } = require('../../src/db');
const routes = require('../../src/routes');

module.exports.handler = schedule('0 13 * * *', async () => {
  try {
    await migrate();
    const out = await routes.runAutoAccounting();
    console.log('[accounting-auto]', JSON.stringify(out));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[accounting-auto] failed:', e.message);
    return { statusCode: 500 };
  }
});

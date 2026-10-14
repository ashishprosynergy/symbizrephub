'use strict';
/** Scheduled: Mondays 11:00 UTC. Sends each rep their list of calls due. */
const { schedule } = require('@netlify/functions');
const { runWeeklyDigest } = require('../../src/reminders');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('0 11 * * 1', async () => {
  try {
    await migrate();
    const results = await runWeeklyDigest({ dryRun: false });
    console.log('[weekly-digest]', JSON.stringify(results));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[weekly-digest] failed:', e.message);
    return { statusCode: 500 };
  }
});

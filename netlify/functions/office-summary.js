'use strict';
/** Scheduled: 1st of the month, 11:00 UTC. Network summary to the office. */
const { schedule } = require('@netlify/functions');
const { runOfficeSummary } = require('../../src/reminders');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('0 11 1 * *', async () => {
  try {
    await migrate();
    // Once a day, however many times Netlify starts it: nobody gets two copies
    if (!(await require('../../src/db').q.claimRun('office-summary'))) { console.log('[office-summary] already ran today'); return { statusCode: 200 }; }
    const results = await runOfficeSummary({ dryRun: false });
    console.log('[office-summary]', JSON.stringify(results));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[office-summary] failed:', e.message);
    return { statusCode: 500 };
  }
});

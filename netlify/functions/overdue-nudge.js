'use strict';
/** Scheduled: Wednesdays 12:00 UTC. Chases anything badly overdue. */
const { schedule } = require('@netlify/functions');
const { runOverdueNudge } = require('../../src/reminders');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('0 12 * * 3', async () => {
  try {
    await migrate();
    // Once a day, however many times Netlify starts it: nobody gets two copies
    if (!(await require('../../src/db').q.claimRun('overdue-nudge'))) { console.log('[overdue-nudge] already ran today'); return { statusCode: 200 }; }
    const results = await runOverdueNudge({ dryRun: false });
    console.log('[overdue-nudge]', JSON.stringify(results));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[overdue-nudge] failed:', e.message);
    return { statusCode: 500 };
  }
});

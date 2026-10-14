'use strict';
/** Scheduled: Wednesdays 12:00 UTC. Chases anything badly overdue. */
const { schedule } = require('@netlify/functions');
const { runOverdueNudge } = require('../../src/reminders');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('0 12 * * 3', async () => {
  try {
    await migrate();
    const results = await runOverdueNudge({ dryRun: false });
    console.log('[overdue-nudge]', JSON.stringify(results));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[overdue-nudge] failed:', e.message);
    return { statusCode: 500 };
  }
});

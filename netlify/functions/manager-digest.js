'use strict';
/** Scheduled: Mondays 12:00 UTC. Tells whoever manages the reps how each one is doing. */
const { schedule } = require('@netlify/functions');
const { runManagerDigest } = require('../../src/manager');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('0 12 * * 1', async () => {
  try {
    await migrate();
    // Once a day, however many times Netlify starts it: nobody gets two copies
    if (!(await require('../../src/db').q.claimRun('manager-digest'))) { console.log('[manager-digest] already ran today'); return { statusCode: 200 }; }
    const results = await runManagerDigest({ dryRun: false });
    console.log('[manager-digest]', JSON.stringify(results));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[manager-digest] failed:', e.message);
    return { statusCode: 500 };
  }
});

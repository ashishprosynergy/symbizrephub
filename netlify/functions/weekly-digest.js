'use strict';
/** Scheduled: Mondays 11:00 UTC. Sends each rep their list of calls due. */
const { schedule } = require('@netlify/functions');
const { runWeeklyDigest } = require('../../src/reminders');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('0 11 * * 1', async () => {
  try {
    await migrate();
    // Once a day, however many times Netlify starts it: nobody gets two copies
    if (!(await require('../../src/db').q.claimRun('weekly-digest'))) { console.log('[weekly-digest] already ran today'); return { statusCode: 200 }; }
    const results = await runWeeklyDigest({ dryRun: false });
    console.log('[weekly-digest]', JSON.stringify(results));
    // Reps who don't use the app get the whole week in one email (Settings → Weekly email for reps)
    const snaps = await require('../../src/routes').runRepSnapshots().catch(e => [{ error: e.message }]);
    if (snaps.length) console.log('[weekly-digest] rep emails', JSON.stringify(snaps));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[weekly-digest] failed:', e.message);
    return { statusCode: 500 };
  }
});

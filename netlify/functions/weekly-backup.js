'use strict';
/**
 * Scheduled: Sundays, 23:00 UTC (7 pm US Eastern in summer, 6 pm in winter).
 *
 * Emails the owner (and anyone added in Settings → Backup) a copy of
 * everything typed into Rep Hub that is not kept in Zoho: hours, expenses,
 * approval requests, summit checklists and notes. A second copy, every week.
 */
const { schedule } = require('@netlify/functions');
const { migrate } = require('../../src/db');
const routes = require('../../src/routes');

module.exports.handler = schedule('0 23 * * 0', async () => {
  try {
    await migrate();
    const out = await routes.sendBackup();
    console.log('[weekly-backup]', JSON.stringify(out));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[weekly-backup] failed:', e.message);
    return { statusCode: 500 };
  }
});

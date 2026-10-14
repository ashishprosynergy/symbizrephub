'use strict';
/**
 * Scheduled: every 15 minutes. Safety net for the offline queue.
 *
 * The API flushes inline on push, so this only picks up items that failed
 * then — Zoho was down, a token hiccup, a network blip. Without it, a rep's
 * logged call could sit unsynced indefinitely.
 */
const { schedule } = require('@netlify/functions');
const { flushQueue } = require('../../src/sync');
const { migrate } = require('../../src/db');

module.exports.handler = schedule('*/15 * * * *', async () => {
  try {
    await migrate();
    const out = await flushQueue({ limit: 300 });
    if (out.processed) console.log('[sync-flush]', JSON.stringify(out));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[sync-flush] failed:', e.message);
    return { statusCode: 500 };
  }
});

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
const books = require('../../src/lib/books');

module.exports.handler = schedule('*/15 * * * *', async () => {
  try {
    await migrate();
    const out = await flushQueue({ limit: 300 });
    if (out.processed) console.log('[sync-flush]', JSON.stringify(out));
    // Zoho Books bills the accounting send did not get to in time
    if (books.configured()) {
      const b = await books.makeBills({ budgetMs: 20000 }).catch(e => ({ error: e.message }));
      if (b.made || b.failed || b.error) console.log('[sync-flush] books', JSON.stringify(b));
    }
    return { statusCode: 200 };
  } catch (e) {
    console.error('[sync-flush] failed:', e.message);
    return { statusCode: 500 };
  }
});

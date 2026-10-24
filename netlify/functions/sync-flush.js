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
    // The live copy of Zoho: records changed since, and keeping Zoho's notifications switched on
    const mirror = require('../../src/mirror');
    const m = await mirror.processQueue({ budgetMs: 7000 }).catch(e => ({ error: e.message }));
    if (m.saved || m.deleted || m.failed || m.error) console.log('[sync-flush] live copy', JSON.stringify(m));
    if (process.env.URL) await mirror.ensureWatch(process.env.URL).catch(e => console.error('[sync-flush] live updates:', e.message));
    // Zoho Books bills the accounting send did not get to in time
    if (await books.configured()) {
      const b = await books.makeBills({ budgetMs: 12000 }).catch(e => ({ error: e.message }));
      if (b.made || b.failed || b.error) console.log('[sync-flush] books', JSON.stringify(b));
    }
    return { statusCode: 200 };
  } catch (e) {
    console.error('[sync-flush] failed:', e.message);
    return { statusCode: 500 };
  }
});

'use strict';
/**
 * Scheduled: every 15 minutes. When the office has switched "Copy to Zoho" on
 * (Access & security), sends Zoho whatever changed in Rep Hub since the last
 * run: hours, expenses and receipts, hand-offs, candidates and notes.
 * Off by default; when off it does nothing at all.
 */
const { schedule } = require('@netlify/functions');
const { migrate, setting } = require('../../src/db');
const zstore = require('../../src/zohostore');

module.exports.handler = schedule('*/15 * * * *', async () => {
  try {
    await migrate();
    if ((await setting('zohoStore', 'off')) !== 'copy') return { statusCode: 200 };
    const out = await zstore.copy({ budgetMs: 20000 });
    if (out.copied || out.failed || out.removed || out.attached) console.log('[zoho-copy]', JSON.stringify({ ...out, errors: (out.errors || []).slice(0, 5) }));
    return { statusCode: 200 };
  } catch (e) {
    console.error('[zoho-copy] failed:', e.message);
    return { statusCode: 500 };
  }
});

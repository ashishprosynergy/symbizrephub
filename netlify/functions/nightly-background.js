'use strict';
/**
 * Background (up to 15 minutes): the nightly copy of Zoho into Rep Hub's own
 * database, then the backup email when it is due (Sundays, or every day if
 * chosen in Settings → Backup). ?send=1 sends the backup whatever the day —
 * the "Email a copy now" button.
 */
const crypto = require('crypto');
const cfg = require('../../src/config');
const { migrate } = require('../../src/db');
const routes = require('../../src/routes');

exports.handler = async (event) => {
  const want = crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
  const got = String((event.headers || {})['x-rephub-key'] || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { statusCode: 403 };
  try {
    await migrate();
    const qs = event.queryStringParameters || {};
    const out = await routes.nightly({ sendNow: qs.send === '1', driveNow: qs.drive === '1', budgetMs: 10 * 60 * 1000 });
    console.log('[nightly-background]', JSON.stringify({ ...out, mirror: out.mirror && out.mirror.results ? out.mirror.results.map(r => [r.module, r.records, r.error].filter(x => x != null).join(':')) : out.mirror }));
  } catch (e) {
    console.error('[nightly-background] failed:', e.message);
  }
  return { statusCode: 200 };
};

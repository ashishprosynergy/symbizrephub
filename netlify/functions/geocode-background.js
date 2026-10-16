'use strict';
/**
 * Background: puts member addresses on the map (see src/lib/geocode.js).
 * Started by the member map when some addresses are not placed yet; runs up
 * to ~14 minutes, then the next visit to the map carries on.
 */
const crypto = require('crypto');
const cfg = require('../../src/config');
const { migrate } = require('../../src/db');
const zoho = require('../../src/lib/zoho');
const geo = require('../../src/lib/geocode');
const { queries, fromZoho } = require('../../src/domain');

exports.handler = async (event) => {
  const want = crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
  const got = String((event.headers || {})['x-rephub-key'] || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { statusCode: 403 };
  try {
    await migrate();
    const members = (await zoho.coql(queries.allActiveMembers())).map(fromZoho.member)
      .filter(m => /^active$/i.test(m.status)).map(m => ({ ...m, state: m.region }));
    const out = await geo.geocodeMissing(members, { budgetMs: 13 * 60 * 1000 });
    console.log('[geocode-background]', JSON.stringify(out));
  } catch (e) {
    console.error('[geocode-background] failed:', e.message);
  }
  return { statusCode: 200 };
};

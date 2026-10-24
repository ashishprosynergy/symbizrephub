'use strict';
/**
 * Scheduled: every night, 07:00 UTC (3 am US Eastern in summer, 2 am in winter).
 *
 * Starts the background job that copies Zoho into Rep Hub's own database and
 * then emails the backup when it is due (Sundays, or daily if chosen in
 * Settings → Backup). A scheduled function only gets 30 seconds; the copy
 * needs longer, so it runs as a background function.
 */
const crypto = require('crypto');
const { schedule } = require('@netlify/functions');
const cfg = require('../../src/config');

module.exports.handler = schedule('0 7 * * *', async () => {
  try {
    const site = process.env.URL || cfg.appUrl;
    const key = crypto.createHmac('sha256', cfg.jwtSecret).update('books-background').digest('hex');
    const res = await fetch(`${site}/.netlify/functions/nightly-background`, { method: 'POST', headers: { 'x-rephub-key': key } });
    console.log('[weekly-backup] started the nightly job:', res.status);
    return { statusCode: 200 };
  } catch (e) {
    console.error('[weekly-backup] could not start the nightly job:', e.message);
    return { statusCode: 500 };
  }
});

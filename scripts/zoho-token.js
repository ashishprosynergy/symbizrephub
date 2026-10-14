#!/usr/bin/env node
'use strict';
/**
 * One-time Zoho setup.
 *
 * 1. Go to https://api-console.zoho.com  ->  Self Client  ->  Create
 * 2. Copy the Client ID and Client Secret into .env
 * 3. In the console's "Generate Code" tab, paste this scope string:
 *
 *      ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.org.READ,ZohoCRM.coql.READ
 *
 *    Set duration 10 minutes, enter the org domain, click Create.
 * 4. Run:  node scripts/zoho-token.js <the-grant-code>
 * 5. Put the printed refresh_token into .env as ZOHO_REFRESH_TOKEN
 *
 * The refresh token does not expire. This runs once, ever.
 */
require('dotenv').config();

const code = process.argv[2];
if (!code) {
  console.error('Usage: node scripts/zoho-token.js <grant-code>');
  process.exit(1);
}
const accounts = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com';

(async () => {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    code,
  });
  const res = await fetch(`${accounts}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = await res.json();
  if (!body.refresh_token) {
    console.error('\nNo refresh token returned. Response:\n', body);
    console.error('\nUsual causes: the grant code expired (they last minutes), was already used, or the data-centre domain is wrong.');
    process.exit(1);
  }
  console.log('\nSuccess. Add these to your .env:\n');
  console.log('ZOHO_REFRESH_TOKEN=' + body.refresh_token);
  console.log('ZOHO_API_DOMAIN=' + (body.api_domain || 'https://www.zohoapis.com') + '\n');
})();

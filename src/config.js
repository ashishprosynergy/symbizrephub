'use strict';
require('dotenv').config();

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  jwtSecret: req('JWT_SECRET', process.env.NODE_ENV === 'test' ? 'test-secret' : undefined),
  jwtExpiry: process.env.JWT_EXPIRY || '30d',   // long: reps shouldn't be re-logging in constantly

  dbPath: process.env.DB_PATH || './data/rephub.db',

  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID || 'test-id',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || 'test-secret',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || 'test-refresh',
    // Data centre matters: .com (US), .eu, .in, .com.au, .jp
    apiDomain: process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
    accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com',
    maxConcurrent: parseInt(process.env.ZOHO_MAX_CONCURRENT || '8', 10),
    maxRetries: parseInt(process.env.ZOHO_MAX_RETRIES || '4', 10),
  },

  /**
   * Zoho Books, for turning approved expenses into bills. Switched on by
   * setting ZOHO_BOOKS_ORG_ID. It can share the CRM's Zoho client; give it
   * its own refresh token (with ZohoBooks scopes) so the CRM one is untouched.
   */
  books: {
    orgId: process.env.ZOHO_BOOKS_ORG_ID || '',
    clientId: process.env.ZOHO_BOOKS_CLIENT_ID || process.env.ZOHO_CLIENT_ID || 'test-id',
    clientSecret: process.env.ZOHO_BOOKS_CLIENT_SECRET || process.env.ZOHO_CLIENT_SECRET || 'test-secret',
    refreshToken: process.env.ZOHO_BOOKS_REFRESH_TOKEN || process.env.ZOHO_REFRESH_TOKEN || 'test-refresh',
    apiBase: process.env.ZOHO_BOOKS_API_DOMAIN
      || `${process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'}/books/v3`,
    accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com',
  },

  /**
   * Zoho module API names. These MUST match what exists in the org.
   * If Symbiz is not on an edition that allows custom modules, point
   * RING and ACTIVITY at standard modules instead and the rest of the
   * code is unchanged.
   */
  /**
   * Module API names, READ FROM Symbiz's live org on 13 Oct 2026.
   * These already exist — do not create new ones.
   */
  modules: {
    RING:     process.env.MOD_RING     || 'Growth_Ring_Groups',
    ACTIVITY: process.env.MOD_ACTIVITY || 'Rep_Visit_Trackings',
    MEETING:  process.env.MOD_MEETING  || 'Growth_Ring_Meetings_N',
    EVENT:    process.env.MOD_EVENT    || 'Symbiz_Events',
    REGISTRATION: process.env.MOD_REGISTRATION || 'Event_Registrations',
    REGION:   process.env.MOD_REGION   || 'Regions',
    // The join table between Contacts and Growth_Ring_Groups. Membership can
    // only be queried through this — the lookup on Contacts is not filterable.
    GROUP_MEMBER: process.env.MOD_GROUP_MEMBER || 'Group_Members',
    CONTACT:  'Contacts',
  },

  /**
   * Read-only mode. Reps see live Zoho data; the app writes nothing.
   * Leave this ON until the four fields are added to Rep_Visit_Trackings,
   * so the app can go live safely before that work is done.
   */
  readOnly: String(process.env.READ_ONLY || 'true') === 'true',

  mail: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Symbiz Rep Hub <noreply@symbiz.org>',
    enabled: String(process.env.MAIL_ENABLED || 'false') === 'true',
  },

  sms: {
    enabled: String(process.env.SMS_ENABLED || 'false') === 'true',
    sid: process.env.TWILIO_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },

  reminders: {
    // cron: minute hour day-of-month month day-of-week
    weeklyDigest: process.env.CRON_WEEKLY || '0 7 * * 1',   // Mondays 07:00
    overdueNudge: process.env.CRON_NUDGE || '0 8 * * 3',    // Wednesdays 08:00
    officeDigest: process.env.CRON_OFFICE || '0 7 1 * *',   // 1st of month
    timezone: process.env.TZ_NAME || 'America/New_York',
    dueWindowDays: parseInt(process.env.DUE_WINDOW || '21', 10),
    nudgeAfterDays: parseInt(process.env.NUDGE_AFTER || '14', 10),
  },

  appUrl: process.env.APP_URL || 'http://localhost:3000',
};

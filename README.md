# Rep Hub — Netlify deployment

Complete deployable package for the Symbiz Network rep portal: static
front-end, serverless API, and scheduled reminder jobs. Zoho CRM stays the
system of record, and reps sign in here rather than consuming Zoho seats.

```
public/index.html          the app reps and the office use
netlify/functions/api.js   the whole REST API (one function)
netlify/functions/*.js     four scheduled jobs (digests, nudges, sync retry)
src/                       shared logic: Zoho client, domain rules, auth, sync
```

## Deploy in about 20 minutes

### 1. Database

Netlify has no persistent disk, so the database is external. Create a free
Postgres at [neon.tech](https://neon.tech) and copy the connection string.

### 2. Push to Git and connect to Netlify

```bash
git init && git add . && git commit -m "Rep Hub"
git remote add origin <your-repo>
git push -u origin main
```

In Netlify: **Add new site → Import an existing project**, pick the repo.
Build settings are read from `netlify.toml` — leave them as they are.

### 3. Environment variables

Netlify dashboard → **Site settings → Environment variables**. Add everything
from `.env.example`. The three that must be right:

| Variable | Note |
|---|---|
| `DATABASE_URL` | From Neon. Keep `?sslmode=require` |
| `JWT_SECRET` | Long random string. Changing it signs everyone out |
| `ZOHO_REFRESH_TOKEN` | From step 4 |

### 4. Connect Zoho (once, ever)

1. <https://api-console.zoho.com> → **Self Client** → Create
2. Put the Client ID and Secret in Netlify's env vars
3. On the "Generate Code" tab, use these scopes:
   `ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.org.READ,ZohoCRM.coql.READ`
4. Locally: `node scripts/zoho-token.js <grant-code>`
5. Put the printed `ZOHO_REFRESH_TOKEN` into Netlify

Grant codes expire in minutes and work once. If step 4 fails, generate a fresh one.

**The data centre must match the org.** An `.in`, `.eu` or `.com.au` Zoho
account needs the matching `ZOHO_API_DOMAIN` and `ZOHO_ACCOUNTS_DOMAIN`, or
every call returns 401.

### 5. Create the logins

```bash
DATABASE_URL="postgres://..." node scripts/seed-users.js
```

Prints a temporary password per person. Have everyone change theirs on first sign-in.

### 6. Check it

```
https://your-site.netlify.app/api/healthz
```

Should return `"ok": true` and the Zoho org name. If `zoho` shows an error,
it's almost always the data centre or a stale refresh token.

## Local development

```bash
npm install
npm install -g netlify-cli
cp .env.example .env      # fill it in
netlify dev               # http://localhost:8888
```

## Tests

```bash
npm test
```

28 tests, no database or Zoho account needed — an in-memory Postgres and a
fake Zoho both run locally. They cover the schema, auth, sync idempotency,
the serverless handler end to end, and the `netlify.toml` routing rules.

## How this differs from a normal server

Worth knowing before changing anything:

- **No background work after a response.** Serverless containers freeze the
  moment they reply, so `setImmediate` silently never runs. The sync flush
  happens inline before responding; the scheduled `sync-flush` function is the
  safety net.
- **Cron is Netlify's, not `node-cron`.** Schedules live in `netlify.toml`
  **and** in each function's `schedule()` call — change both together.
- **Schedules are UTC.** `0 11 * * 1` is 07:00 Eastern during EDT, 06:00 during
  EST. If the Monday email should always land at 07:00 local, shift it twice a year.
- **Cold starts happen.** The first request after idle takes a second or two.
  `migrate()` is guarded so it only issues DDL once per container.
- **Keep the pool small.** `PG_MAX=3`. Many containers times a big pool will
  exhaust the database's connection limit.

## Zoho schema

Modules: `Growth_Rings`, `Rep_Activities`, `Ring_Meetings`, plus custom fields
on `Contacts`. Field names live in `src/domain.js` (`toZoho` / `fromZoho`) and
module names in `src/config.js`. **Those two files are the only place to edit**
if the org's schema differs.

> If the Zoho edition doesn't allow custom modules, repoint the `MOD_*` env
> vars at standard modules carrying custom fields. No other code changes.

## Cost

| | |
|---|---|
| Netlify Free | 125k function calls + 100GB bandwidth/month |
| Neon Free | 0.5GB storage |
| **Total** | **$0/month** at this scale |

A network this size won't approach those limits. Netlify Pro (~$19/month)
only becomes relevant for higher build minutes or team seats.

## Before go-live

- [ ] `/api/healthz` returns ok with the real Zoho org
- [ ] Everyone has changed their temporary password
- [ ] A test call logged in the app appears in Zoho
- [ ] `POST /api/reminders/run` with `{"kind":"weekly"}` previews correctly (defaults to dry run)
- [ ] Airplane mode: log a call, reconnect, confirm it syncs
- [ ] Neon backups enabled

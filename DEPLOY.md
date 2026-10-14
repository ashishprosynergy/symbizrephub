# Deploying Rep Hub

Two ways to run this, and you almost certainly want the first one now and the
second one later.

| | **Local mode** | **Connected mode** |
|---|---|---|
| Data from | A CSV exported from Zoho | Live Zoho CRM |
| Needs a database | No | Yes |
| Needs Zoho connected | No | Yes |
| Reps share data | No — per device | Yes |
| Reminder emails | No | Yes |
| Ready | **Now** | After the Zoho questions are answered |

Local mode is a real, usable deployment — not a demo. Symbiz can export their
members, load them, and use the calendar, visit schedule, forms, hours and
expenses this week. What it can't do is share data between people.

---

## Deploy (15 minutes, local mode)

Local mode only needs the static site. The API can sit there unconfigured.

```bash
git init && git add . && git commit -m "Rep Hub"
git remote add origin <your repo>
git push -u origin main
```

In Netlify: **Add new site → Import an existing project**, choose the repo,
and deploy. `netlify.toml` supplies the build settings.

Then open the site, choose **Work on this device**, and import a CSV.

> Set `JWT_SECRET` to any long random string even in local mode, or the
> function errors on boot. Nothing else is required yet.

---

## Turning on connected mode

### 1. Database

Create a free Postgres at [neon.tech](https://neon.tech) and copy the
connection string into Netlify as `DATABASE_URL` (keep `?sslmode=require`).

### 2. Zoho

1. <https://api-console.zoho.com> → **Self Client** → Create
2. Client ID and Secret into Netlify's environment variables
3. "Generate Code" tab, scopes:
   `ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.org.READ,ZohoCRM.coql.READ`
4. Locally: `node scripts/zoho-token.js <grant-code>`
5. Paste the printed `ZOHO_REFRESH_TOKEN` into Netlify

Grant codes last minutes and work once. If step 4 fails, generate a fresh one.

**The data centre must match the org** — an `.in`, `.eu` or `.com.au` account
needs the matching `ZOHO_API_DOMAIN` and `ZOHO_ACCOUNTS_DOMAIN`, or every call
returns 401.

### 3. Logins

```bash
DATABASE_URL="postgres://..." node scripts/seed-users.js
```

Prints a temporary password each. Everyone changes theirs on first sign-in.

### 4. Check

```
https://your-site.netlify.app/api/healthz
```

Should return `"ok": true` and the real Zoho org name.

---

## Environment variables

Everything is in `.env.example`. The three that matter most:

| Variable | Needed for | Note |
|---|---|---|
| `JWT_SECRET` | Both modes | Any long random string |
| `DATABASE_URL` | Connected | From Neon |
| `ZOHO_REFRESH_TOKEN` | Connected | From step 2 |

---

## Before the pilot

- [ ] `/api/healthz` returns ok with the real Zoho org
- [ ] Everyone has changed their temporary password
- [ ] A call logged in the app appears in Zoho
- [ ] Airplane mode: log a call, reconnect, confirm it syncs
- [ ] Neon backups enabled
- [ ] **Rep-to-member assignment exists in Zoho** — see below

### The one blocker worth repeating

In the October export, only 11 of 423 members (3%) had any rep assigned.
`Region Rep` was filled on 6 records, `Region` on 11, and `Member Owner` was
"admin Admin" on 406.

The app is organised around *my members, my rings, my calls due*. Without that
link every rep signs in and sees almost nothing. It is a data gap, not a code
one, and no amount of deployment fixes it.

`Mailing State / Province` is filled on all 423 records (PA 117, OH 90, IN 66,
IL 39 …), so assigning reps by state is a workable interim step.

---

## Tests

```bash
npm test
```

28 server tests, needing neither a database nor Zoho — an in-memory Postgres
and a fake Zoho both run locally.

The front-end also checks itself: sign in, go to **System check**, press the
button, and 43 assertions run live in the browser.

---

## Notes for whoever maintains this

- **No background work after a response.** Serverless containers freeze once
  they reply, so `setImmediate` silently never runs. The sync flush happens
  inline; the scheduled `sync-flush` function is the safety net.
- **Cron lives in `netlify.toml` and in each function's `schedule()` call.**
  Change both together.
- **Schedules are UTC.** `0 11 * * 1` is 07:00 Eastern during EDT, 06:00 in EST.
- **Keep the pool small** (`PG_MAX=3`). Many containers times a large pool
  exhausts the database's connection limit.
- **Zoho module and field names** live in `src/config.js` and `src/domain.js`.
  Those two files are the only place to edit if the org's schema differs.

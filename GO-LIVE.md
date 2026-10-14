# Go live — what you do, in order

All the coding is finished. These are the steps that need your hands or
Symbiz's. Nothing here needs a developer.

Read-only is **ON** by default, so nothing can be written to their CRM
until you deliberately switch it off at step 7.

---

## 1. Database — 5 minutes

1. Sign up at [neon.tech](https://neon.tech), free tier
2. Create a project
3. Copy the connection string (starts `postgres://`, keep `?sslmode=require`)

## 2. Put the code on GitHub — 5 minutes

```bash
cd rephub-deploy
git init && git add . && git commit -m "Rep Hub"
git remote add origin https://github.com/you/rephub.git
git push -u origin main
```

Keep the repository **private**.

## 3. Connect Netlify — 5 minutes

**Add new site → Import an existing project** → choose the repo → Deploy.
Build settings come from `netlify.toml`; change nothing.

> Drag-and-drop cannot work from here on. Sign-in and Zoho both need the
> server, and the drop zone only serves files.

## 4. Environment variables — 10 minutes

**Site settings → Environment variables.**

| Key | Value |
|---|---|
| `DATABASE_URL` | from Neon |
| `JWT_SECRET` | any 30+ random characters |
| `ZOHO_CLIENT_ID` | step 5 |
| `ZOHO_CLIENT_SECRET` | step 5 |
| `ZOHO_REFRESH_TOKEN` | step 5 |
| `READ_ONLY` | `true` — leave it until step 7 |

Symbiz is on `.com`, so the default Zoho domains are already correct.

## 5. Zoho connection — 15 minutes, needs their admin

1. <https://api-console.zoho.com> → **Self Client** → Create
2. Client ID and Secret into Netlify
3. "Generate Code" tab, scopes:
   `ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.org.READ,ZohoCRM.coql.READ`
   Duration 10 minutes → Create
4. On your machine: `node scripts/zoho-token.js <grant-code>`
5. Paste the printed `ZOHO_REFRESH_TOKEN` into Netlify

Grant codes last minutes and work once. If it fails, generate a fresh one.

Then **Deploys → Trigger deploy**. Variables only apply on a new build.

## 6. Accounts — 20 minutes

Open the site. It will say *"Nobody has an account yet"* — create the first
one (that becomes the director).

Then **Reps → Add someone** for each person. For a rep you MUST paste their
**Zoho Contact ID**, or they sign in and see nothing:

| Rep | Rings | Zoho Contact ID |
|---|---|---|
| Dale Savage #0842 | 22 | `7246333000002167428` |
| Glenden Martin #0627 | 12 | `7246333000001736581` |
| J. Michael Beiler #0744 | 8 | `7246333000002167490` |
| Larry N. Weaver #0803 | 8 | `7246333000001736945` |
| Richard Otto #0699 | 6 | `7246333000001735556` |
| Daniel Bender #0014 | 6 | `7246333000001736135` |
| Nate Nisley #0689 | 5 | `7246333000001735548` |
| David Mullet #1405 | 5 | `7246333000002167448` |
| Lee Good #0672 | 4 | `7246333000001736202` |
| Timothy Yoder #0851 | 3 | `7246333000001736981` |
| Daniel Miller #1458 | 2 | `7246333000002167436` |

Each account shows its temporary password **once**. The Reps screen flags
anyone still unlinked.

Office accounts (Keturah, Mel) need no Contact ID — they see everything.

### Check it
- `/api/healthz` returns ok and the Symbiz org name
- Sign in as a rep — their real rings appear
- Dale Savage should see 22, David Mullet 5

**You can stop here and let reps use it.** Everything is readable; nothing
can be written wrongly.

---

## 7. Switch on logging — when you're ready

### a. Four fields on `Rep_Visit_Trackings`

**Setup → Modules and Fields → Rep Visit Tracking → Edit layout.**

| Field label | Type | API name |
|---|---|---|
| Rep | Lookup → Contacts | `Rep` |
| Member | Lookup → Contacts | `Member` |
| Outcome | Picklist: `Connected`, `No answer`, `Left voicemail`, `Rescheduled` | `Outcome` |
| Next Due Date | Date | `Next_Due_Date` |

Set the API name under each field's **Edit Properties**. Picklist values are
case-sensitive.

Everything else the app writes — Visit Date, Visit Type, Visit Notes, Growth
Ring Group — already exists.

### b. Flip the switch

Set `READ_ONLY` to `false` in Netlify and redeploy.

### c. Prove it on one record
- Log a call as one rep
- Confirm it appears in Zoho under Rep Visit Trackings
- Confirm `Next_Due_Date` was filled in
- Log one as "No answer" and confirm it returns in 4 days, not a year

---

## 7b. Event times need a once-over

The calendar is wired to `Symbiz_Events` and pulls everything flagged
**Show on Portal** — regional summits, info meetings, the 2027 Symbiz Summit —
along with registrant names, phones and emails.

One thing to check with Keturah before reps rely on it. Zoho returns event
datetimes with the connection's offset rather than the venue's, so the stored
times are ambiguous. The app normalises them to US Eastern, which makes the
**dates** line up with the event titles. Some **times** then look wrong — the
PA Regional Summit titled 10/21 reads 9:00 AM, where an evening meal venue
suggests 6:30 PM.

So: dates are reliable, times may be off on some records. Worth Keturah
spot-checking a handful against what was advertised. If they are consistently
shifted, the fix is one line in `zonedParts()` in `src/domain.js`.

## 7c. Hours and expenses — where they live

Mel asked for hours and expenses routed to accounting. These are stored in
**our own Postgres**, not Zoho: Symbiz's accounting is QuickBooks (the `QB_*`
modules in their CRM are a read-only mirror) and no Zoho module fits.

That means they work even while `READ_ONLY` is on, because they never touch
their CRM. Receipts — photo or PDF — are stored with the claim and fetched
only when someone opens one.

The office reviews on **Hours & expenses**, approves, then **Send now** emails
a summary and CSV to the address in Settings, marking those items Reimbursed
so nothing is claimed twice.

Set the accounting address in **Settings → Accounting** before the first send.

## 8. For Keturah, in parallel

These fields exist on all 81 rings and are **empty**. The app shows them
blank until filled:

- `Meeting_Frequency` — Weekly / Monthly / Bi Monthly / Quarterly / Yearly
- `Meeting_Format` — Virtual / In Person / Hybrid
- `Next_Meeting_Date_Time`
- `Target_Group_Size`
- `Last_Rep_Visit`
- `Status`

The **"Rings missing meeting or visit detail"** report is exactly this
worklist. Nothing is blocked by it — it just means blank meeting times.

Also: the four forms and the two Drive links go in **Settings → Forms,
folders and documents**, and appear for every rep immediately.

---

## 9. Pilot

Start with **two or three reps**, not eleven. Timothy Yoder (3 rings) or
David Mullet (5) are small enough to check every record by hand.

Give it a fortnight before the rest.

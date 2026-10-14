# Connecting Rep Hub to Zoho CRM

Four parts, in order. Part 1 decides whether the rest is even possible, so
start there.

> **Prerequisite:** sign-in must already be working (`SETUP-LOGINS.md`).
> Zoho talks to the server, so there has to be a server first. A
> drag-and-drop site can never connect to Zoho.

---

## Part 1 — Edition: confirmed

Symbiz is on **Zoho One**, which provides Zoho CRM at **Enterprise level**.
Checked October 2026. That means:

| | |
|---|---|
| Custom modules | **Available** — we need three |
| Custom fields | Hundreds per module; we need a handful |
| API credits | 50,000 per 24h, plus 1,000 per user licence |
| Concurrent calls | 20 per org |
| Record limit | Unlimited |

So nothing here is blocked by their plan. Skip to Part 2.

**What this means in practice.** The app's whole day uses a trivial share of
that allowance — a rep signing in costs about three API credits, and the
nightly reminder job a few dozen. Creating each custom module costs 500
credits one time, so the full setup below is roughly 1,500 credits against a
daily allowance of 50,000+. There is no capacity concern.

`ZOHO_MAX_CONCURRENT` ships at 8 against a ceiling of 20, which leaves
headroom for Symbiz's other Zoho One apps hitting the same org. Don't raise
it without reason.

> Zoho One licensing is per employee across the whole suite, which is exactly
> why a separate rep portal is worth building: reps get logins here without
> consuming Zoho One seats.

## What their data already looks like

From the October export of 423 members:

| Already in Zoho | Notes |
|---|---|
| **Members** (Contacts) | 423 records, names, phone, email, business, address |
| **Region** | A real module, linked from members — but filled on only 11 records |
| **Region Rep** | A lookup — filled on only 6 records |
| `Group(s)` | **Plain text**, e.g. `76`, `50 - Women's Virtual` |
| `Is Facilitator`, `Facilitator For` | Plain fields, 81 facilitators flagged |
| `Member Id.`, `Status`, `Online Member` | Plain fields |

**Growth Rings are not a module.** They exist only as text on each member,
which is why a ring can't currently hold a meeting day, a place, a capacity,
a facilitator or an assigned rep. Creating that module is the main piece of
work below.

---

## Part 2 — Create the modules

**Setup → Customization → Modules and Fields → Create New Module.**

Field names must match exactly. Zoho shows a *Field Label*; the **API name**
is what matters and is set under each field's **Edit Properties → API Name**.

### Module 1: `Growth_Rings`

| Field label | Type | API name |
|---|---|---|
| Name | Single Line | `Name` |
| Facilitator | Lookup → Contacts | `Facilitator` |
| Assigned Rep | Lookup → Users | `Assigned_Rep` |
| Facilitator Call Frequency | Picklist: `Quarterly`, `Semi-Annual` | `Facilitator_Call_Frequency` |
| Member Call Frequency | Picklist: `Annual`, `Semi-Annual` | `Member_Call_Frequency` |
| Meeting Rhythm | Picklist: `Monthly`, `Every 6 weeks`, `Quarterly` | `Meeting_Rhythm` |
| Group Size Limit | Number | `Group_Size_Limit` |
| Status | Picklist: `active`, `pending`, `rejected`, `paused` | `Status` |
| Rejection Reason | Multi Line | `Rejection_Reason` |
| Launch Steps Done | Single Line | `Launch_Steps_Done` |

Picklist values are **case-sensitive** — `active`, not `Active`.

### Module 2: `Rep_Activities`

Every call, meeting and exit interview.

| Field label | Type | API name |
|---|---|---|
| Name | Single Line | `Name` |
| Activity Type | Picklist: `Facilitator Call`, `Member Call`, `Launch Meeting`, `Exit Interview` | `Activity_Type` |
| Contact Name | Lookup → Contacts | `Contact_Name` |
| Facilitator | Lookup → Contacts | `Facilitator` |
| Growth Ring | Lookup → Growth_Rings | `Growth_Ring` |
| Rep | Lookup → Users | `Rep` |
| Date Completed | Date | `Date_Completed` |
| Next Due Date | Date | `Next_Due_Date` |
| Outcome | Picklist: `Connected`, `No answer`, `Left voicemail`, `Rescheduled` | `Outcome` |
| Notes | Multi Line | `Notes` |
| Exit Reason | Picklist (the seven reasons) | `Exit_Reason` |
| Would Return | Picklist: `Yes`, `Maybe`, `No` | `Would_Return` |
| Entered By | Single Line | `Entered_By` |

`Next_Due_Date` is what drives every reminder. Leave it writable by the API.

Exit Reason values: `Cost of membership`, `Time commitment`,
`Business closed or sold`, `Moved away`, `Group not a fit`,
`Relational conflict`, `Other`.

### Module 3: `Ring_Meetings`

| Field label | Type | API name |
|---|---|---|
| Name | Single Line | `Name` |
| Growth Ring | Lookup → Growth_Rings | `Growth_Ring` |
| Meeting Date | Date | `Meeting_Date` |
| Attended Count | Number | `Attended_Count` |
| Absent Count | Number | `Absent_Count` |
| Attendees | Multi Line | `Attendees` |
| Notes | Multi Line | `Notes` |

### Module 4: `Join_Requests` — not needed yet

Defined in the config but unused by the server today; join requests live in
the app only. Skip it for now. If Symbiz later wants the pipeline stored in
Zoho, create it then and the field mapping goes in `src/domain.js`.

### Fields to add to the existing **Contacts** module

Standard fields the app reads and which already exist — nothing to create:
`Last_Name`, `Email`, `Phone`, `Account_Name`.

New fields to add:

| Field label | Type | API name |
|---|---|---|
| Growth Ring | Lookup → Growth_Rings | `Growth_Ring` |
| Assigned Rep | Lookup → Users | `Assigned_Rep` |
| Member Since | Date | `Member_Since` |
| Renewal Date | Date | `Renewal_Date` |
| Member Status | Picklist: `active`, `discontinued`, `paused` | `Member_Status` |

> `Growth_Ring` here replaces the `Group(s)` text field. Keep the old field
> during migration, then populate the lookup from it.

---

## Part 3 — Connect

1. <https://api-console.zoho.com> → **Self Client** → Create
2. Copy the Client ID and Secret into Netlify's environment variables
3. "Generate Code" tab, paste these scopes:

   ```
   ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.org.READ,ZohoCRM.coql.READ
   ```

   Duration 10 minutes, enter the org domain, Create.
4. Locally: `node scripts/zoho-token.js <grant-code>`
5. Put the printed `ZOHO_REFRESH_TOKEN` into Netlify

Grant codes expire within minutes and work once. If step 4 fails, generate a
fresh one rather than reusing it.

### The data centre must match

| Zoho URL ends in | `ZOHO_API_DOMAIN` | `ZOHO_ACCOUNTS_DOMAIN` |
|---|---|---|
| `.com` | `https://www.zohoapis.com` | `https://accounts.zoho.com` |
| `.eu` | `https://www.zohoapis.eu` | `https://accounts.zoho.eu` |
| `.in` | `https://www.zohoapis.in` | `https://accounts.zoho.in` |
| `.com.au` | `https://www.zohoapis.com.au` | `https://accounts.zoho.com.au` |

A mismatch here makes every call return 401, and it's the most common cause
of "nothing works".

Redeploy afterwards — environment variables only apply on a new build.

---

## Part 4 — Verify

```
https://your-site.netlify.app/api/healthz
```

Expect `"ok": true` and the real company name. Then:

- [ ] `/api/setup/status` shows `zohoReady: true`
- [ ] Sign in and open Rings — Zoho records appear
- [ ] Log a test call, confirm it lands in `Rep_Activities` in Zoho
- [ ] Check `Next_Due_Date` was filled in on that record
- [ ] Create a ring in the app, confirm it arrives with `Status = pending`

Do all of this on a **sandbox or a handful of test records first**, never the
live 423 straight away.

---

## If a module name has to change

Not needed on Zoho One, but worth knowing: if Symbiz already has a module
that should be reused instead of creating a new one, point the environment
variable at it rather than editing code.

```
MOD_RING=Growth_Rings
MOD_ACTIVITY=Rep_Activities
MOD_MEETING=Ring_Meetings
```

Field API names live in `src/domain.js` (`toZoho` / `fromZoho`). Those two
files are the only place to change.

## The step nobody can skip

**Only 11 of 423 members (3%) have a rep against them.** `Region Rep` is
filled on 6, `Region` on 11, and `Member Owner` is "admin Admin" on 406.

Once connected, every rep signs in and sees almost nothing, because the app
shows *their* members and almost nobody is assigned.

`Mailing State / Province` is filled on all 423 (PA 117, OH 90, IN 66, IL 39,
MO 22, KS 19, NY 19, KY 16, ON 13 …), so the quickest route is:

1. Agree with Mel which rep covers which state or region
2. Bulk-update `Assigned_Rep` on Contacts in Zoho from that mapping
3. Then connect

Doing it in that order means reps see a working app the first time they open
it, which matters more than it sounds for whether they keep using it.

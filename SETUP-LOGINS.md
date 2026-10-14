# Switching on sign-in

Right now the app runs on one device at a time: **Work on this device**, import
a CSV, done. Nothing shared, no accounts.

To give people real logins — so reps and the office see the same data — you
need a database. About 20 minutes, and it costs nothing.

> **This will not work on a drag-and-drop site.** Netlify's drop zone serves
> files only; it never runs the server code that handles sign-in. Connect the
> repository through Git first.

---

## 1. Connect the site to Git

If the site came from the drop zone, redo it as a Git deploy:

```bash
cd rephub-deploy
git init && git add . && git commit -m "Rep Hub"
git remote add origin https://github.com/you/rephub.git
git push -u origin main
```

Netlify → **Add new site → Import an existing project** → pick the repo.
Leave the build settings alone; `netlify.toml` provides them.

## 2. Create the database

1. Sign up at [neon.tech](https://neon.tech) — the free tier is plenty
2. Create a project, any name
3. Copy the connection string (starts `postgres://`, ends `?sslmode=require`)

## 3. Add two settings in Netlify

**Site settings → Environment variables → Add a variable**

| Key | Value |
|---|---|
| `DATABASE_URL` | the string from Neon |
| `JWT_SECRET` | any long random text, 30+ characters |

`JWT_SECRET` is what keeps sign-in sessions valid. Changing it later signs
everyone out, so set it once and leave it.

## 4. Redeploy

**Deploys → Trigger deploy → Deploy site.** Environment variables only take
effect on a new build.

## 5. Create the first account — in the browser

Open the site. The login screen now says **"Nobody has an account yet"** with
a button to create the first one. Fill in name, email and a password of at
least 8 characters.

That account is the director: full access, and the only one that can add
others. It can only be created once — the endpoint refuses afterwards, so
nobody can use it to slip in a second admin later.

## 6. Add everyone else

Sign in, open **Reps**, press **Add someone**. Choose:

| Role | Sees |
|---|---|
| **Rep** | Only their own members, rings and calls |
| **Office** | Everyone, plus approvals and reports |
| **Director** | Everything, plus settings and accounts |

A password is generated and shown **once** — write it down and pass it on.
They change it after signing in.

---

## Zoho comes after

Steps 1 to 6 give you logins and shared data, with the app's own database
behind it. Zoho stays separate until you add the Zoho variables from
`.env.example` — see `DEPLOY.md`.

That order is deliberate: get people signing in and using it, then connect
Zoho once Symbiz has answered the edition question and filled in the
rep-to-member assignments.

---

## If something isn't right

The login screen tells you which step you're on:

| What it says | What to do |
|---|---|
| "Sign-in isn't switched on yet" | No server — the site is static. Redeploy through Git |
| "No database connected yet" | `DATABASE_URL` missing or wrong. Check it, then redeploy |
| "Nobody has an account yet" | Working. Press the button |
| "Email or password is incorrect" | The account exists; the details are wrong |

You can also open `/api/setup/status` on the site directly. It reports whether
the database is reachable, how many accounts exist, and whether Zoho is
connected.

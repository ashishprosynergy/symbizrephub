# Nightly backup to Google Drive: one-time setup

Rep Hub saves a full backup file (its own data plus the copy of Zoho CRM) to a
"Rep Hub backups" folder in a Symbiz Google Drive every night, and removes
files older than 90 days. It asks only for `drive.file`, so it can see the
files it made and nothing else in that Drive.

This needs a Google sign-in key for Rep Hub, made once in Google Cloud. Do it
signed in with the **Symbiz** Google Workspace account, so Symbiz owns it.

1. Open https://console.cloud.google.com and create a project, e.g. "Rep Hub".
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding/Audience):
   - App name: Rep Hub. Support email: a Symbiz address.
   - Audience / User type: **Internal** (only symbiz.org accounts; no Google review,
     and the connection does not expire after 7 days as it would for "External / Testing").
   - Data access / scopes: add `.../auth/drive.file` (and `openid`, `email`).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorised redirect URI: `https://symbizrep.netlify.app/api/google/callback`
5. Copy the **Client ID** and **Client secret** into Netlify:
   Site configuration → Environment variables:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   Then **Deploys → Trigger deploy**.
6. In Rep Hub: **Settings → Backup → Connect Google Drive**, and sign in with the
   Symbiz Google account that should hold the backups. The first file is saved
   straight away; open the folder from the same page to see it.

To restore: download a file from the folder; it is gzip-compressed JSON with
every Rep Hub table (`tables`) and every Zoho record with all its fields (`zoho`).

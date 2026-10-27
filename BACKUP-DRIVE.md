# Nightly backup to Google Drive, kept for years

Every night Rep Hub saves the full backup (its own data plus the copy of
Zoho CRM, every field) to a "Rep Hub backups" folder in a Symbiz Google Drive.

Kept for years without piling up: every file for 90 days, one a week for two
years, then one a month for good (about 220 files after five years). Settings
→ Backup can switch to "Keep every file".

## Recommended: Apps Script (free, no Google Cloud project, ~5 minutes)

Signed in to Google with the Symbiz account that should hold the backups:

1. In Rep Hub: **Access & security → Backup → Set it up (5 minutes)**. Press **Copy the script**.
2. Open https://script.google.com/home/projects/create (a new project).
3. Delete what is in the editor and paste the script. Press **Save**, name it
   **Rep Hub backups**.
4. **Deploy → New deployment** → gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy**.
5. **Authorize access** → choose the account → **Advanced → Go to Rep Hub
   backups (unsafe) → Allow**. The warning is normal for your own script.
6. Copy the **Web app URL** (ends in `/exec`), paste it into Rep Hub, press
   **Connect**. The first backup is saved straight away; **Open the folder**
   shows it.

The script holds a private key, so only Rep Hub can save files with it, and it
only touches its own "Rep Hub backups" folder.

If Google says "Who has access: Anyone" is not allowed, the Workspace admin has
limited it: Google Admin → Apps → Google Workspace → Drive and Docs → Sharing
settings, or use the Google sign-in option below.

## Alternative: Google sign-in (needs a Google Cloud project)

1. https://console.cloud.google.com/projectcreate → project "Rep Hub" (no billing
   is needed; dismiss any free-trial offer).
2. Enable the **Google Drive API**:
   https://console.cloud.google.com/apis/library/drive.googleapis.com
3. https://console.cloud.google.com/auth/overview → Audience **Internal**;
   scopes `drive.file`, `openid`, `email`.
4. https://console.cloud.google.com/auth/clients → Web application, redirect URI
   `https://symbizrep.netlify.app/api/google/callback`.
5. Netlify environment variables `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   then redeploy.
6. Rep Hub → Access & security → Backup → **Or sign in with Google**.

## Restoring

Download a file from the folder. It is gzip-compressed JSON: `tables` holds
every Rep Hub table, `zoho` every Zoho CRM record with all its fields.

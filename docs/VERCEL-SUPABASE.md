# Putting Champion Billing on Vercel + Supabase

This takes about 45 minutes, all in the browser, with no server and no terminal. It works the same way as your Kubota portal: you merge on GitHub and Vercel deploys.

## Before you start: plans

These hold invoices, so they need paid plans:

| Service | Plan | Why |
|---|---|---|
| **Supabase** | **Pro** (about $25/month per organization, which includes one small project; each extra project is about $10/month) | Free projects pause after a week without use and have no backups. |
| **Vercel** | **Pro** (about $20/month per member) | Vercel's free Hobby plan is for non-commercial use only. |

If the Kubota organizations are already on these plans, adding this app there costs only the extra Supabase project. Either way, **create a new Supabase project for Champion Billing**. Don't put it in the Kubota project: keeping it separate stops Champion's customer and invoice data from mixing with the portal.

## 1. Create the database (Supabase): about 10 minutes
1. In supabase.com, choose **New project**.
   - **Name:** `champion-billing`
   - **Database password:** click **Generate a password** (letters and numbers only, which avoids problems later). Save it in your password manager.
   - **Region:** **East US (North Virginia)**. This must match the Vercel region below, otherwise every page loads slowly.
2. When the project is ready, click **Connect** at the top of the project.
   - Under **Transaction pooler**, copy the connection string. It ends in `:6543/postgres`. Replace `[YOUR-PASSWORD]` with the password from step 1. This is your **DATABASE_URL**.
   - Under **Session pooler**, copy that string too (it ends in `:5432/postgres`) and fill in the password the same way. It's used only for backups (step 6).
3. Go to **Project Settings → Database → SSL Configuration** and click **Download certificate**. Open the file in Notepad. The whole text, from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`, is your **DATABASE_CA_CERT**.

You don't create any tables yourself. The app does that on its first deploy.

## 2. Make a setup code: about 1 minute
Have your password manager generate a random 24+ character password. This is your **SETUP_TOKEN**. It's used once, in step 4, to prove you are the person setting up the first admin account.

## 3. Deploy (Vercel): about 10 minutes
1. In vercel.com, choose **Add New… → Project**, then **Import** the **Champion-Billing** GitHub repository. If it isn't listed, use **Adjust GitHub App Permissions** to give Vercel access to that repository.
2. Leave the framework (**Next.js**) and build settings as they are. The repository's `vercel.json` sets them.
3. Open **Environment Variables** and add these three:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Transaction pooler string from step 1 |
   | `DATABASE_CA_CERT` | the certificate text from step 1 |
   | `SETUP_TOKEN` | the code from step 2 |

   If you connected Supabase to Vercel through Vercel's **Integrations** / **Storage** page, it already added `POSTGRES_URL`. The app uses that automatically when `DATABASE_URL` isn't set. `DATABASE_CA_CERT` is recommended but optional: without it the connection is still encrypted, it just doesn't check Supabase's certificate.

4. Click **Deploy**. The first build takes about 2 minutes. It creates the database tables and then builds the app.
5. After the import, go to **Project → Settings → Environment Variables** and make sure all three apply to **Production** only, not Preview or Development. That stops test builds of unmerged changes from ever touching the live database.

**Your own address (optional, 5 minutes).** Under **Project → Settings → Domains**, add `billing.championequipmentco.com`. Vercel shows a DNS record, usually a **CNAME** for `billing`. Add it wherever championequipmentco.com's DNS is managed, the same way the Kubota portal's domain was set up. HTTPS is automatic.

## 4. Create your login: about 2 minutes
Open the site. It goes straight to **first-time setup**:
- Enter the setup code, your name, email and a password of 12 or more characters.
- Leave **Also set up RPM xConstruction** ticked. This creates RPM's billing rules: calendar month, a new six-digit PO per machine every month, and work order, job, jobsite and agreement required.

The setup page closes for good once this account exists. You can then delete `SETUP_TOKEN` in Vercel if you like.

Add everyone else under **Settings → Users**:
- **Billing manager:** approves invoices
- **Billing clerk:** prepares invoices
- **Read-only**

## 5. Set it up for RPM (in the app)
1. **Settings:** enter Champion's legal name, address, remit-to, invoice prefix and next number, then untick "placeholder".
2. **Customers → RPM xConstruction:**
   - enter the billing address
   - confirm the tax rate and terms, then untick "placeholder"
   - record the proration policy that matches Quipli
3. **Rentals → Bulk load from spreadsheet:** upload the 26 RPM rentals. For rentals Quipli has billed through October, use **Bill From = 11/01/2026**.
4. On each rental, upload the signed original agreement. **The limit is 4 MB per file.** Vercel refuses anything bigger than 4.5 MB. If a scan is too large, save it again as a reduced-size PDF (in Adobe: *File → Save as Other → Reduced Size PDF*).
5. **PO imports:** upload RPM's November PO file, review it, then apply.
6. **RPM billing → Generate draft invoices**, then submit, approve, download the PDFs and send.

## 6. Backups: about 5 minutes
Supabase Pro keeps a daily backup for 7 days (**Database → Backups**). For a second copy that you control, the repository also includes a nightly backup job that runs on GitHub. It takes an encrypted copy of the database, proves the copy restores, and keeps it for 35 days.

To turn it on, go to GitHub → **Champion-Billing → Settings → Secrets and variables → Actions → New repository secret** and add:

| Name | Value |
|---|---|
| `BACKUP_DATABASE_URL` | the **Session pooler** string from step 1 |
| `BACKUP_PASSPHRASE` | a new long random password. **Save it in your password manager: without it the backups can't be opened.** |
| `DATABASE_CA_CERT` | the same certificate text as in Vercel |

Then open **Actions → Nightly database backup → Run workflow** to test it. A green check means a backup was made, restored into a scratch database, and every stored invoice PDF matched its fingerprint. The backup appears under that run's **Artifacts**. If you ever need one restored, ask Claude.

## How changes reach the live site
- Every merge to `main` deploys to production automatically.
- If a change includes a database update, it's applied during that deploy. **Merging the pull request is your approval.** Each pull request description says plainly when it changes the database.
- Finalized invoices and their PDFs are never changed by an update. The database refuses edits to them.
- Customer data is never reachable through Supabase's own public API. The app turns off that access on every table each time it deploys. Supabase's **Advisors** page should show no "RLS disabled" warnings for this project.

## If something goes wrong
- **The site shows an error page.** In Vercel, open **Project → Logs**. The usual causes are a mistyped `DATABASE_URL` or a password that wasn't filled in.
- **The build failed.** Open **Deployments**, click the failed one, and read the end of the build log. "No database connection string" means Vercel has no `DATABASE_URL` for **Production**: add it under **Settings → Environment Variables**, then **Redeploy**. "password authentication failed" means `DATABASE_URL` is wrong. "self-signed certificate" means `DATABASE_CA_CERT` is missing or incomplete.
- **Supabase project paused.** This only happens on the Free plan. Upgrade to Pro and restore it from the dashboard.
- **Go back to the previous version.** In Vercel, choose **Deployments → … → Promote to Production** on the last good deployment.

# Putting Champion Billing on a cloud server

About an hour, about **$15/month**. The example uses DigitalOcean; any Ubuntu 24.04 server works (Azure, AWS Lightsail, Linode). Steps marked **(you)** need someone with access to Champion's accounts. Everything else is copy and paste.

## 1. Create the server (you): about 10 minutes
1. Sign up at digitalocean.com and choose **Create → Droplets**.
2. Choose these options:
   - **Region:** New York or San Francisco
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **2 GB RAM / 1 CPU** (about $12/month)
3. Under **Backups**, enable **weekly backups** (about $2.40/month). This is a whole-server snapshot on top of the app's own nightly database backups.
4. Under **Authentication**, pick **SSH key** and add yours, or use a strong root password.
5. Create the droplet and note its **IP address**.

## 2. Point a web address at it (you): about 5 minutes
Wherever `championequipmentco.com` DNS is managed (GoDaddy, Microsoft 365, Cloudflare, etc.), add a record:

| Type | Name | Value |
|---|---|---|
| A | `billing` | the droplet's IP address |

The app will then live at **https://billing.championequipmentco.com**. The HTTPS certificate is issued automatically.

## 3. Let the server read the code: about 5 minutes
Sign in to the server (`ssh root@<IP>`, or use the droplet's **Console** button) and run:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
```

**(you)** Copy the printed line. In GitHub, go to **Champion-Billing → Settings → Deploy keys → Add deploy key**, paste it, and leave "Allow write access" **unchecked**.

## 4. Install and start: about 10 minutes, mostly waiting
On the server:

```bash
ssh-keyscan github.com >> ~/.ssh/known_hosts
git clone git@github.com:Micwalker13/Champion-Billing.git /opt/champion-billing
DOMAIN=billing.championequipmentco.com bash /opt/champion-billing/deploy/server-setup.sh
```

The setup script does the following:
- installs Docker and turns on automatic security updates
- opens only the SSH and web ports
- generates a random database password in `/opt/champion-billing/.env`
- starts the database, the app, HTTPS and nightly backups

## 5. Create the first login
```bash
cd /opt/champion-billing
docker compose exec app npm run create-user -- michael@championequipmentco.com "Michael" admin
```

Open https://billing.championequipmentco.com and sign in. Add everyone else under **Settings → Users** with one of these roles:
- **Billing manager:** approves invoices
- **Billing clerk:** prepares invoices
- **Read-only**

**Never run `npm run seed` on this server.** That loads demo data, and it refuses to run in production anyway.

## 6. Set it up for RPM (in the app)
1. **Settings:** enter Champion's legal name, address and remit-to, plus the invoice prefix and next number. Then untick "placeholder".
2. **Customers → add RPM xConstruction:**
   - Set the billing address.
   - Set the billing rules: calendar month, new PO every month, unique PO per machine, PO format `[456][0-9]{5}`, work order, job, jobsite and agreement required. Also set the tax rate and terms.
   - Record the proration policy that matches Quipli.
3. **Rentals → Bulk load from spreadsheet:** upload the 26 RPM rentals. Use **Bill From = 11/01/2026** for rentals Quipli already billed through October.
4. On each rental, upload the signed original agreement (PDF).
5. **PO imports:** upload RPM's November PO file, review it, then apply.
6. **RPM billing → Generate draft invoices**, then submit, approve, download the PDFs and send.

## Updating to a new version
```bash
cd /opt/champion-billing && git pull && docker compose up -d --build
```
Database changes apply automatically on start. Finalized invoices and their PDFs are never touched by an update.

## Backups
- Every night a database backup lands in `/opt/champion-billing/backups`, plus a checksum. Backups are kept for 35 days.
- The droplet's weekly backup also copies the whole server off-site.
- To prove a backup restores (do this once after go-live, then monthly):
  ```bash
  cd /opt/champion-billing
  docker compose exec -T backup sh /scripts/verify-backup.sh /backups/$(ls -t backups | grep '\.dump$' | head -1)
  ```

## If something goes wrong
- **See what's running:** `docker compose ps`
- **App logs:** `docker compose logs --tail 100 app`
- **Certificate or HTTPS problems:** `docker compose logs caddy`. Usually DNS isn't pointing at the server yet; wait 10 minutes and run `docker compose restart caddy`.
- **Restart everything:** `docker compose restart`

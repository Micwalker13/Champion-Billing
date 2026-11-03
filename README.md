# Champion Billing: rental billing & monthly PO management

A web application for Champion Equipment that keeps one continuous rental agreement open while every
monthly invoice carries its **own** customer PO number. It was built for RPM xConstruction, which issues a
new six-digit PO per machine every calendar month. It runs **alongside Quipli** and never connects to it,
writes to it, or changes anything in it.

## What it does

| Area | What you get |
|---|---|
| Rentals | Continuous rental agreements per unit (contract #, customer, unit, serial, job, work order, jobsite, rate, billing method, terms, delivery/pickup, fees, notes, original agreement upload). Status: Active → Off-rent → Returned → Closed. Invoicing never closes or restarts a rental. |
| Monthly POs | Unlimited POs per rental, one per billing period. Each assignment records who and when, and is permanent: corrections supersede it with a reason, and the database refuses deletes and rewrites. Customer-specific format rules (RPM: `[456]` followed by 5 digits), expiration and validity dates, uniqueness per machine and month. |
| Bulk import | CSV or Excel upload → preview → automatic matching by unit number → flags (unknown or duplicate unit, missing or invalid PO, duplicate PO, PO already used, missing or conflicting job/WO, returned unit, PO total vs calculated total, active rentals missing from the file) → correct rows → approve or skip each row → apply **all approved rows in one transaction**. The same file can never be applied twice. Import history is permanent. |
| Billing | Deterministic engine: calendar month (real month lengths, leap years), daily, weekly, 28-day and 30-day cycles, configurable per customer and per contract. Partial periods follow a proration policy that must be **explicitly approved**. Until then they are blocked. A "bill in this system from" date prevents double-billing days already invoiced in Quipli. |
| Invoices | Dedicated, prominent PO field. Snapshot of customer, equipment, contract, jobsite, job/WO, PO and money taken at generation and frozen at approval. Server-side PDF with the original agreement pages appended. Workflow: Draft → Pending review → Approved (finalized) → Issued → Partially paid / Paid / Overdue, plus Rejected, Voided and Corrected (revision). |
| Release checks | Rental exists, correct equipment, billing period accurate, PO present, valid format and in date, job/WO present and matching, amount recalculates, no overlap or duplicate, agreement attached, PO variance within tolerance, company/tax details confirmed. A failing check blocks approval unless a billing manager records an override with a reason. Integrity checks (duplicates, amount, period, equipment) can't be overridden. |
| Reconciliation | Customer PO estimate vs calculated subtotal, tax and total, with $ and % variance and a configurable tolerance. The estimate is never treated as a spending limit, and rates are never changed to match it. |
| Dashboards | All-customer dashboard (active rentals, current-month invoices and POs, missing POs, pending approvals, discrepancies, unbilled, overdue, billed this month, completion %). RPM board per month with per-machine status, filters (customer, unit, PO, month, status), bulk generate, submit and approve. Mobile friendly. |
| Security | Email/password login (bcrypt, httpOnly session cookie, 12-hour sessions, throttled failures). Roles: Administrator, Billing manager (approver), Billing clerk, Read-only. The submitter can't approve their own invoice. Append-only audit log. No public pages. |
| Exports | CSV exports of invoices, PO assignments, rentals and the audit log (formula-injection safe). |

## Historical invoice integrity (how it's enforced)

* At approval the invoice gets its number, dates, frozen snapshot and PDF. The PDF bytes are stored once with a SHA-256 hash, and every later download returns those exact bytes after the hash is checked.
* PostgreSQL triggers reject any change to a finalized invoice's PO, period, amounts, snapshot, lines, number or PDF, and any deletion of PO history, stored PDFs or the audit log.
* An exclusion constraint makes overlapping billing periods for the same rental impossible, and a partial unique index allows only one live invoice per period.
* Corrections go through **Create revision** (new draft numbered `<original>-R1`, original kept as *Corrected*) or **Void** (the period can then be invoiced again). Nothing is overwritten.

## Running it

Requirements: Node 22+ and PostgreSQL 14+ (16 recommended).

```bash
cp .env.example .env            # set DATABASE_URL
npm ci
npm run migrate                 # creates/updates the schema
npm run create-user -- you@championequipmentco.com "Your Name" admin
npm run build && npm start      # http://localhost:3000
```

Development/demo only: `npm run seed` loads **sample** data (26 RPM units, sample users `admin@ / manager@ / clerk@ / viewer@champion.local`, password `champion-demo-2026`). It refuses to run with `NODE_ENV=production`.

### Docker (recommended for production)

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
docker compose up -d --build
docker compose exec app npm run create-user -- you@championequipmentco.com "Your Name" admin
```

The app listens on 127.0.0.1:3000. Put it behind HTTPS (for example Caddy, nginx or a Cloudflare Tunnel) before anyone uses it outside the office. Session cookies are `Secure` in production, so plain HTTP logins only work with `INSECURE_COOKIES=1` (testing only).

### Backups

The `backup` service runs `scripts/backup.sh` daily: a `pg_dump` custom-format file plus SHA-256, kept 35 days in `./backups`. Copy that folder off the server (OneDrive/SharePoint sync works). To prove a backup restores:

```bash
PGHOST=... PGUSER=... PGPASSWORD=... sh scripts/verify-backup.sh backups/champion-<timestamp>.dump
```

It restores into a temporary database, compares invoice, PO and audit counts, and re-checks every stored PDF hash.

## Tests

```bash
createdb champion_test
npm test          # 27 tests: billing engine unit tests + Champion's acceptance tests 1–10 on a real PostgreSQL
```

`tests/acceptance.test.ts` is named test by test after section 15 of the requirements. It also covers permissions, concurrency, and proration being blocked until approved.

## Assumptions and open items (need Champion's answers)

| Item | Current state |
|---|---|
| Proration policy | Michael chose "match Quipli". Quipli's setting isn't known yet, so RPM's policy is **Not approved** and partial months are blocked. Options available: actual days, fixed 30-day divisor (capped), full period. |
| Champion's legal header / remit-to | Placeholders. Every invoice shows a warning and needs an override until confirmed in **Settings**. |
| Invoice numbering | `CE-INV-100001…` placeholder sequence. Michael will supply numbers; set the prefix and next number in Settings, or type a specific number when approving. |
| RPM billing address & terms | Placeholder address, Net 30. |
| Sales tax | 8.25% placeholder, flagged as unconfirmed. Applied to taxable lines only. |
| Off-rent day | Treated as billable (configurable per customer). |
| Per-period fees | Not prorated. Delivery bills on the first period only if this system bills from the on-rent date. Pickup bills on the final period. |
| Variance tolerance | RPM: the larger of 1% or $25 (configurable). |
| Sample data | 22 of the 26 units are invented placeholders. The 4 real examples from the brief are included. Load the real November file through **PO imports**. |

## Not in this MVP (Phase 3)

Inventory, dispatch, maintenance, parts, sales, customer portal, online payments, QuickBooks sync, multi-location. The schema is normalized (customers, equipment, contracts/lines, periods, POs, assignments, invoices, payments, imports, audit, users) so these can be added without rework.

## Layout

```
db/migrations/        SQL schema + integrity triggers
src/lib/billing.ts    pure billing-period & proration engine
src/lib/services/     records, POs, imports, invoices, dashboard, auth (all business rules + permission checks)
src/lib/pdf.ts        invoice PDF renderer
src/app/              Next.js pages, server actions, API routes (PDF, exports, documents)
tests/                vitest unit + acceptance tests
scripts/              migrate, seed, create-user, backup, verify-backup
```

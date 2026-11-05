# Customer portal

Customers' own people sign in at `/portal` with a one-time emailed link (no password).

- **Giving access:** on a customer's page, under "Customer portal", an administrator or billing manager enters a name and work email. That person gets a sign-in link. Turning access off signs them out right away.
- **What they see:** only their own company's machines on rent, finished invoices (never drafts or invoices in review) with PDFs, open balance, and their insurance certificate status.
- **What they can send:** pickup / call-off, extend rental, insurance certificate, question. Every request lands on **Customer requests** for your team. Nothing changes on a rental by itself: staff make the change, then mark the request done with a note the customer sees. A certificate counts toward the damage waiver only after an employee files it.
- **Needs email set up** (the same mail settings used to email invoices).
- **Optional `APP_URL`** (for example `https://billing.championequipmentco.com`): the address put in sign-in links. Set it in Vercel so links always use your real domain.

Security: links work once and expire in 30 minutes; at most 5 links per address per hour; the sign-in form answers the same way for any address; only hashes of links and sessions are stored; sessions last 12 hours.

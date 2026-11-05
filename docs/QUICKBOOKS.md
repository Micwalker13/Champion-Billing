# QuickBooks Online sync

Champion Billing sends these to QuickBooks Online, once each:

| What | When it is sent |
| --- | --- |
| Invoice | When it is approved (finalized) |
| Payment | When it is recorded, applied to its invoice |
| Credit memo | When it is issued, applied to its invoice |
| Void | When a sent invoice is voided or replaced by a corrected revision |

It runs right after each of those actions, plus once a day as a safety net. Nothing in QuickBooks ever changes an invoice in Champion Billing.

## One-time setup

1. **Create the Intuit app.** Sign in at <https://developer.intuit.com> with the QuickBooks admin login. Create an app, choose **QuickBooks Online and Payments** and the **Accounting** scope.
2. **Add the redirect address.** In the app's Production settings, add this Redirect URI:
   `https://billing.championequipmentco.com/api/qbo/callback`
   (or `https://champion-billing.vercel.app/api/qbo/callback` until the billing subdomain is live).
3. **Copy the keys into Vercel.** From the app's Production keys, copy the Client ID and Client Secret. In Vercel, go to project **champion-billing**, then **Settings → Environment Variables**, and add them for **Production**:
   - `QBO_CLIENT_ID`
   - `QBO_CLIENT_SECRET`
   - `CRON_SECRET`: any long random text. It protects the daily sync.
   - Optional: `QBO_REDIRECT_URI` if the address in step 2 differs from the site you sign in on.
   - Optional: `QBO_ENVIRONMENT=sandbox` to try it against Intuit's free test company first. Use the Development keys in that case.
4. **Redeploy** so the new settings take effect.
5. **Connect.** Sign in as an administrator, open **QuickBooks** in the menu and click **Connect to QuickBooks**. Approve the connection for Champion's company.
6. **Match items.** Pick which QuickBooks product or service each kind of invoice line goes to: rental, extra hours, damage waiver, environmental, fuel, delivery, pickup, each equipment fee, sales tax, and credits.
7. **Match customers.** A QuickBooks customer with exactly the same name is matched automatically. Match any others by hand.
8. **Pick the start date and turn sync on.** Choose the first date you have *not* already typed into QuickBooks by hand. Nothing dated earlier is ever sent.

## How duplicates are prevented

- Each invoice, credit, payment and void can only be queued once (database rule).
- Before creating an invoice or credit memo, the sync looks for the same number in QuickBooks. If it is there with the same total, it is linked instead. If the total differs, it is flagged for a person to sort out.
- Every create carries a request id, so if the connection drops and the sync retries, QuickBooks ignores the repeat.
- Once a record shows **In QuickBooks**, it can't be changed or deleted.

## Sales tax

Champion Billing works out the sales tax. It is sent as its own line using the item matched to **Sales tax**, and the other lines are sent as non-taxable, so QuickBooks shows the same total. Check this with your accountant before turning sync on. If QuickBooks' automatic sales tax adds tax anyway, the totals won't match, and the invoice is flagged **Needs attention**.

## When something needs attention

The **QuickBooks** page lists anything that couldn't be sent and says why, for example an unmatched customer or item. Fix the cause, then click **Retry**.

## Not included yet

- Equipment sales invoices.
- Re-rent supplier bills to the re-rent GL account (comes with re-rent tracking).

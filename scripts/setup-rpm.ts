// Creates the RPM xConstruction customer with its billing rules (no rentals, no sample data).
// Usage: npm run setup-rpm -- "<billing address>"   (address can be edited later in the app)
import { tx } from "../src/lib/db";
import { setupRpm } from "../src/lib/services/setup";
try { process.loadEnvFile(".env"); } catch {}
(async () => {
  const r = await tx((db) => setupRpm(db, process.argv[2]));
  console.log(r.created ? `RPM xConstruction created (id ${r.id}). Confirm tax rate, terms and proration in the app.` : `RPM xConstruction already exists (id ${r.id}); nothing changed.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

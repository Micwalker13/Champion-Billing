// Loads SAMPLE data (26 RPM units, sample users). For development/demo databases only.
import { seedDemo } from "../src/lib/seed";
try { process.loadEnvFile(".env"); } catch {}
if (process.env.NODE_ENV === "production" && process.env.ALLOW_SAMPLE_SEED !== "1") {
  console.error("Refusing to load sample data with NODE_ENV=production. Set ALLOW_SAMPLE_SEED=1 to override.");
  process.exit(1);
}
seedDemo({ password: process.env.DEMO_PASSWORD }).then((r) => { console.log("Seeded sample data", r); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });

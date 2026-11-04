// Usage: npm run create-user -- email@company.com "Full Name" admin|billing_manager|billing_clerk|viewer
import { createInterface } from "node:readline/promises";
import { createUser } from "../src/lib/services/auth";
import { pool } from "../src/lib/db";
import { ensureCompanySettings } from "../src/lib/services/setup";
try { process.loadEnvFile(".env"); } catch {}
(async () => {
  const [email, name, role] = process.argv.slice(2);
  if (!email || !name || !role) { console.error("Usage: npm run create-user -- <email> <name> <role>"); process.exit(1); }
  await ensureCompanySettings(pool());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = process.env.NEW_USER_PASSWORD ?? (await rl.question("Password (12+ characters): "));
  rl.close();
  const u = await createUser({ email, name, password, role: role as any });
  console.log("Created", u);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

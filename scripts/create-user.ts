// Usage: npm run create-user -- email@company.com "Full Name" admin|billing_manager|billing_clerk|viewer
import { createInterface } from "node:readline/promises";
import { createUser } from "../src/lib/services/auth";
import { one } from "../src/lib/db";
try { process.loadEnvFile(".env"); } catch {}
(async () => {
  const [email, name, role] = process.argv.slice(2);
  if (!email || !name || !role) { console.error("Usage: npm run create-user -- <email> <name> <role>"); process.exit(1); }
  const exists = await one(`SELECT 1 FROM company_settings WHERE id=1`);
  if (!exists) await one(`INSERT INTO company_settings(id,legal_name,address_line1,city_state_zip) VALUES (1,'Champion Equipment','[PLACEHOLDER] Street address','[PLACEHOLDER] City, TX') RETURNING id`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = process.env.NEW_USER_PASSWORD ?? (await rl.question("Password (12+ characters): "));
  rl.close();
  const u = await createUser({ email, name, password, role: role as any });
  console.log("Created", u);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

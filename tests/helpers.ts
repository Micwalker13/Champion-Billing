import { Client } from "pg";
import { migrate } from "../scripts/migrate";
import { seedDemo } from "@/lib/seed";
import { one } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";

export async function resetDb() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrate(process.env.DATABASE_URL);
  return seedDemo({ password: "test-password-123" });
}

export async function userByRole(role: string): Promise<SessionUser> {
  return (await one(`SELECT id, email, name, role FROM users WHERE role=$1 LIMIT 1`, [role])) as SessionUser;
}

export async function lineForUnit(unit: string): Promise<string> {
  const r = await one(`SELECT l.id FROM rental_contract_lines l JOIN equipment e ON e.id=l.equipment_id WHERE e.unit_number=$1`, [unit]);
  return r.id;
}

import { inflateSync } from "node:zlib";
/** Extract drawn text from a pdf-lib PDF (inflates content streams, decodes hex text operands). */
export function pdfText(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    const raw = Buffer.from(s.slice(start, end), "latin1");
    let body: string;
    try { body = inflateSync(raw).toString("latin1"); } catch { body = raw.toString("latin1"); }
    out += body.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, h) => Buffer.from(h, "hex").toString("latin1") + "\n");
  }
  return out;
}

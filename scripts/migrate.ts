import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { pgConfig } from "../src/lib/db";

export async function migrate(connectionString = process.env.DATABASE_URL!) {
  const { max: _max, idleTimeoutMillis: _idle, ...cfg } = pgConfig(connectionString);
  const client = new Client(cfg);
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const dir = path.join(__dirname, "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(path.join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        console.log(`applied ${f}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    // Re-applied on every run so tables added by later migrations are covered too.
    await client.query(readFileSync(path.join(__dirname, "..", "db", "hardening.sql"), "utf8"));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  try { process.loadEnvFile(".env"); } catch { /* no .env: use the real environment */ }
  // On Vercel only production deploys touch the database. Preview builds of unmerged
  // branches must never change the live schema.
  if (process.env.VERCEL && process.env.VERCEL_ENV !== "production") {
    console.log(`Skipping migrations for a ${process.env.VERCEL_ENV} build.`);
    process.exit(0);
  }
  migrate().catch((e) => { console.error(e); process.exit(1); });
}

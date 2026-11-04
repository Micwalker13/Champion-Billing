// Vercel + Supabase readiness: hardening against Supabase's public API, first-run setup,
// database-backed login throttling and TLS settings.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { migrate } from "../scripts/migrate";
import { pgConfig, pool } from "@/lib/db";
import { firstRunSetup, needsSetup } from "@/lib/services/setup";
import { login } from "@/lib/services/auth";

const SUPER = process.env.DATABASE_URL!; // superuser connection to champion_test
const supaUrl = (() => { const u = new URL(SUPER); u.username = "cb_app_owner"; u.password = "owner-pass-123"; u.pathname = "/champion_supa_test"; return u.toString(); })();

async function asSuper<T>(url: string, fn: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  // Recreate what Supabase gives you: a non-superuser owner, and anon/authenticated roles that
  // get every new table in public through default privileges.
  await asSuper(SUPER, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS champion_supa_test WITH (FORCE)`);
    for (const r of ["anon", "authenticated"]) await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cb_app_owner') THEN CREATE ROLE cb_app_owner LOGIN PASSWORD 'owner-pass-123'; END IF; END $$`);
    await c.query(`CREATE DATABASE champion_supa_test OWNER cb_app_owner`);
  });
  const dbAsSuper = (() => { const u = new URL(SUPER); u.pathname = "/champion_supa_test"; return u.toString(); })();
  await asSuper(dbAsSuper, async (c) => {
    await c.query(`ALTER SCHEMA public OWNER TO cb_app_owner`);
    await c.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated`);
    await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE cb_app_owner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated`);
    await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE cb_app_owner IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated`);
  });
  await migrate(supaUrl);
  // Point the app's pool at the Supabase-like database for the rest of this file.
  process.env.DATABASE_URL = supaUrl;
  await pool().end().catch(() => {});
  (globalThis as any).__pgPool = undefined;
});

afterAll(async () => {
  await pool().end().catch(() => {});
  (globalThis as any).__pgPool = undefined;
  process.env.DATABASE_URL = SUPER;
});

describe("Supabase hardening", () => {
  it("removes anon/authenticated access and enables row-level security on every table", async () => {
    const dbAsSuper = (() => { const u = new URL(SUPER); u.pathname = "/champion_supa_test"; return u.toString(); })();
    await asSuper(dbAsSuper, async (c) => {
      const tables = (await c.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`)).rows;
      expect(tables.length).toBeGreaterThan(25);
      expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);
      const granted = (await c.query(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated')`)).rows;
      expect(granted).toEqual([]);
      await c.query(`SET ROLE anon`);
      await expect(c.query(`SELECT * FROM invoices`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT * FROM users`)).rejects.toThrow(/permission denied/);
    });
  });

  it("keeps covering tables added by later migrations", async () => {
    await asSuper(supaUrl, (c) => c.query(`CREATE TABLE later_table (id int)`));
    await migrate(supaUrl);
    const dbAsSuper = (() => { const u = new URL(SUPER); u.pathname = "/champion_supa_test"; return u.toString(); })();
    await asSuper(dbAsSuper, async (c) => {
      const r = (await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname='later_table'`)).rows[0];
      expect(r.relrowsecurity).toBe(true);
      expect((await c.query(`SELECT has_table_privilege('anon','public.later_table','SELECT') AS p`)).rows[0].p).toBe(false);
    });
    await asSuper(supaUrl, (c) => c.query(`DROP TABLE later_table`));
  });
});

describe("First-run setup page", () => {
  const good = { name: "Michael", email: "michael@example.com", password: "a-long-password-1", confirm: "a-long-password-1", createRpm: true, rpmAddress: "RPM xConstruction\nAP Dept" };

  it("is off without a SETUP_TOKEN and rejects a wrong code", async () => {
    delete process.env.SETUP_TOKEN;
    await expect(firstRunSetup({ ...good, token: "anything" })).rejects.toThrow(/Setup is turned off/);
    process.env.SETUP_TOKEN = "correct-setup-token-123";
    await expect(firstRunSetup({ ...good, token: "wrong-token-123456" })).rejects.toThrow(/setup code is wrong/);
    expect(await needsSetup()).toBe(true);
  });

  it("creates the admin and RPM's billing rules as the non-superuser owner, under RLS, then closes", async () => {
    const r = await firstRunSetup({ ...good, token: "correct-setup-token-123" });
    expect(r.user.role).toBe("admin");
    expect(r.rpm?.created).toBe(true);
    expect(await needsSetup()).toBe(false);
    const prof = (await pool().query(`SELECT p.po_pattern, p.proration_policy FROM customer_billing_profiles p JOIN customers c ON c.id=p.customer_id WHERE c.customer_code='RPMX'`)).rows[0];
    expect(prof).toEqual({ po_pattern: "[456][0-9]{5}", proration_policy: "unapproved" });
    await expect(firstRunSetup({ ...good, email: "other@example.com", token: "correct-setup-token-123" })).rejects.toThrow(/already been done/);
  });
});

describe("Login throttling across server instances", () => {
  it("locks an email after 5 failures even with the right password, using the database", async () => {
    for (let i = 0; i < 5; i++) await expect(login("michael@example.com", "wrong-password-xx")).rejects.toThrow(/incorrect/);
    // A fresh process (another Vercel instance) sees the same count.
    await pool().end(); (globalThis as any).__pgPool = undefined;
    await expect(login("michael@example.com", "a-long-password-1")).rejects.toThrow(/Too many failed attempts/);
    await pool().query(`UPDATE login_failures SET failed_at = now() - interval '16 minutes'`);
    const ok = await login("michael@example.com", "a-long-password-1");
    expect(ok.user.email).toBe("michael@example.com");
    expect((await pool().query(`SELECT count(*)::int AS n FROM login_failures WHERE email='michael@example.com'`)).rows[0].n).toBe(0);
  });
});

describe("Connection settings", () => {
  it("uses verified TLS with the Supabase certificate and drops a conflicting sslmode", () => {
    process.env.DATABASE_CA_CERT = "-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----";
    const c = pgConfig("postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require");
    expect(c.connectionString).toBe("postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    expect(c.ssl).toEqual({ ca: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----", rejectUnauthorized: true });
    delete process.env.DATABASE_CA_CERT;
    expect(pgConfig("postgres://x@h/db").ssl).toBeUndefined();
  });
  it("uses a small pool on Vercel", () => {
    process.env.VERCEL = "1";
    expect(pgConfig("postgres://x@h/db").max).toBe(3);
    delete process.env.VERCEL;
    expect(pgConfig("postgres://x@h/db").max).toBe(10);
  });
});

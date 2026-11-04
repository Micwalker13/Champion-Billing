import { Pool, PoolClient, PoolConfig, types } from "pg";

// Return NUMERIC and DATE columns as strings: never coerce money to JS floats,
// never shift DATE columns through local time zones.
types.setTypeParser(1700, (v) => v); // numeric
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(20, (v) => v);   // int8 -> string id (safe)

const globalForPool = globalThis as unknown as { __pgPool?: Pool };

/**
 * The database connection string. DATABASE_URL wins; POSTGRES_URL is what Supabase's Vercel
 * integration creates (its transaction-pooler string), so either works on Vercel.
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

/**
 * Connection settings shared by the app, migrations and scripts.
 * DATABASE_CA_CERT (PEM text, e.g. Supabase's downloadable root certificate) turns on fully
 * verified TLS. Any sslmode in the URL is then dropped, because pg lets URL settings override ssl.
 * Without it, Supabase connections are still encrypted (libpq "require" semantics).
 */
export function pgConfig(connectionString = databaseUrl()): PoolConfig {
  if (!connectionString) throw new Error("No database connection string. In Vercel, add DATABASE_URL (Supabase's Transaction pooler string) under Settings → Environment Variables with Production ticked, then redeploy.");
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  const onVercel = !!process.env.VERCEL;
  const base = { max: Number(process.env.PG_POOL_MAX) || (onVercel ? 3 : 10), idleTimeoutMillis: onVercel ? 5_000 : 10_000 };
  const url = new URL(connectionString);
  if (ca) {
    for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(k);
    return { ...base, connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
  }
  if (/\.supabase\.(com|co)$/i.test(url.hostname) && url.searchParams.get("sslmode") !== "disable" && !url.searchParams.has("uselibpqcompat")) {
    // node-postgres reads sslmode=require as "verify against the system CAs", which Supabase's
    // private CA fails. libpq semantics: encrypted, certificate not verified.
    if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
    url.searchParams.set("uselibpqcompat", "true");
    return { ...base, connectionString: url.toString() };
  }
  return { ...base, connectionString };
}

export function pool(): Pool {
  if (!globalForPool.__pgPool) globalForPool.__pgPool = new Pool(pgConfig());
  return globalForPool.__pgPool;
}

export type Db = Pick<PoolClient, "query">;

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool()): Promise<T[]> {
  const r = await db.query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool()): Promise<T | null> {
  const rows = await q<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Run fn inside a single SERIALIZABLE-safe transaction; rolls back on any error. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(
  db: Db,
  userId: string | number | null,
  action: string,
  entity: string,
  entityId: string | number | null,
  before: unknown,
  after: unknown,
  note?: string,
) {
  await db.query(
    `INSERT INTO audit_log(user_id, action, entity, entity_id, before, after, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, action, entity, entityId == null ? null : String(entityId), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note ?? null],
  );
}

export class AppError extends Error {
  constructor(message: string, public code = "invalid", public details?: unknown) {
    super(message);
  }
}

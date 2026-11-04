import { Pool, PoolClient, PoolConfig, types } from "pg";

// Return NUMERIC and DATE columns as strings: never coerce money to JS floats,
// never shift DATE columns through local time zones.
types.setTypeParser(1700, (v) => v); // numeric
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(20, (v) => v);   // int8 -> string id (safe)

const globalForPool = globalThis as unknown as { __pgPool?: Pool };

/**
 * Connection settings shared by the app, migrations and scripts.
 * DATABASE_CA_CERT (PEM text, e.g. Supabase's downloadable root certificate) turns on fully
 * verified TLS. Any sslmode in the URL is then dropped, because pg lets URL settings override ssl.
 */
export function pgConfig(connectionString = process.env.DATABASE_URL): PoolConfig {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  const onVercel = !!process.env.VERCEL;
  const max = Number(process.env.PG_POOL_MAX) || (onVercel ? 3 : 10);
  if (!ca) return { connectionString, max, idleTimeoutMillis: onVercel ? 5_000 : 10_000 };
  const url = new URL(connectionString);
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(k);
  return { connectionString: url.toString(), max, idleTimeoutMillis: onVercel ? 5_000 : 10_000, ssl: { ca, rejectUnauthorized: true } };
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

import { Pool, PoolClient, types } from "pg";

// Return NUMERIC and DATE columns as strings: never coerce money to JS floats,
// never shift DATE columns through local time zones.
types.setTypeParser(1700, (v) => v); // numeric
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(20, (v) => v);   // int8 -> string id (safe)

const globalForPool = globalThis as unknown as { __pgPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.__pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPool.__pgPool = new Pool({ connectionString, max: 10 });
  }
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

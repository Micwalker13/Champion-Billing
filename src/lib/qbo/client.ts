/**
 * Minimal QuickBooks Online client: OAuth 2.0 tokens and the few accounting API calls the sync uses.
 * Uses Intuit's public, documented REST API only. Tokens are encrypted before they reach the database.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { AppError, Db, one, pool } from "../db";

export type QboEnv = "sandbox" | "production";
type Fetch = typeof fetch;

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const API_BASE: Record<QboEnv, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};
const MINOR_VERSION = "75";

let testFetch: Fetch | null = null;
/** Tests replace the network with a fake QuickBooks. */
export function setQboFetch(f: Fetch | null) { testFetch = f; }
const http: Fetch = (...a) => (testFetch ?? fetch)(...a);

export function qboAppConfig() {
  const clientId = process.env.QBO_CLIENT_ID ?? "";
  const clientSecret = process.env.QBO_CLIENT_SECRET ?? "";
  const environment: QboEnv = process.env.QBO_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
  return { clientId, clientSecret, environment, configured: !!clientId && !!clientSecret };
}

// ───────────────────────── Token encryption ─────────────────────────
function key(): Buffer {
  const { clientSecret } = qboAppConfig();
  if (!clientSecret) throw new AppError("QuickBooks isn't set up on the server yet (QBO_CLIENT_SECRET is missing).");
  return Buffer.from(hkdfSync("sha256", clientSecret, "champion-billing", "qbo-token-encryption", 32));
}
export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
export function decryptToken(enc: string): string {
  const [v, iv, tag, body] = enc.split(".");
  if (v !== "v1") throw new AppError("Unrecognized token format.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// ───────────────────────── OAuth ─────────────────────────
export function authorizeUrl(redirectUri: string, state: string) {
  const { clientId } = qboAppConfig();
  const p = new URLSearchParams({ client_id: clientId, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirectUri, state });
  return `${AUTH_URL}?${p}`;
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in?: number }

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = qboAppConfig();
  const res = await http(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(`QuickBooks sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
  return j;
}

export function exchangeCode(code: string, redirectUri: string) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export async function revokeToken(token: string) {
  const { clientId, clientSecret } = qboAppConfig();
  await http(REVOKE_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
}

export function tokenColumns(t: TokenResponse) {
  const now = Date.now();
  return {
    access_token_enc: encryptToken(t.access_token),
    refresh_token_enc: encryptToken(t.refresh_token),
    access_expires_at: new Date(now + t.expires_in * 1000),
    refresh_expires_at: t.x_refresh_token_expires_in ? new Date(now + t.x_refresh_token_expires_in * 1000) : null,
  };
}

// ───────────────────────── API client ─────────────────────────
export class QboError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) { super(message); }
}

function faultMessage(j: any, status: number): string {
  const e = j?.Fault?.Error?.[0];
  if (e) return [e.Message, e.Detail].filter(Boolean).join(": ");
  return `QuickBooks returned HTTP ${status}`;
}

export class QboClient {
  private constructor(private conn: any, private db: Db) {}

  /** The connected company, or null when QuickBooks isn't connected. */
  static async load(db: Db = pool()): Promise<QboClient | null> {
    const conn = await one(`SELECT * FROM qbo_connection WHERE id=1`, [], db);
    return conn ? new QboClient(conn, db) : null;
  }

  get realmId(): string { return this.conn.realm_id; }

  private async accessToken(force = false): Promise<string> {
    if (!force && new Date(this.conn.access_expires_at).getTime() - Date.now() > 60_000) return decryptToken(this.conn.access_token_enc);
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: decryptToken(this.conn.refresh_token_enc) });
    const cols = tokenColumns(t);
    this.conn = await one(
      `UPDATE qbo_connection SET access_token_enc=$1, refresh_token_enc=$2, access_expires_at=$3, refresh_expires_at=coalesce($4, refresh_expires_at), updated_at=now() WHERE id=1 RETURNING *`,
      [cols.access_token_enc, cols.refresh_token_enc, cols.access_expires_at, cols.refresh_expires_at], this.db);
    return t.access_token;
  }

  private async call(method: "GET" | "POST", path: string, params: Record<string, string> = {}, body?: unknown): Promise<any> {
    const url = `${API_BASE[this.conn.environment as QboEnv]}/v3/company/${encodeURIComponent(this.realmId)}/${path}?${new URLSearchParams({ ...params, minorversion: MINOR_VERSION })}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await http(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) continue;
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || j?.Fault) throw new QboError(faultMessage(j, res.status), res.status, j);
      return j;
    }
    throw new QboError("QuickBooks rejected the sign-in. Reconnect QuickBooks.", 401);
  }

  /** Run a QuickBooks query, e.g. `select * from Customer where DisplayName = 'X'`. */
  async query(sql: string): Promise<any> {
    const j = await this.call("GET", "query", { query: sql });
    return j.QueryResponse ?? {};
  }
  /** Create an object. `requestId` makes the call safe to retry: QuickBooks ignores a repeat. */
  async create(entity: string, body: unknown, requestId: string): Promise<any> {
    const j = await this.call("POST", entity.toLowerCase(), { requestid: requestId }, body);
    return j[entity];
  }
  async read(entity: string, id: string): Promise<any> {
    const j = await this.call("GET", `${entity.toLowerCase()}/${encodeURIComponent(id)}`);
    return j[entity];
  }
  async voidInvoice(id: string, syncToken: string, requestId: string): Promise<any> {
    const j = await this.call("POST", "invoice", { operation: "void", requestid: requestId }, { Id: id, SyncToken: syncToken });
    return j.Invoice;
  }
  async companyName(): Promise<string | null> {
    const j = await this.call("GET", `companyinfo/${encodeURIComponent(this.realmId)}`);
    return j.CompanyInfo?.CompanyName ?? null;
  }
}

/** Quote a value for a QuickBooks query string. */
export const qstr = (s: string) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

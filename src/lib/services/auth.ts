import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AppError, audit, one, pool, q } from "../db";
import { Role, SessionUser } from "../permissions";

export const SESSION_COOKIE = "cb_session";
export const SESSION_HOURS = 12;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

// Simple in-process throttle: 5 failures per email per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();

export async function login(email: string, password: string): Promise<{ token: string; user: SessionUser; expires: Date }> {
  const key = email.trim().toLowerCase();
  const f = failures.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) throw new AppError("Too many failed attempts. Try again in 15 minutes.", "throttled");
  const u = await one(`SELECT * FROM users WHERE lower(email)=$1 AND active`, [key]);
  const ok = u ? await bcrypt.compare(password, u.password_hash) : await bcrypt.compare(password, "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5x1ZpOQ9H7fFQ3Xh9pYV8sB2c1nE5u.");
  if (!u || !ok) {
    failures.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
    await audit(pool(), u?.id ?? null, "login_failed", "user", u?.id ?? null, null, { email: key });
    throw new AppError("Email or password is incorrect.", "auth");
  }
  failures.delete(key);
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await pool().query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)`, [hashToken(token), u.id, expires]);
  await pool().query(`DELETE FROM sessions WHERE expires_at < now()`);
  await audit(pool(), u.id, "login", "user", u.id, null, null);
  return { token, user: { id: u.id, email: u.email, name: u.name, role: u.role }, expires };
}

export async function userForToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const u = await one(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`, [hashToken(token)]);
  return u ?? null;
}

export async function logout(token: string | undefined | null) {
  if (token) await pool().query(`DELETE FROM sessions WHERE token_hash=$1`, [hashToken(token)]);
}

export function validatePassword(pw: string) {
  if (pw.length < 12) throw new AppError("Passwords must be at least 12 characters.");
}

export async function createUser(input: { email: string; name: string; password: string; role: Role }, actor?: SessionUser) {
  validatePassword(input.password);
  const hash = await bcrypt.hash(input.password, 12);
  const u = await one(`INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role`, [input.email.trim().toLowerCase(), input.name.trim(), hash, input.role]);
  await audit(pool(), actor?.id ?? null, "create", "user", u.id, null, u);
  return u;
}

export async function setUserActive(actor: SessionUser, id: string, active: boolean) {
  if (String(actor.id) === String(id) && !active) throw new AppError("You cannot deactivate yourself.");
  await pool().query(`UPDATE users SET active=$2 WHERE id=$1`, [id, active]);
  if (!active) await pool().query(`DELETE FROM sessions WHERE user_id=$1`, [id]);
  await audit(pool(), actor.id, active ? "activate" : "deactivate", "user", id, null, null);
}

export async function listUsers() {
  return q(`SELECT id, email, name, role, active, created_at FROM users ORDER BY name`);
}

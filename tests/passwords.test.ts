// Changing your own password, and an administrator resetting someone else's.
import { beforeAll, describe, expect, it } from "vitest";
import { one } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { changePassword, login, resetUserPassword } from "@/lib/services/auth";
import { resetDb, userByRole } from "./helpers";

let admin: SessionUser, clerk: SessionUser;
beforeAll(async () => { await resetDb(); [admin, clerk] = await Promise.all(["admin", "billing_clerk"].map(userByRole)); });

describe("Passwords", () => {
  it("changes your own password only with the current one, and signs out other devices", async () => {
    const a = await login(clerk.email, "test-password-123");
    const b = await login(clerk.email, "test-password-123");
    await expect(changePassword(clerk, "wrong-password-0", "new-password-456")).rejects.toThrow(/current password is incorrect/);
    await expect(changePassword(clerk, "test-password-123", "short")).rejects.toThrow(/at least 12/);
    await changePassword(clerk, "test-password-123", "new-password-456", a.token);
    await expect(login(clerk.email, "test-password-123")).rejects.toThrow(/incorrect/);
    expect((await login(clerk.email, "new-password-456")).user.id).toBe(clerk.id);
    const sessions = await one(`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1`, [clerk.id]);
    expect(sessions.n).toBe(2); // the kept session plus the new login; the other device was signed out
    void b;
  });
  it("lets only an administrator set a temporary password", async () => {
    await expect(resetUserPassword(clerk, admin.id, "temporary-pass-1")).rejects.toThrow(/permission/);
    await resetUserPassword(admin, clerk.id, "temporary-pass-1");
    expect((await login(clerk.email, "temporary-pass-1")).user.id).toBe(clerk.id);
    expect((await one(`SELECT action FROM audit_log WHERE action='reset_password' ORDER BY id DESC LIMIT 1`)).action).toBe("reset_password");
  });
});

export type Role = "admin" | "billing_manager" | "billing_clerk" | "viewer";
export interface SessionUser { id: string; email: string; name: string; role: Role }

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  billing_manager: "Billing manager (approver)",
  billing_clerk: "Billing clerk",
  viewer: "Read-only",
};

const MATRIX = {
  view: ["admin", "billing_manager", "billing_clerk", "viewer"],
  edit_records: ["admin", "billing_manager", "billing_clerk"],
  assign_po: ["admin", "billing_manager", "billing_clerk"],
  correct_po: ["admin", "billing_manager"],
  import_po: ["admin", "billing_manager", "billing_clerk"],
  apply_import: ["admin", "billing_manager"],
  generate_invoice: ["admin", "billing_manager", "billing_clerk"],
  submit_invoice: ["admin", "billing_manager", "billing_clerk"],
  approve_invoice: ["admin", "billing_manager"],
  override_validation: ["admin", "billing_manager"],
  manage_tax_exempt: ["admin", "billing_manager"],
  issue_invoice: ["admin", "billing_manager"],
  void_invoice: ["admin", "billing_manager"],
  record_payment: ["admin", "billing_manager", "billing_clerk"],
  configure_billing: ["admin"],
  manage_fees: ["admin"],
  override_fees: ["admin", "billing_manager"],
  manage_users: ["admin"],
  manage_quickbooks: ["admin"],
  run_quickbooks_sync: ["admin", "billing_manager"],
  export_data: ["admin", "billing_manager", "billing_clerk"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(user: Pick<SessionUser, "role"> | null | undefined, perm: Permission): boolean {
  return !!user && (MATRIX[perm] as readonly Role[]).includes(user.role);
}

export class ForbiddenError extends Error {
  code = "forbidden";
  constructor(perm: Permission) { super(`You do not have permission to ${perm.replace(/_/g, " ")}.`); }
}

export function requirePerm(user: SessionUser | null | undefined, perm: Permission): asserts user is SessionUser {
  if (!can(user, perm)) throw new ForbiddenError(perm);
}

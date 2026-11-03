export interface PoRules {
  po_pattern: string | null;
  po_pattern_description: string | null;
}

export function normalizePo(v: unknown): string {
  if (v == null) return "";
  // Excel may hand us a number (459186) or "459186.0"
  let s = typeof v === "number" ? String(Math.trunc(v)) : String(v);
  s = s.trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
}

export function normalizeUnit(v: unknown): string {
  return v == null ? "" : String(v).trim().toUpperCase().replace(/\s+/g, "");
}

export function normalizeRef(v: unknown): string | null {
  if (v == null) return null;
  let s = typeof v === "number" ? String(Math.trunc(v)) : String(v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s === "" ? null : s;
}

/** Compile an admin-configured PO pattern. Patterns are always anchored. */
export function compilePattern(pattern: string): RegExp {
  if (pattern.length > 200) throw new Error("PO pattern too long");
  const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
  return new RegExp(`^(?:${body})$`);
}

export function validatePoFormat(po: string, rules: PoRules): { ok: true } | { ok: false; message: string } {
  if (!po) return { ok: false, message: "PO number is missing" };
  if (po.length > 64) return { ok: false, message: "PO number is too long" };
  if (!rules.po_pattern) return { ok: true };
  if (compilePattern(rules.po_pattern).test(po)) return { ok: true };
  return { ok: false, message: `PO "${po}" does not match the required format: ${rules.po_pattern_description || rules.po_pattern}` };
}

/** Very small edit-distance helper used to suggest likely unit numbers; suggestions are never auto-applied. */
export function similarUnits(unit: string, candidates: string[], max = 3): string[] {
  const strip = (s: string) => s.replace(/^([A-Z]+)0*/, "$1");
  const target = strip(unit);
  return candidates
    .map((c) => ({ c, d: c === unit ? 0 : strip(c) === target ? 0.5 : lev(unit, c) }))
    .filter((x) => x.c !== unit && x.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.c);
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

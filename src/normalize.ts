/**
 * Deterministic, non-semantic normalization used for conflict detection.
 *
 * This is intentionally "dumb": trim, lowercase, collapse internal whitespace.
 * It catches exact-and near-exact restatements (different casing, stray
 * spaces/newlines) but will NOT recognize that two differently-worded claims
 * mean the same thing. That would require semantic (LLM-based) understanding,
 * which is explicitly out of scope for this deterministic v1 — see README
 * "Limitations".
 */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

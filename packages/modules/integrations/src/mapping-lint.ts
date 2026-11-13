/**
 * Mapping vocabularies and validation lint (M03-FR-07/13, BR-M03-6). Pure functions: no I/O.
 *
 * Direction per kind:
 *  - status: external → canonical. Every external state the provider reports must be mapped, or
 *    defect sync cannot interpret it (error). Canonical states nobody maps to are warnings.
 *  - severity / priority: both ways. Every canonical value needs an external value to be sent as
 *    (error); external values without a mapping are warnings (they cannot be read back).
 *  - type: the canonical `bug` must map to exactly one external type (error).
 */
export const MAPPING_KINDS = ['status', 'severity', 'priority', 'type'] as const;
export type MappingKind = (typeof MAPPING_KINDS)[number];
export const isMappingKind = (v: unknown): v is MappingKind =>
  typeof v === 'string' && (MAPPING_KINDS as readonly string[]).includes(v);

/** Canonical values (M10-FR-01/09). `draft`, `pending_approval`, `verified` and
 * `failed_verification` are internal-only states and never come from a tracker. */
export const CANONICAL_VALUES: Readonly<Record<MappingKind, readonly string[]>> = {
  status: ['open', 'in_progress', 'fix_candidate', 'resolved', 'closed', 'rejected', 'duplicate', 'wont_fix'],
  severity: ['S1', 'S2', 'S3', 'S4'],
  priority: ['P1', 'P2', 'P3', 'P4'],
  type: ['bug'],
};
/** Canonical states defect sync cannot work without (BR-M10-4): warned when unreachable. */
const CORE_STATUS = ['open', 'resolved', 'closed'];

export interface MappingEntry {
  readonly external: string;
  readonly canonical: string;
}
export type LintCode =
  | 'unmapped_external'
  | 'duplicate_external'
  | 'unknown_canonical'
  | 'unmapped_canonical'
  | 'unreachable_canonical'
  | 'stale_external'
  | 'empty_external'
  | 'bug_type_ambiguous';
export interface LintIssue {
  readonly severity: 'error' | 'warning';
  readonly code: LintCode;
  readonly value: string;
}
export interface LintResult {
  readonly ok: boolean;
  readonly issues: readonly LintIssue[];
}

/**
 * Lints one mapping. `discovered` is what the provider reported (null: never discovered, so
 * checks that need it are not run).
 */
export function lintMapping(
  kind: MappingKind,
  entries: readonly MappingEntry[],
  discovered: readonly string[] | null,
): LintResult {
  const issues: LintIssue[] = [];
  const canonical = new Set(CANONICAL_VALUES[kind]);
  const seen = new Map<string, number>();
  for (const e of entries) {
    const ext = e.external.trim();
    if (!ext) {
      issues.push({ severity: 'error', code: 'empty_external', value: e.canonical });
      continue;
    }
    seen.set(ext, (seen.get(ext) ?? 0) + 1);
    if (!canonical.has(e.canonical))
      issues.push({ severity: 'error', code: 'unknown_canonical', value: e.canonical });
  }
  for (const [ext, n] of seen)
    if (n > 1) issues.push({ severity: 'error', code: 'duplicate_external', value: ext });

  if (discovered) {
    const known = new Set(discovered);
    for (const ext of discovered) {
      if (!seen.has(ext)) {
        issues.push({
          severity: kind === 'status' ? 'error' : 'warning',
          code: 'unmapped_external',
          value: ext,
        });
      }
    }
    // A provider that renamed or removed a value: the mapping points at nothing.
    for (const ext of seen.keys())
      if (!known.has(ext)) issues.push({ severity: 'warning', code: 'stale_external', value: ext });
  }

  const mappedCanonical = new Set(entries.map((e) => e.canonical));
  if (kind === 'status') {
    for (const c of CORE_STATUS)
      if (!mappedCanonical.has(c))
        issues.push({ severity: 'warning', code: 'unreachable_canonical', value: c });
  } else if (kind === 'severity' || kind === 'priority') {
    for (const c of CANONICAL_VALUES[kind])
      if (!mappedCanonical.has(c)) issues.push({ severity: 'error', code: 'unmapped_canonical', value: c });
  } else {
    const bugs = entries.filter((e) => e.canonical === 'bug').length;
    if (bugs !== 1)
      issues.push({
        severity: 'error',
        code: bugs === 0 ? 'unmapped_canonical' : 'bug_type_ambiguous',
        value: 'bug',
      });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * A starting point from discovered values: tracker state categories map to canonical states, and
 * ordered severities and priorities map position by position. Users review it before saving.
 */
export function suggestMapping(
  kind: MappingKind,
  discovered: readonly string[],
  stateCategories: Readonly<Record<string, string>> = {},
): MappingEntry[] {
  if (kind === 'status') {
    const byCategory: Record<string, string> = {
      proposed: 'open',
      in_progress: 'in_progress',
      resolved: 'resolved',
      completed: 'closed',
      removed: 'rejected',
    };
    return discovered.map((external) => ({
      external,
      canonical: byCategory[stateCategories[external] ?? ''] ?? 'in_progress',
    }));
  }
  if (kind === 'type') {
    const bug = discovered.find((t) => /bug|defect/i.test(t));
    return bug ? [{ external: bug, canonical: 'bug' }] : [];
  }
  const canonical = CANONICAL_VALUES[kind];
  return discovered.slice(0, canonical.length).map((external, i) => ({ external, canonical: canonical[i]! }));
}

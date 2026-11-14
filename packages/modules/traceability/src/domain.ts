/**
 * The traceability graph (doc 09 §5): typed edges between artifacts of any module. Framework-free.
 * Every link type allows only certain endpoint types, so the graph stays meaningful.
 */
export const ENDPOINT_TYPES = [
  'requirement',
  'extracted_item',
  'test_case',
  'automation_binding',
  'test_execution',
  'execution_attempt',
  'defect',
  'defect_draft',
  'external_ref',
  'code_change',
] as const;
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

const SHAPES = {
  derived_from: [['requirement'], ['extracted_item']],
  child_of: [['requirement'], ['requirement']],
  relates_to: [['requirement'], ['requirement']],
  verifies: [['test_case'], ['requirement']],
  bound_to: [['test_case'], ['automation_binding']],
  executed_as: [['test_case'], ['test_execution']],
  detected_by: [['defect'], ['test_execution', 'execution_attempt']],
  affects: [['defect'], ['requirement']],
  fixed_by: [['defect'], ['external_ref']],
  verified_by: [['defect'], ['test_execution']],
  duplicates: [['defect_draft', 'defect'], ['defect']],
  updates: [['code_change'], ['test_case']],
} as const satisfies Record<string, readonly [readonly EndpointType[], readonly EndpointType[]]>;

export type LinkType = keyof typeof SHAPES;
export const LINK_TYPES = Object.keys(SHAPES) as LinkType[];
export type LinkStatus = 'active' | 'outdated' | 'removed';
export type LinkOrigin = 'user' | 'ai' | 'system';

export function isLinkType(value: string): value is LinkType {
  return Object.hasOwn(SHAPES, value);
}

/** Whether `type` may connect `from` to `to`. Self-links are never allowed. */
export function linkShapeError(
  type: string,
  from: { type: string; id: string },
  to: { type: string; id: string },
): string | null {
  if (!isLinkType(type)) return 'trace.link_type_invalid';
  const [froms, tos] = SHAPES[type] as readonly [readonly string[], readonly string[]];
  if (!froms.includes(from.type) || !tos.includes(to.type)) return 'trace.link_shape_invalid';
  if (from.type === to.type && from.id === to.id) return 'trace.self_link';
  return null;
}

/** Coverage of a requirement (M04-FR-17), from its active `verifies` links. */
export type Coverage = 'uncovered' | 'covered_manual' | 'covered_automated' | 'covered_both' | 'failing';

export interface CoverageInput {
  readonly status: LinkStatus;
  /** The verifying test is automated (known from P6 bindings; manual until then). */
  readonly automated?: boolean;
  /** The verifying test's latest result failed (known from P4/P6 results). */
  readonly failing?: boolean;
}

export function coverageOf(verifies: readonly CoverageInput[]): Coverage {
  const live = verifies.filter((v) => v.status === 'active');
  if (!live.length) return 'uncovered';
  if (live.some((v) => v.failing)) return 'failing';
  const auto = live.some((v) => v.automated);
  const manual = live.some((v) => !v.automated);
  return auto && manual ? 'covered_both' : auto ? 'covered_automated' : 'covered_manual';
}

/** True when making `childId` a child of `parentId` would close a cycle (given child → parent edges). */
export function wouldCycle(
  childId: string,
  parentId: string,
  parentsOf: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>();
  const stack = [parentId];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === childId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(parentsOf.get(node) ?? []));
  }
  return false;
}

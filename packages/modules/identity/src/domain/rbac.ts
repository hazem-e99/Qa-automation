/**
 * Role and permission catalog: the single source of truth for authorization (M13 §9).
 * The table in docs/planning/modules/M13-team-permissions.md is checked against this file by a
 * test (M13-AC-06), and the database tables are synchronized from it at start-up.
 */
export type Grant = 'granted' | 'own' | 'policy';

/** Project-scope roles, in the column order of the documented matrix. */
export const PROJECT_MATRIX_ROLES = [
  'qa_lead',
  'qa_engineer',
  'qc_reviewer',
  'developer',
  'project_manager',
  'viewer',
  'org_admin',
] as const;
export type MatrixRole = (typeof PROJECT_MATRIX_ROLES)[number];

export const ROLES = {
  platform_admin: { scope: 'platform' },
  org_admin: { scope: 'org' },
  qa_lead: { scope: 'project' },
  qa_engineer: { scope: 'project' },
  qc_reviewer: { scope: 'project' },
  developer: { scope: 'project' },
  project_manager: { scope: 'project' },
  viewer: { scope: 'project' },
} as const;
export type RoleKey = keyof typeof ROLES;
export const isRoleKey = (v: unknown): v is RoleKey => typeof v === 'string' && v in ROLES;

/** Rank used by "cannot grant a role above your own" (BR-M13-3). Higher is more powerful. */
export const ROLE_RANK: Readonly<Record<RoleKey, number>> = {
  viewer: 1,
  developer: 2,
  project_manager: 2,
  qc_reviewer: 3,
  qa_engineer: 3,
  qa_lead: 4,
  org_admin: 5,
  platform_admin: 6,
};

type Cell = { readonly show: string; readonly grants: readonly (Grant | null)[] };
interface Row {
  /** Row label exactly as documented; one or more permission keys. */
  readonly label: string;
  readonly permissions: readonly string[];
  readonly cells: Partial<Record<MatrixRole, Cell>>;
}

const G: Cell = { show: '●', grants: ['granted'] };
const P: Cell = { show: '◐', grants: ['policy'] };
/** Same mark for every permission of a multi-permission row. */
const all = (cell: Cell, n: number): Cell => ({ show: cell.show, grants: Array(n).fill(cell.grants[0]) });
const cell = (show: string, ...grants: (Grant | null)[]): Cell => ({ show, grants });

const row = (label: string, permissions: string[], cells: Partial<Record<MatrixRole, Cell>>): Row => ({
  label,
  permissions,
  cells: Object.fromEntries(
    Object.entries(cells).map(([role, c]) => [
      role,
      c.grants.length === permissions.length ? c : all(c, permissions.length),
    ]),
  ),
});
const everyone = Object.fromEntries(PROJECT_MATRIX_ROLES.map((r) => [r, G])) as Record<MatrixRole, Cell>;

/** Project-scope matrix (M13 §9). ● granted, ◐ policy-dependent, blank denied. */
export const PROJECT_MATRIX: readonly Row[] = [
  row('project.read', ['project.read'], everyone),
  row('project.settings.manage', ['project.settings.manage'], { qa_lead: G, org_admin: G }),
  row('project.bindings.manage', ['project.bindings.manage'], { org_admin: G }),
  row('project.environments.manage', ['project.environments.manage'], { qa_lead: G, org_admin: G }),
  row('requirement.create / edit', ['requirement.create', 'requirement.edit'], {
    qa_lead: G,
    qa_engineer: G,
    project_manager: P,
  }),
  row('requirement.approve', ['requirement.approve'], { qa_lead: G, qc_reviewer: P, project_manager: P }),
  row('requirement_source.manage / document.upload', ['requirement_source.manage', 'document.upload'], {
    qa_lead: G,
    qa_engineer: G,
    org_admin: G,
  }),
  row('finding.resolve / finding.waive', ['finding.resolve', 'finding.waive'], {
    qa_lead: cell('● / ●', 'granted', 'granted'),
    qa_engineer: cell('● /', 'granted', null),
    qc_reviewer: cell('● /', 'granted', null),
  }),
  row('testcase.create / edit', ['testcase.create', 'testcase.edit'], {
    qa_lead: G,
    qa_engineer: G,
    developer: P,
  }),
  row('testcase.approve', ['testcase.approve'], { qa_lead: G, qc_reviewer: G }),
  row('ai.tests.generate', ['ai.tests.generate'], { qa_lead: G, qa_engineer: G }),
  row('cycle.manage', ['cycle.manage'], { qa_lead: G, project_manager: P }),
  row('execution.run', ['execution.run'], { qa_lead: G, qa_engineer: G, qc_reviewer: P }),
  row('execution.reopen', ['execution.reopen'], { qa_lead: G }),
  row('run.trigger (non-prod)', ['run.trigger'], { qa_lead: G, qa_engineer: G, developer: P }),
  row('run.trigger.production', ['run.trigger.production'], { qa_lead: P }),
  row('run.cancel', ['run.cancel'], {
    qa_lead: G,
    qa_engineer: cell('● (own)', 'own'),
    developer: cell('● (own)', 'own'),
  }),
  row('gate.manage / policy.execution.manage', ['gate.manage', 'policy.execution.manage'], { qa_lead: G }),
  row('codegen.request', ['codegen.request'], {
    qa_lead: G,
    qa_engineer: cell('◐ (automation flag)', 'policy'),
  }),
  row('visual.review / visual.baseline.approve', ['visual.review', 'visual.baseline.approve'], {
    qa_lead: cell('● / ●', 'granted', 'granted'),
    qa_engineer: cell('● /', 'granted', null),
    qc_reviewer: cell('● / ◐', 'granted', 'policy'),
  }),
  row('defect.create / edit', ['defect.create', 'defect.edit'], {
    qa_lead: G,
    qa_engineer: G,
    qc_reviewer: G,
    developer: P,
  }),
  row('defect.draft.approve / defect.external.sync', ['defect.draft.approve', 'defect.external.sync'], {
    qa_lead: G,
    qc_reviewer: P,
  }),
  row('classification.override', ['classification.override'], { qa_lead: G, qa_engineer: G, qc_reviewer: G }),
  row('automation.rule.manage', ['automation.rule.manage'], { qa_lead: G, org_admin: G }),
  row('automation.rule.run_now', ['automation.rule.run_now'], { qa_lead: G, qa_engineer: P }),
  row('analytics.read', ['analytics.read'], everyone),
  row('report.create / schedule / export', ['report.create', 'report.schedule', 'report.export'], {
    qa_lead: G,
    qa_engineer: cell('● (create, export)', 'granted', null, 'granted'),
    qc_reviewer: cell('● (export)', null, null, 'granted'),
    project_manager: G,
    viewer: cell('◐ (export)', null, null, 'policy'),
    org_admin: G,
  }),
  row('audit.read (project)', ['audit.read'], { qa_lead: G, qc_reviewer: G, org_admin: G }),
  row('members.manage', ['members.manage'], { qa_lead: cell('● (≤ own role)', 'granted'), org_admin: G }),
];

/** Org- and platform-scope permissions (M13 §9, list under the matrix). */
export const ORG_PERMISSIONS: Readonly<Record<string, readonly RoleKey[]>> = {
  'connection.manage': ['org_admin', 'platform_admin'],
  'connection.secret.rotate': ['org_admin', 'platform_admin'],
  'connection.retire': ['org_admin', 'platform_admin'],
  'user.manage': ['org_admin'],
  'project.create': ['org_admin'],
  'org.analytics.read': ['org_admin', 'platform_admin'],
  'cost.read': ['org_admin', 'platform_admin'],
  'system.settings': ['platform_admin'],
  'backup.manage': ['platform_admin'],
  'automation.admin': ['platform_admin'],
};

const projectGrants = new Map<string, Map<RoleKey, Grant>>();
for (const r of PROJECT_MATRIX) {
  r.permissions.forEach((permission, i) => {
    const byRole = projectGrants.get(permission) ?? new Map<RoleKey, Grant>();
    for (const [role, c] of Object.entries(r.cells) as [MatrixRole, Cell][]) {
      const grant = c.grants[i];
      if (grant) byRole.set(role, grant);
    }
    projectGrants.set(permission, byRole);
  });
}

export const PROJECT_PERMISSION_KEYS: readonly string[] = [...projectGrants.keys()];
export const ORG_PERMISSION_KEYS: readonly string[] = Object.keys(ORG_PERMISSIONS);
export const ALL_PERMISSION_KEYS: readonly string[] = [...PROJECT_PERMISSION_KEYS, ...ORG_PERMISSION_KEYS];
export const isPermissionKey = (key: string): boolean => projectGrants.has(key) || key in ORG_PERMISSIONS;
export const isProjectPermission = (key: string): boolean => projectGrants.has(key);

/** What a role gets for a permission, or null when it gets nothing (deny by default). */
export function grantFor(role: RoleKey, permission: string): Grant | null {
  const org = ORG_PERMISSIONS[permission];
  if (org) return org.includes(role) ? 'granted' : null;
  return projectGrants.get(permission)?.get(role) ?? null;
}

/** Every (role, permission, grant) triple, for seeding the database tables. */
export function allGrants(): { role: RoleKey; permission: string; grant: Grant }[] {
  const out: { role: RoleKey; permission: string; grant: Grant }[] = [];
  for (const role of Object.keys(ROLES) as RoleKey[]) {
    for (const permission of ALL_PERMISSION_KEYS) {
      const grant = grantFor(role, permission);
      if (grant) out.push({ role, permission, grant });
    }
  }
  return out;
}

/** Renders the project matrix as Markdown table rows, in the documented format. */
export function renderProjectMatrix(): string[] {
  return PROJECT_MATRIX.map(
    (r) => `| ${r.label} | ${PROJECT_MATRIX_ROLES.map((role) => r.cells[role]?.show ?? '').join(' | ')} |`,
  );
}

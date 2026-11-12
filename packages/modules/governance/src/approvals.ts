import {
  and,
  appendAudit,
  approvalDecisions,
  approvalPolicies,
  approvalRequests,
  eq,
  projectMemberships,
  roles,
  sql,
  type Db,
  type Tx,
} from '@qos/db';
import { isRoleKey, projectRoleOf, type Principal, type RoleKey } from '@qos/identity';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { notify } from './notifications.js';

/** Actions that can be put behind an approval (M14-FR-04). A fixed vocabulary on purpose. */
export const APPROVAL_ACTIONS = [
  'requirement.approve',
  'testcase.approve',
  'defect.external.create',
  'defect.external.transition',
  'visual.baseline.approve',
  'codegen.pr.open',
  'run.production',
  'ai.budget.increase',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export const isApprovalAction = (v: unknown): v is ApprovalAction =>
  typeof v === 'string' && (APPROVAL_ACTIONS as readonly string[]).includes(v);

/**
 * The whole rule language (M14 risk mitigation: "a small fixed rule vocabulary, no general rule
 * language"). Separation of duties is always on; `allowSelfApproval` is the single-person
 * override of BR-M14-2 and only takes effect when the project has exactly one eligible approver.
 */
export interface ApprovalRules {
  readonly approverRoles: readonly RoleKey[];
  readonly approvalsRequired: number;
  readonly allowSelfApproval: boolean;
  readonly expiresInHours: number;
}

const DEFAULT_RULES: Readonly<Record<ApprovalAction, ApprovalRules>> = {
  'requirement.approve': {
    approverRoles: ['qa_lead', 'qc_reviewer'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 168,
  },
  'testcase.approve': {
    approverRoles: ['qa_lead', 'qc_reviewer'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 168,
  },
  'defect.external.create': {
    approverRoles: ['qa_lead'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 72,
  },
  'defect.external.transition': {
    approverRoles: ['qa_lead'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 72,
  },
  'visual.baseline.approve': {
    approverRoles: ['qa_lead', 'qc_reviewer'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 168,
  },
  'codegen.pr.open': {
    approverRoles: ['qa_lead'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 72,
  },
  'run.production': {
    approverRoles: ['qa_lead'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 4,
  },
  'ai.budget.increase': {
    approverRoles: ['qa_lead'],
    approvalsRequired: 1,
    allowSelfApproval: false,
    expiresInHours: 72,
  },
};

export function validateRules(input: unknown): ApprovalRules {
  const r = input as Partial<ApprovalRules> | null;
  const approverRoles = Array.isArray(r?.approverRoles) ? r!.approverRoles : [];
  if (approverRoles.length === 0 || approverRoles.some((x) => !isRoleKey(x) || x === 'platform_admin')) {
    throw new DomainError('approval.rules_invalid', { field: 'approverRoles' });
  }
  const approvalsRequired = Number(r?.approvalsRequired);
  if (!Number.isInteger(approvalsRequired) || approvalsRequired < 1 || approvalsRequired > 5) {
    throw new DomainError('approval.rules_invalid', { field: 'approvalsRequired' });
  }
  const expiresInHours = Number(r?.expiresInHours);
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 24 * 30) {
    throw new DomainError('approval.rules_invalid', { field: 'expiresInHours' });
  }
  return {
    approverRoles: [...new Set(approverRoles)],
    approvalsRequired,
    allowSelfApproval: r?.allowSelfApproval === true,
    expiresInHours,
  };
}

export async function getPolicy(db: Db | Tx, projectId: string, action: ApprovalAction) {
  const [row] = await db
    .select()
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.projectId, projectId), eq(approvalPolicies.action, action)));
  return row
    ? { action, version: row.version, rules: validateRules(row.rules), isDefault: false }
    : { action, version: 0, rules: DEFAULT_RULES[action], isDefault: true };
}

export async function listPolicies(db: Db, projectId: string) {
  return Promise.all(APPROVAL_ACTIONS.map((a) => getPolicy(db, projectId, a)));
}

export async function setPolicy(
  db: Db,
  actor: Principal,
  projectId: string,
  action: ApprovalAction,
  input: unknown,
) {
  const rules = validateRules(input);
  return db.transaction(async (tx) => {
    const current = await getPolicy(tx, projectId, action);
    const version = current.version + 1;
    await tx
      .insert(approvalPolicies)
      .values({ projectId, action, rules, version, updatedBy: actor.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [approvalPolicies.projectId, approvalPolicies.action],
        set: { rules, version, updatedBy: actor.userId, updatedAt: new Date() },
      });
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'approval.policy.changed',
      targetType: 'approval_policy',
      targetId: `${projectId}:${action}`,
      summary: { action, version, rules: { ...rules } },
      source: 'api',
    });
    return { action, version, rules, isDefault: false };
  });
}

/** Members of the project holding one of the approver roles. */
async function eligibleApprovers(db: Db | Tx, projectId: string, rules: ApprovalRules): Promise<string[]> {
  const rows = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .innerJoin(roles, eq(roles.id, projectMemberships.roleId))
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        sql`${roles.key} in (${sql.join(
          rules.approverRoles.map((r) => sql`${r}`),
          sql`, `,
        )})`,
      ),
    );
  return rows.map((r) => r.userId);
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'invalidated' | 'expired';

export interface ApprovalRequestView {
  readonly id: string;
  readonly projectId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly contentHash: string;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly approvalsRequired: number;
  readonly approvals: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

type ReqRow = typeof approvalRequests.$inferSelect;
async function view(db: Db | Tx, r: ReqRow): Promise<ApprovalRequestView> {
  const n = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from governance.approval_decisions where request_id = ${r.id} and decision = 'approve'`,
  );
  return {
    id: r.id,
    projectId: r.projectId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    contentHash: r.contentHash,
    status: r.status as ApprovalStatus,
    requestedBy: r.requestedBy,
    approvalsRequired: (r.rules as ApprovalRules).approvalsRequired,
    approvals: n.rows[0]?.n ?? 0,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

export interface RequestApprovalInput {
  readonly projectId: string;
  readonly action: ApprovalAction;
  readonly targetType: string;
  readonly targetId: string;
  /** Hash of the exact content being approved (BR-M14-3). */
  readonly contentHash: string;
}

/**
 * Opens an approval request in the caller's transaction. A pending request for the same target
 * and the same content is returned as is; one for different content is invalidated first
 * (M14-AC-04). Eligible approvers are notified in the app.
 */
export async function requestApproval(
  tx: Tx,
  actor: Principal,
  input: RequestApprovalInput,
  now: Date = new Date(),
): Promise<ApprovalRequestView> {
  if (!/^[a-f0-9]{16,128}$/.test(input.contentHash)) throw new DomainError('approval.content_hash_invalid');
  const policy = await getPolicy(tx, input.projectId, input.action);
  const [pending] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.projectId, input.projectId),
        eq(approvalRequests.action, input.action),
        eq(approvalRequests.targetType, input.targetType),
        eq(approvalRequests.targetId, input.targetId),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .for('update');
  if (pending && pending.contentHash === input.contentHash && pending.expiresAt > now)
    return view(tx, pending);
  if (pending) {
    await tx
      .update(approvalRequests)
      .set({ status: pending.expiresAt > now ? 'invalidated' : 'expired', decidedAt: now })
      .where(and(eq(approvalRequests.id, pending.id), eq(approvalRequests.status, 'pending')));
  }
  const id = uuidv7();
  const [row] = await tx
    .insert(approvalRequests)
    .values({
      id,
      projectId: input.projectId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      contentHash: input.contentHash,
      policyVersion: policy.version,
      rules: policy.rules,
      requestedBy: actor.userId,
      status: 'pending',
      expiresAt: new Date(now.getTime() + policy.rules.expiresInHours * 3_600_000),
      createdAt: now,
    })
    .returning();
  await appendAudit(tx, {
    orgId: actor.orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: actor.userId,
    action: 'approval.requested',
    targetType: input.targetType,
    targetId: input.targetId,
    summary: {
      requestId: id,
      action: input.action,
      policyVersion: policy.version,
      replaced: pending?.id ?? null,
    },
    source: 'api',
  });
  await appendOutbox(tx, {
    type: 'approval.requested',
    aggregateType: 'approval_request',
    aggregateId: id,
    projectId: input.projectId,
    payload: { action: input.action, targetType: input.targetType, targetId: input.targetId },
  });
  for (const userId of await eligibleApprovers(tx, input.projectId, policy.rules)) {
    if (userId === actor.userId && !policy.rules.allowSelfApproval) continue;
    await notify(tx, {
      userId,
      projectId: input.projectId,
      type: 'approval.requested',
      payload: {
        requestId: id,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
      },
      dedupeKey: `approval.requested:${id}`,
    });
  }
  return view(tx, row!);
}

/** Invalidates pending requests whose target changed (M14-AC-04). Call it in the edit transaction. */
export async function invalidateApprovals(
  tx: Tx,
  projectId: string,
  targetType: string,
  targetId: string,
  newContentHash: string,
): Promise<number> {
  const res = await tx
    .update(approvalRequests)
    .set({ status: 'invalidated', decidedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.projectId, projectId),
        eq(approvalRequests.targetType, targetType),
        eq(approvalRequests.targetId, targetId),
        eq(approvalRequests.status, 'pending'),
        sql`${approvalRequests.contentHash} <> ${newContentHash}`,
      ),
    )
    .returning({ id: approvalRequests.id });
  return res.length;
}

export interface DecideInput {
  readonly requestId: string;
  readonly decision: 'approve' | 'reject';
  readonly comment?: string | null;
}

/**
 * Records one decision. Checks, in order: request pending and not expired; actor holds an approver
 * role in the project; separation of duties (BR-M14-2); one decision per approver. When the count
 * is reached, the request moves to `approved` exactly once (expected-state update), even under
 * concurrent approvals (M14 §14).
 */
export async function decide(
  db: Db,
  actor: Principal,
  input: DecideInput,
  now: Date = new Date(),
): Promise<ApprovalRequestView> {
  const outcome = await db.transaction(async (tx): Promise<ApprovalRequestView | 'expired'> => {
    const [req] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, input.requestId))
      .for('update');
    if (!req) throw new DomainError('approval.not_found');
    const role = await projectRoleOf(tx, req.projectId, actor.userId);
    const rules = req.rules as ApprovalRules;
    // Someone with no role in the project must not even learn the request exists.
    if (!role) throw new DomainError('approval.not_found');
    if (req.status !== 'pending') throw new DomainError('approval.not_pending', { status: req.status });
    if (req.expiresAt <= now) {
      await tx
        .update(approvalRequests)
        .set({ status: 'expired', decidedAt: now })
        .where(eq(approvalRequests.id, req.id));
      // Returned, not thrown: the status change must commit before the caller gets the error.
      return 'expired';
    }
    if (!rules.approverRoles.includes(role)) throw new DomainError('approval.not_eligible');
    let selfApproval = false;
    if (actor.userId === req.requestedBy) {
      const approvers = await eligibleApprovers(tx, req.projectId, rules);
      const soleApprover = approvers.length === 1 && approvers[0] === actor.userId;
      if (!rules.allowSelfApproval || !soleApprover) throw new DomainError('approval.separation_of_duties');
      selfApproval = true;
    }
    const inserted = await tx
      .insert(approvalDecisions)
      .values({
        requestId: req.id,
        approverId: actor.userId,
        decision: input.decision,
        comment: input.comment?.slice(0, 2000) ?? null,
        selfApproval,
        at: now,
      })
      .onConflictDoNothing()
      .returning({ requestId: approvalDecisions.requestId });
    if (inserted.length === 0) throw new DomainError('approval.already_decided');

    let finalStatus: ApprovalStatus | null = null;
    if (input.decision === 'reject') {
      finalStatus = 'rejected';
    } else {
      const approvals = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from governance.approval_decisions where request_id = ${req.id} and decision = 'approve'`,
      );
      if ((approvals.rows[0]?.n ?? 0) >= rules.approvalsRequired) finalStatus = 'approved';
    }
    let updated = req;
    if (finalStatus) {
      const [u] = await tx
        .update(approvalRequests)
        .set({ status: finalStatus, decidedAt: now })
        .where(and(eq(approvalRequests.id, req.id), eq(approvalRequests.status, 'pending')))
        .returning();
      if (u) {
        updated = u;
        await appendOutbox(tx, {
          type: 'approval.decided',
          aggregateType: 'approval_request',
          aggregateId: req.id,
          projectId: req.projectId,
          payload: {
            action: req.action,
            status: finalStatus,
            targetType: req.targetType,
            targetId: req.targetId,
          },
        });
        await notify(tx, {
          userId: req.requestedBy,
          projectId: req.projectId,
          type: 'approval.decided',
          payload: { requestId: req.id, action: req.action, status: finalStatus },
          dedupeKey: `approval.decided:${req.id}`,
        });
      }
    }
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: req.projectId,
      actorType: 'user',
      actorId: actor.userId,
      action: `approval.${input.decision}d`,
      targetType: req.targetType,
      targetId: req.targetId,
      summary: {
        requestId: req.id,
        action: req.action,
        selfApproval,
        resultingStatus: finalStatus ?? 'pending',
      },
      source: 'api',
    });
    return view(tx, updated);
  });
  if (outcome === 'expired') throw new DomainError('approval.not_pending', { status: 'expired' });
  return outcome;
}

/** Pending requests the user can decide: eligible role, and not their own unless self-approval applies. */
export async function myApprovals(db: Db, actor: Principal): Promise<ApprovalRequestView[]> {
  const rows = await db
    .select({ req: approvalRequests, role: roles.key })
    .from(approvalRequests)
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, approvalRequests.projectId),
        eq(projectMemberships.userId, actor.userId),
      ),
    )
    .innerJoin(roles, eq(roles.id, projectMemberships.roleId))
    .where(and(eq(approvalRequests.status, 'pending'), sql`${approvalRequests.expiresAt} > now()`))
    .orderBy(approvalRequests.createdAt);
  const out: ApprovalRequestView[] = [];
  for (const { req, role } of rows) {
    const rules = req.rules as ApprovalRules;
    if (!isRoleKey(role) || !rules.approverRoles.includes(role)) continue;
    if (req.requestedBy === actor.userId && !rules.allowSelfApproval) continue;
    out.push(await view(db, req));
  }
  return out;
}

export async function getApprovalRequest(db: Db, id: string): Promise<ApprovalRequestView | null> {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row ? view(db, row) : null;
}

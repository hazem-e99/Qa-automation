import { and, eq, inArray, operations, type DbOrTx } from '@qos/db';
import { uuidv7 } from '@qos/kernel-domain';

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const TERMINAL_STATUSES: readonly OperationStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isTerminal = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

export interface OperationView {
  readonly id: string;
  readonly type: string;
  readonly status: OperationStatus;
  readonly progress: number;
  readonly resultRef: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
}

export async function createOperation(
  db: DbOrTx,
  input: { type: string; createdBy: string; projectId?: string | null },
): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await db.insert(operations).values({
    id,
    projectId: input.projectId ?? null,
    type: input.type,
    status: 'queued',
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * Moves an operation forward with an expected-state check (doc 22 §4, rule 1): the update only
 * applies when the current status is one of `from`. Returns false when nothing changed, which a
 * redelivered job treats as "already done".
 */
export async function transitionOperation(
  db: DbOrTx,
  id: string,
  from: readonly OperationStatus[],
  to: { status: OperationStatus; progress?: number; resultRef?: string | null; error?: string | null },
): Promise<boolean> {
  const updated = await db
    .update(operations)
    .set({
      status: to.status,
      ...(to.progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(to.progress))) } : {}),
      ...(to.resultRef !== undefined ? { resultRef: to.resultRef } : {}),
      // Error text is shown to users: keep it to a stable code, never a stack trace.
      ...(to.error !== undefined ? { error: to.error?.slice(0, 200) ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(operations.id, id), inArray(operations.status, [...from])))
    .returning({ id: operations.id });
  return updated.length === 1;
}

export async function getOperation(db: DbOrTx, id: string): Promise<OperationView | null> {
  const [row] = await db.select().from(operations).where(eq(operations.id, id));
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status as OperationStatus,
    progress: row.progress,
    resultRef: row.resultRef,
    error: row.error,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Who may see an operation: its creator, or readers of its project. For access checks only. */
export async function operationOwner(
  db: DbOrTx,
  id: string,
): Promise<{ projectId: string | null; createdBy: string } | null> {
  const [row] = await db
    .select({ projectId: operations.projectId, createdBy: operations.createdBy })
    .from(operations)
    .where(eq(operations.id, id));
  return row ?? null;
}

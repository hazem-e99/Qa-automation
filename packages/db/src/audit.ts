import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@qos/kernel-domain';
import { currentCorrelationId } from '@qos/observability';
import type { Tx } from './client.js';
import { auditEvents } from './schema/governance.js';

export interface AuditInput {
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly actorType: 'user' | 'system' | 'automation';
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** Must already be redacted by the caller: no secrets, no raw document content. */
  readonly summary: Record<string, unknown>;
  readonly source: 'api' | 'worker' | 'controller' | 'system';
  readonly ip?: string | null;
  readonly ua?: string | null;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Canonical JSON: object keys sorted, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function auditHash(prevHash: string, row: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonicalJson(row)).digest('hex');
}

/**
 * Appends one audit event inside the caller's transaction and links it to the previous one
 * (hash chain). A transaction-scoped advisory lock serializes writers so the chain has one order.
 * That lock is a deliberate throughput limit; it is acceptable for the pilot and revisited in P11.
 */
export async function appendAudit(tx: Tx, input: AuditInput): Promise<{ id: string; hash: string }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('governance.audit_chain'))`);
  const last = await tx.execute<{ hash: string }>(
    sql`select hash from governance.audit_events order by created_at desc, id desc limit 1`,
  );
  const prevHash = last.rows[0]?.hash ?? GENESIS_HASH;
  const id = uuidv7();
  const createdAt = new Date();
  const body = {
    id,
    orgId: input.orgId ?? null,
    projectId: input.projectId ?? null,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    summary: input.summary,
    source: input.source,
    correlationId: currentCorrelationId(),
    createdAt: createdAt.toISOString(),
  };
  const hash = auditHash(prevHash, body);
  await tx.insert(auditEvents).values({
    ...body,
    ip: input.ip ?? null,
    ua: input.ua ?? null,
    createdAt,
    prevHash,
    hash,
  });
  return { id, hash };
}

/** Recomputes the chain in order. Returns the id of the first broken link, or null when intact. */
export async function verifyAuditChain(tx: Tx): Promise<{ checked: number; brokenAt: string | null }> {
  const rows = await tx.select().from(auditEvents).orderBy(auditEvents.createdAt, auditEvents.id);
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const body = {
      id: r.id,
      orgId: r.orgId,
      projectId: r.projectId,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      summary: r.summary,
      source: r.source,
      correlationId: r.correlationId,
      createdAt: r.createdAt.toISOString(),
    };
    if (r.prevHash !== prev || r.hash !== auditHash(prev, body))
      return { checked: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { checked: rows.length, brokenAt: null };
}

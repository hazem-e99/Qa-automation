import { createHash } from 'node:crypto';
import { and, canonicalJson, eq, idempotencyKeys, sql, type Db, type Tx } from '@qos/db';
import { DomainError } from '@qos/kernel-domain';

export interface IdempotentResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface IdempotencyOptions {
  readonly scope: string;
  readonly key: string;
  /** The request content. The same key with different content is rejected. */
  readonly request: unknown;
  /** How long the stored response is replayed. Default 24 h (doc 22 §4). */
  readonly ttlSeconds?: number;
}

export interface IdempotentResult extends IdempotentResponse {
  /** True when the response comes from an earlier, committed execution. */
  readonly replayed: boolean;
}

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const isValidIdempotencyKey = (key: unknown): key is string =>
  typeof key === 'string' && KEY_RE.test(key);

export const requestHash = (request: unknown): string =>
  createHash('sha256').update(canonicalJson(request)).digest('hex');

/**
 * Runs `effect` at most once per (scope, key).
 *
 * The idempotency row and the effect share one transaction: either both commit, or neither does.
 * A concurrent request with the same key blocks on the primary key until the first one finishes,
 * then replays its response. If the effect throws, nothing is stored and the key can be retried.
 */
export async function withIdempotency(
  db: Db,
  opts: IdempotencyOptions,
  effect: (tx: Tx) => Promise<IdempotentResponse>,
): Promise<IdempotentResult> {
  if (!isValidIdempotencyKey(opts.key)) throw new DomainError('idempotency.key_invalid');
  const hash = requestHash(opts.request);
  const ttlMs = (opts.ttlSeconds ?? 24 * 3600) * 1000;
  const where = and(eq(idempotencyKeys.scope, opts.scope), eq(idempotencyKeys.key, opts.key));

  return db.transaction(async (tx) => {
    // Expired records are removed first so the key becomes usable again.
    await tx.execute(
      sql`delete from platform.idempotency_keys where scope = ${opts.scope} and key = ${opts.key} and expires_at < now()`,
    );
    const now = new Date();
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({
        scope: opts.scope,
        key: opts.key,
        requestHash: hash,
        status: 'in_progress',
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [existing] = await tx.select().from(idempotencyKeys).where(where);
      if (!existing) throw new DomainError('idempotency.retry'); // vanished between the two statements
      if (existing.requestHash !== hash) throw new DomainError('idempotency.key_reused');
      if (existing.status !== 'done' || existing.responseStatus == null) {
        throw new DomainError('idempotency.in_progress');
      }
      return { status: existing.responseStatus, body: existing.response, replayed: true };
    }

    const response = await effect(tx);
    await tx
      .update(idempotencyKeys)
      .set({ status: 'done', responseStatus: response.status, response: response.body ?? null })
      .where(where);
    return { ...response, replayed: false };
  });
}

/** Housekeeping, called by a scheduled job in a later phase. Returns the number of rows removed. */
export async function purgeExpiredIdempotencyKeys(db: Db): Promise<number> {
  const res = await db.execute(sql`delete from platform.idempotency_keys where expires_at < now()`);
  return res.rowCount ?? 0;
}

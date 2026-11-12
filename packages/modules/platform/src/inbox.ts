import { eq, inboxMessages, sql, type Db, type Tx } from '@qos/db';
import { uuidv7 } from '@qos/kernel-domain';
import type { Logger } from '@qos/observability';

/** Only these headers are ever stored; everything else (cookies, authorization) is dropped. */
const HEADER_ALLOWLIST = ['content-type', 'user-agent', 'x-request-id'];

export interface InboundMessage {
  readonly connectionId: string;
  /** Provider delivery id, or a hash of the payload when the provider sends none. */
  readonly dedupeKey: string;
  readonly eventType: string;
  readonly verification: 'ok' | 'unsigned_accepted';
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly bodyRef?: string | null;
}

export function allowlistedHeaders(headers: InboundMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) {
    const v = headers[name];
    if (typeof v === 'string') out[name] = v.slice(0, 500);
  }
  return out;
}

/**
 * Stores an inbound delivery. A redelivery with the same (connection, dedupe key) is detected by
 * the unique index and reported as a duplicate without writing anything.
 */
export async function receiveInboxMessage(
  db: Db | Tx,
  msg: InboundMessage,
): Promise<{ id: string | null; duplicate: boolean }> {
  const id = uuidv7();
  const inserted = await db
    .insert(inboxMessages)
    .values({
      id,
      connectionId: msg.connectionId,
      dedupeKey: msg.dedupeKey,
      eventType: msg.eventType,
      receivedAt: new Date(),
      verification: msg.verification,
      headers: allowlistedHeaders(msg.headers),
      bodyRef: msg.bodyRef ?? null,
      status: 'pending',
    })
    .onConflictDoNothing()
    .returning({ id: inboxMessages.id });
  return inserted.length === 1 ? { id, duplicate: false } : { id: null, duplicate: true };
}

/**
 * Records a delivery that is not processed: a redelivery (`duplicate`) or one that failed
 * verification (`failed`, verification `rejected`). Each gets its own row so counts stay visible
 * (M03-AC-02), with a unique marker key so it never collides with the real message.
 */
export async function recordInboxMarker(
  db: Db | Tx,
  msg: {
    connectionId: string;
    dedupeKey: string;
    eventType: string;
    kind: 'duplicate' | 'rejected';
    headers: InboundMessage['headers'];
    reason?: string;
  },
): Promise<string> {
  const id = uuidv7();
  await db.insert(inboxMessages).values({
    id,
    connectionId: msg.connectionId,
    dedupeKey: `${msg.dedupeKey.slice(0, 300)}#${msg.kind}-${id}`,
    eventType: msg.eventType.slice(0, 100),
    receivedAt: new Date(),
    verification: msg.kind === 'rejected' ? 'rejected' : 'ok',
    headers: allowlistedHeaders(msg.headers),
    status: msg.kind === 'rejected' ? 'failed' : 'duplicate',
    processedAt: new Date(),
    error: msg.reason?.slice(0, 100) ?? null,
  });
  return id;
}

export type InboxOutcome = 'processed' | 'stale' | 'ignored_out_of_scope';
export interface InboxRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly eventType: string;
  readonly bodyRef: string | null;
}
/** Runs inside the processor's transaction. Must be idempotent: a crash after it may run it again. */
export type InboxHandler = (message: InboxRecord, tx: Tx) => Promise<InboxOutcome>;

export interface InboxProcessorOptions {
  readonly db: Db;
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
}

/**
 * Generic inbox processor skeleton (T-P1-08). Provider-specific handlers register per event type
 * in P2+. Each message is claimed with SKIP LOCKED in its own transaction; a failing message is
 * retried up to `maxAttempts` and then parked as `failed`.
 */
export class InboxProcessor {
  private readonly handlers = new Map<string, InboxHandler>();

  constructor(private readonly opts: InboxProcessorOptions) {}

  register(eventType: string, handler: InboxHandler): void {
    this.handlers.set(eventType, handler);
  }

  /** Processes pending messages once. Returns how many reached a final status. */
  async drain(): Promise<number> {
    const { db, logger } = this.opts;
    const maxAttempts = this.opts.maxAttempts ?? 5;
    const pending = await db.execute<{ id: string }>(
      sql`select id from platform.inbox_messages where status = 'pending' order by received_at, id limit ${this.opts.batchSize ?? 50}`,
    );
    let finished = 0;
    for (const { id } of pending.rows) {
      try {
        const done = await db.transaction(async (tx) => {
          const claimed = await tx.execute<{ id: string }>(
            sql`select id from platform.inbox_messages where id = ${id} and status = 'pending' for update skip locked`,
          );
          if (claimed.rows.length === 0) return false;
          const [row] = await tx.select().from(inboxMessages).where(eq(inboxMessages.id, id));
          if (!row) return false;
          const handler = this.handlers.get(row.eventType);
          const outcome: InboxOutcome = handler
            ? await handler(
                {
                  id: row.id,
                  connectionId: row.connectionId,
                  eventType: row.eventType,
                  bodyRef: row.bodyRef,
                },
                tx,
              )
            : 'ignored_out_of_scope';
          await tx
            .update(inboxMessages)
            .set({ status: outcome, processedAt: new Date(), error: null })
            .where(eq(inboxMessages.id, id));
          return true;
        });
        if (done) finished++;
      } catch (err) {
        logger.error({ err, inboxId: id }, 'inbox handler failed');
        // Recorded outside the failed transaction, so the attempt count survives the rollback.
        const res = await db.execute<{ status: string }>(
          sql`update platform.inbox_messages
              set attempts = attempts + 1,
                  status = case when attempts + 1 >= ${maxAttempts} then 'failed' else 'pending' end,
                  error = 'handler_error'
              where id = ${id} and status = 'pending'
              returning status`,
        );
        if (res.rows[0]?.status === 'failed') finished++;
      }
    }
    return finished;
  }
}

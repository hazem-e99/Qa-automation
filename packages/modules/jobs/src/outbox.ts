import pg from 'pg';
import { and, eq, isNull, outboxEvents, sql, type Db, type Tx } from '@qos/db';
import { uuidv7, type DomainEvent } from '@qos/kernel-domain';
import { currentCorrelationId, runWithCorrelation, type Logger } from '@qos/observability';

export interface NewEvent {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly projectId?: string | null;
  readonly payload: Record<string, unknown>;
}

/** Records a domain event in the caller's transaction. It becomes visible only if that transaction commits. */
export async function appendOutbox(tx: Tx, event: NewEvent): Promise<string> {
  const id = uuidv7();
  await tx.insert(outboxEvents).values({
    id,
    projectId: event.projectId ?? null,
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredAt: new Date(),
    correlationId: currentCorrelationId(),
  });
  return id;
}

/**
 * Internal subscriber. It runs inside the dispatcher's transaction, so anything it writes through
 * `tx` (typically: enqueue a job) commits together with marking the event as dispatched.
 * It can still run more than once for one event, so it must be idempotent.
 */
export type EventSubscriber = (event: DomainEvent<Record<string, unknown>>, tx: Tx) => Promise<void>;

export interface OutboxDispatcherOptions {
  readonly db: Db;
  readonly connectionString: string;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
}

/**
 * Outbox dispatcher skeleton (T-P1-07): internal subscribers only. Delivery to the workflow
 * orchestrator is added in P7. Wakes up on LISTEN/NOTIFY and also polls as a safety net.
 */
export class OutboxDispatcher {
  private readonly subscribers = new Map<string, { name: string; handler: EventSubscriber }[]>();
  private listener: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<number> | null = null;
  private again = false;
  private running = false;

  constructor(private readonly opts: OutboxDispatcherOptions) {}

  subscribe(eventType: string, name: string, handler: EventSubscriber): void {
    const list = this.subscribers.get(eventType) ?? [];
    list.push({ name, handler });
    this.subscribers.set(eventType, list);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connectListener();
    this.timer = setInterval(() => void this.kick(), this.opts.pollIntervalMs ?? 5_000);
    this.timer.unref();
    void this.kick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => undefined);
    await this.draining?.catch(() => undefined);
  }

  /** Dispatches everything currently pending. Returns the number of events marked dispatched. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.drainBatch();
      total += n.dispatched;
      if (n.seen < (this.opts.batchSize ?? 50) || n.dispatched === 0) return total;
    }
  }

  private async kick(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return;
    }
    do {
      this.again = false;
      this.draining = this.drain();
      try {
        await this.draining;
      } catch (err) {
        this.opts.logger.error({ err }, 'outbox drain failed');
      } finally {
        this.draining = null;
      }
    } while (this.again && this.running);
  }

  private async connectListener(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: 'qos-outbox-listen',
    });
    client.on('notification', () => void this.kick());
    client.on('error', (err) => {
      this.opts.logger.warn({ err }, 'outbox listener lost; polling continues');
      if (this.listener === client) this.listener = null;
      if (this.running) setTimeout(() => void this.connectListener().catch(() => undefined), 5_000).unref();
    });
    await client.connect();
    await client.query('listen qos_outbox');
    this.listener = client;
  }

  private async drainBatch(): Promise<{ seen: number; dispatched: number }> {
    const { db } = this.opts;
    const pending = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
      .orderBy(outboxEvents.occurredAt, outboxEvents.id)
      .limit(this.opts.batchSize ?? 50);
    let dispatched = 0;
    for (const { id } of pending) {
      try {
        // One transaction per event: a failing event does not block the others.
        const done = await db.transaction(async (tx) => {
          const claimed = await tx.execute<{ id: string }>(
            sql`select id from platform.outbox_events where id = ${id} and dispatched_at is null for update skip locked`,
          );
          if (claimed.rows.length === 0) return false; // another dispatcher has it, or it is done
          const [row] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, id));
          if (!row) return false;
          const event: DomainEvent<Record<string, unknown>> = {
            eventId: row.id,
            type: row.type,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            projectId: row.projectId,
            occurredAt: row.occurredAt,
            correlationId: row.correlationId,
            payload: row.payload as Record<string, unknown>,
          };
          await runWithCorrelation(row.correlationId, async () => {
            for (const s of this.subscribers.get(row.type) ?? []) await s.handler(event, tx);
          });
          await tx
            .update(outboxEvents)
            .set({ dispatchedAt: new Date() })
            .where(and(eq(outboxEvents.id, id), isNull(outboxEvents.dispatchedAt)));
          return true;
        });
        if (done) dispatched++;
      } catch (err) {
        // The event stays undispatched and is retried on the next wake-up (at-least-once).
        this.opts.logger.error({ err, eventId: id }, 'outbox subscriber failed; event will be retried');
      }
    }
    return { seen: pending.length, dispatched };
  }
}

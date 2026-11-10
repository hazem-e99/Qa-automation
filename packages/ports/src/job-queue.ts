/**
 * JobQueue port (ADR-0006). Delivery is at-least-once: every handler must be idempotent.
 * `TTx` is the transaction handle of the persistence layer. The port does not name it, so
 * the domain stays free of infrastructure types.
 */
export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive' | 'key_strict_fifo';

export interface QueueDefinition {
  readonly name: string;
  readonly policy: QueuePolicy;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  readonly expireInSeconds: number;
  readonly deadLetter?: string;
}

export interface SendOptions<TTx> {
  /** When given, the job becomes visible only if this transaction commits. */
  readonly tx?: TTx;
  readonly singletonKey?: string;
  readonly startAfterSeconds?: number;
}

export interface Job<T> {
  readonly id: string;
  readonly queue: string;
  readonly data: T;
  readonly correlationId: string | null;
}

export type JobHandler<T> = (job: Job<T>) => Promise<void>;

export interface JobQueue<TTx = unknown> {
  /** Returns the job id, or null when a queue policy suppressed a duplicate. */
  send<T extends object>(queue: string, data: T, options?: SendOptions<TTx>): Promise<string | null>;
  work<T extends object>(queue: string, handler: JobHandler<T>): Promise<void>;
}

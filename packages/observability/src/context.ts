import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from '@qos/kernel-domain';

export interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with a correlation id that the logger and the job/outbox writers pick up (HTTP → jobs → events). */
export function runWithCorrelation<T>(correlationId: string | null | undefined, fn: () => T): T {
  return storage.run({ correlationId: sanitizeCorrelationId(correlationId) ?? uuidv7() }, fn);
}

export const currentCorrelationId = (): string | null => storage.getStore()?.correlationId ?? null;

/** Accepts only short, log-safe ids from callers; anything else is replaced. */
export function sanitizeCorrelationId(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : null;
}

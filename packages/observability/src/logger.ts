import { pino, type DestinationStream, type Logger } from 'pino';
import { currentCorrelationId } from './context.js';

/** Keys whose values never reach the logs, at any depth up to 4 (doc 22 §2). */
const SECRET_KEYS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'accessToken',
  'refreshToken',
  'privateKey',
  'connectionString',
];
export const REDACT_PATHS: string[] = SECRET_KEYS.flatMap((k) => [
  k,
  `*.${k}`,
  `*.*.${k}`,
  `*.*.*.${k}`,
]).concat(['req.headers.authorization', 'req.headers.cookie']);

const PATTERNS: readonly RegExp[] = [
  /\b(?:postgres(?:ql)?|https?):\/\/[^\s:@/]+:[^\s@/]+@/gi, // credentials inside URLs
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
];

/** Second line of defence for secrets embedded in free text (messages, error strings). */
export function scrub(text: string): string {
  return PATTERNS.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
  readonly destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      base: { service: opts.service },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin: () => {
        const correlationId = currentCorrelationId();
        return correlationId ? { correlationId } : {};
      },
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map((a) => (typeof a === 'string' ? scrub(a) : a));
          method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
      serializers: {
        err: (e: unknown) => {
          const s = pino.stdSerializers.err(e as Error);
          return {
            ...s,
            message: scrub(String(s.message ?? '')),
            stack: s.stack ? scrub(s.stack) : undefined,
          };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    opts.destination,
  );
}

export type { Logger };

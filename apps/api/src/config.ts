import { BaseConfig, port } from '@qos/kernel-infra';
import { z } from 'zod';

export const ApiConfig = BaseConfig.extend({
  API_PORT: port(3001),
  /** Bind address. Loopback by default; the Compose service sets 0.0.0.0 inside its container. */
  API_HOST: z.string().default('127.0.0.1'),
  /** Per-client rate limit (doc 21 §rate limiting): tokens per second and burst size. */
  RATE_LIMIT_RPS: z.coerce.number().positive().max(10_000).default(20),
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(60),
  /** Root directory of the local object storage adapter. */
  STORAGE_DIR: z.string().min(1).default('./var/storage'),
  /** Secret for signed file links. When unset, the /files endpoint answers 404. */
  FILE_URL_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  /** Registers the mock providers (labelled Demo). Never enable on an installation with real data. */
  QOS_DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** File holding the 32-byte master key of the secret store. Required in production. */
  QOS_MASTER_KEY_FILE: z.string().min(1).optional(),
  /** Token for the one-time first-run setup endpoint. When unset, setup answers 404. */
  SETUP_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
  /** `Secure` flag on the session cookie. Off only for plain-HTTP local development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Login attempts allowed per minute, per account and per client address (doc 21). */
  LOGIN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(5),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(480),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /** Upper bound on concurrently open SSE streams in this process. */
  SSE_MAX_STREAMS: z.coerce.number().int().min(1).max(10_000).default(200),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

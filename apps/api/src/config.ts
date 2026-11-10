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
  /** Upper bound on concurrently open SSE streams in this process. */
  SSE_MAX_STREAMS: z.coerce.number().int().min(1).max(10_000).default(200),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

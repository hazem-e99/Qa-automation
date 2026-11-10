import { z } from 'zod';

/** Settings shared by every backend process. Validated at boot; a bad value stops the process. */
export const BaseConfig = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  APP_VERSION: z.string().default('0.0.0-dev'),
});
export type BaseConfig = z.infer<typeof BaseConfig>;

export const port = (def: number) => z.coerce.number().int().min(1).max(65535).default(def);

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses environment variables with a schema. The error names the variables that are wrong
 * but never prints their values, since a wrong value may still be a secret.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data;
}

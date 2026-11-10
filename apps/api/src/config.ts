import { BaseConfig, port } from '@qos/kernel-infra';
import { z } from 'zod';

export const ApiConfig = BaseConfig.extend({
  API_PORT: port(3001),
  /** Bind address. Loopback by default; the Compose service sets 0.0.0.0 inside its container. */
  API_HOST: z.string().default('127.0.0.1'),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

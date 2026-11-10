import { z } from 'zod';

export const CheckStatus = z.enum(['ok', 'fail']);
export const HealthResponse = z.object({
  service: z.string(),
  status: CheckStatus,
  version: z.string(),
  checks: z.record(z.string(), z.object({ status: CheckStatus, detail: z.string().optional() })),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

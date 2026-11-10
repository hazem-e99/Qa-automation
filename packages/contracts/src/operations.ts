import { z } from 'zod';
import { Uuid } from './common.js';

export const OperationStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const OperationResponse = z.object({
  id: Uuid,
  type: z.string(),
  status: OperationStatus,
  progress: z.number().int().min(0).max(100),
  resultRef: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OperationResponse = z.infer<typeof OperationResponse>;

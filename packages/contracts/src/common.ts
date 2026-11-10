import { z } from 'zod';

export const Uuid = z.uuid();

/** Error envelope: a stable code plus params; the UI localizes it (doc 20 §9). */
export const ApiError = z.object({
  code: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  correlationId: z.string().nullable(),
});
export type ApiError = z.infer<typeof ApiError>;

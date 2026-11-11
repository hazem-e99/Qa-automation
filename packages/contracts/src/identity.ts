import { z } from 'zod';
import { Uuid } from './common.js';

export const SetupRequest = z.object({
  orgName: z.string().trim().min(2).max(100),
  email: z.string().trim().max(320),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({
  email: z.string().max(320),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const MeResponse = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  orgRoles: z.array(z.string()),
  /** Send back in the `x-csrf-token` header on every state-changing request. */
  csrfToken: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const PermissionsResponse = z.object({
  org: z.array(z.string()),
});
export type PermissionsResponse = z.infer<typeof PermissionsResponse>;

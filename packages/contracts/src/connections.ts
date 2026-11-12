import { z } from 'zod';
import { Uuid } from './common.js';

export const AuthStrategy = z.enum([
  'pat',
  'github_app',
  'entra_client_credentials',
  'api_key',
  'basic',
  'none',
]);

export const CreateConnectionRequest = z.object({
  providerType: z.string().min(2).max(41),
  displayName: z.string().trim().min(2).max(80),
  authStrategy: AuthStrategy,
  baseUrl: z.string().max(500).nullish(),
  /** Write-only: accepted here, never returned by any endpoint. */
  credential: z.string().min(1).max(8192).nullish(),
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

export const RotateCredentialRequest = z.object({ credential: z.string().min(1).max(8192) });

export const ConnectionResponse = z.object({
  id: Uuid,
  providerType: z.string(),
  family: z.string(),
  displayName: z.string(),
  baseUrl: z.string().nullable(),
  authStrategy: AuthStrategy,
  hasCredential: z.boolean(),
  status: z.enum(['untested', 'active', 'degraded', 'auth_failed', 'retired']),
  isDemo: z.boolean(),
  lastTestedAt: z.iso.datetime().nullable(),
  credentialExpiresAt: z.iso.datetime().nullable(),
});
export type ConnectionResponse = z.infer<typeof ConnectionResponse>;

export const CapabilityResponse = z.object({
  capability: z.string(),
  ok: z.boolean(),
  detail: z.string().nullable(),
});

export const ConnectionTestResponse = z.object({
  connection: ConnectionResponse,
  ok: z.boolean(),
  errorKind: z.string().nullable(),
  capabilities: z.array(CapabilityResponse),
});

export const ProviderResponse = z.object({
  providerType: z.string(),
  family: z.string(),
  displayName: z.string(),
  adapterVersion: z.string(),
  capabilities: z.array(z.string()),
  authStrategies: z.array(AuthStrategy),
  demoOnly: z.boolean(),
});
export type ProviderResponse = z.infer<typeof ProviderResponse>;

export const RoleCheckResponse = z.object({
  ok: z.boolean(),
  familyMismatch: z.boolean(),
  missingRequired: z.array(z.string()),
  missingAnyOf: z.array(z.array(z.string())),
  missingOptional: z.array(z.string()),
});

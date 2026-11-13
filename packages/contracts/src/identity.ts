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

export const LoginResponse = z.union([
  z.object({ csrfToken: z.string() }),
  z.object({ mfaRequired: z.literal(true), challengeToken: z.string(), expiresAt: z.iso.datetime() }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MfaVerifyRequest = z.object({
  challengeToken: z.string().min(20).max(200),
  /** Six-digit TOTP code or a recovery code. */
  code: z.string().trim().min(6).max(20),
});
export const MfaCodeRequest = z.object({ code: z.string().trim().min(6).max(20) });
export const MfaDisableRequest = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(20),
});
export const MfaStatusResponse = z.object({
  enabled: z.boolean(),
  pending: z.boolean(),
  recoveryCodesLeft: z.number().int(),
});
export type MfaStatusResponse = z.infer<typeof MfaStatusResponse>;
export const MfaEnrollResponse = z.object({ secret: z.string(), otpauthUri: z.string() });
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponse>;
export const MfaRecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()) });
export type MfaRecoveryCodesResponse = z.infer<typeof MfaRecoveryCodesResponse>;

export const UserLocale = z.enum(['en', 'ar']);
export const UserResponse = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['invited', 'active', 'deactivated']),
  orgRoles: z.array(z.string()),
  locale: z.string(),
  timezone: z.string(),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type UserResponse = z.infer<typeof UserResponse>;

export const UpdateProfileRequest = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    locale: UserLocale,
    timezone: z.string().min(1).max(64),
  })
  .partial()
  .strict();
export const UpdateUserRequest = UpdateProfileRequest.extend({ orgAdmin: z.boolean().optional() }).strict();
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export const PasswordResetRequest = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(256),
});
/** A link that carries a single-use token. Shown once; the token is in the URL fragment. */
export const LinkResponse = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type LinkResponse = z.infer<typeof LinkResponse>;

export const CreateInvitationRequest = z
  .object({
    email: z.string().trim().max(320),
    displayName: z.string().trim().max(100).optional(),
    orgRole: z.literal('org_admin').nullable().optional(),
    projectKey: z.string().max(10).nullable().optional(),
    projectRole: z.string().max(40).nullable().optional(),
  })
  .strict();
export const InvitationResponse = z.object({
  id: Uuid,
  userId: Uuid,
  email: z.string(),
  orgRole: z.string().nullable(),
  projectId: Uuid.nullable(),
  projectRole: z.string().nullable(),
  status: z.enum(['pending', 'expired', 'accepted', 'revoked']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type InvitationResponse = z.infer<typeof InvitationResponse>;
export const InvitationCreatedResponse = z.object({ invitation: InvitationResponse, link: LinkResponse });
export type InvitationCreatedResponse = z.infer<typeof InvitationCreatedResponse>;
export const InvitationTokenRequest = z.object({ token: z.string().min(20).max(200) });
export const InvitationLookupResponse = z.object({
  email: z.string(),
  orgName: z.string(),
  displayName: z.string(),
  expiresAt: z.iso.datetime(),
});
export type InvitationLookupResponse = z.infer<typeof InvitationLookupResponse>;
export const AcceptInvitationRequest = z.object({
  token: z.string().min(20).max(200),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});

export const CreateServiceAccountRequest = z
  .object({ name: z.string().trim().min(3).max(50), description: z.string().max(500).optional() })
  .strict();
export const UpdateServiceAccountRequest = z
  .object({ status: z.enum(['active', 'disabled']).optional(), ownerUserId: Uuid.optional() })
  .strict();
export const ServiceAccountResponse = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  status: z.enum(['active', 'disabled']),
  owner: z.object({ id: Uuid, displayName: z.string(), active: z.boolean() }),
  needsReassignment: z.boolean(),
  activeTokens: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ServiceAccountResponse = z.infer<typeof ServiceAccountResponse>;
export const CreateApiTokenRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.string().max(60)).min(1).max(20),
    projectKeys: z.array(z.string().max(10)).max(50).nullable().optional(),
    expiresInDays: z.number().int().min(1).max(365),
  })
  .strict();
export const ApiTokenResponse = z.object({
  id: Uuid,
  serviceAccountId: Uuid,
  name: z.string(),
  display: z.string(),
  scopes: z.array(z.string()),
  projectIds: z.array(Uuid).nullable(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ApiTokenResponse = z.infer<typeof ApiTokenResponse>;
/** The token itself is returned only here, once. */
export const ApiTokenCreatedResponse = z.object({ token: z.string(), apiToken: ApiTokenResponse });
export type ApiTokenCreatedResponse = z.infer<typeof ApiTokenCreatedResponse>;

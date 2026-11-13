// Public surface of the identity module.
export {
  csrfTokenFor,
  csrfTokenMatches,
  DEFAULT_SESSION_POLICY,
  hashPassword,
  issueSession,
  login,
  logout,
  purgeExpiredSessions,
  resolveSession,
  setupFirstAdmin,
  type ClientInfo,
  type LoginResult,
  type MfaRequired,
  type SessionIssued,
  type Principal,
  type SessionPolicy,
  type SetupInput,
} from './application/auth.js';
export { authorize, orgPermissionsOf, projectPermissionsOf, type Decision } from './application/authorize.js';
export {
  addInitialProjectMember,
  listOrgAdmins,
  listProjectMembers,
  projectRoleOf,
  removeProjectMember,
  setProjectMember,
  type ProjectMember,
} from './application/memberships.js';
export { syncRbacCatalog } from './application/catalog.js';
export { assertPasswordAcceptable, normalizeEmail, PASSWORD_MIN_LENGTH } from './domain/password.js';
export {
  ALL_PERMISSION_KEYS,
  allGrants,
  grantFor,
  isPermissionKey,
  isProjectPermission,
  isRoleKey,
  ORG_PERMISSIONS,
  PROJECT_MATRIX_ROLES,
  renderProjectMatrix,
  ROLE_RANK,
  ROLES,
  type Grant,
  type RoleKey,
} from './domain/rbac.js';
export {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableOwnMfa,
  mfaStatus,
  resetUserMfa,
  verifyMfaLogin,
  type MfaStatus,
} from './application/mfa.js';
export {
  changeOwnPassword,
  completePasswordReset,
  createPasswordReset,
  deactivateUser,
  getUser,
  listUsers,
  reactivateUser,
  updateOwnProfile,
  updateUser,
  USER_LOCALES,
  type UserSummary,
} from './application/users.js';
export {
  acceptInvitation,
  createInvitation,
  INVITATION_HOURS,
  listInvitations,
  lookupInvitation,
  resendInvitation,
  revokeInvitation,
  type InvitationView,
} from './application/invitations.js';
export {
  createApiToken,
  createServiceAccount,
  getServiceAccount,
  listApiTokens,
  listServiceAccounts,
  resolveApiToken,
  revokeApiToken,
  updateServiceAccount,
  type ApiTokenView,
  type ServiceAccountView,
  type TokenPrincipal,
} from './application/api-tokens.js';
export { isTokenScope, TOKEN_MAX_DAYS, TOKEN_SCOPES, type TokenScope } from './domain/api-token.js';

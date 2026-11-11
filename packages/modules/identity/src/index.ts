// Public surface of the identity module.
export {
  csrfTokenFor,
  csrfTokenMatches,
  DEFAULT_SESSION_POLICY,
  hashPassword,
  login,
  logout,
  purgeExpiredSessions,
  resolveSession,
  setupFirstAdmin,
  type ClientInfo,
  type LoginResult,
  type Principal,
  type SessionPolicy,
  type SetupInput,
} from './application/auth.js';
export { authorize, orgPermissionsOf, projectPermissionsOf, type Decision } from './application/authorize.js';
export {
  addInitialProjectMember,
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

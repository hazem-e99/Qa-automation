import { and, eq, projectMemberships, roles, type Db } from '@qos/db';
import {
  ALL_PERMISSION_KEYS,
  grantFor,
  isPermissionKey,
  isProjectPermission,
  isRoleKey,
  PROJECT_PERMISSION_KEYS,
  type Grant,
} from '../domain/rbac.js';
import type { Principal } from './auth.js';

export type Decision =
  | { readonly allowed: true; readonly grant: 'granted' | 'own' }
  | { readonly allowed: false; readonly reason: 'no_grant' | 'policy_required' | 'unknown_permission' };

const strongest = (grants: (Grant | null)[]): Grant | null =>
  grants.includes('granted')
    ? 'granted'
    : grants.includes('own')
      ? 'own'
      : grants.includes('policy')
        ? 'policy'
        : null;

/**
 * Deny-by-default permission check (BR-M13-1, BR-M13-2).
 * - Org/platform permissions are decided by the principal's org roles.
 * - Project permissions are decided by the membership in that project, plus the org roles that the
 *   matrix lists for that permission (e.g. org_admin for settings, not for running tests).
 * - "policy" grants (◐) stay denied until the approval policy engine exists.
 * - "own" grants are returned as such: the caller must still verify ownership of the resource.
 */
export async function authorize(
  db: Db,
  principal: Principal,
  permission: string,
  projectId?: string | null,
): Promise<Decision> {
  if (!isPermissionKey(permission)) return { allowed: false, reason: 'unknown_permission' };
  const candidates: (Grant | null)[] = principal.orgRoles.map((role) => grantFor(role, permission));
  if (isProjectPermission(permission) && projectId) {
    const [membership] = await db
      .select({ key: roles.key })
      .from(projectMemberships)
      .innerJoin(roles, eq(roles.id, projectMemberships.roleId))
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, principal.userId)),
      );
    if (membership && isRoleKey(membership.key)) candidates.push(grantFor(membership.key, permission));
  }
  const grant = strongest(candidates);
  if (grant === 'granted' || grant === 'own') return { allowed: true, grant };
  return { allowed: false, reason: grant === 'policy' ? 'policy_required' : 'no_grant' };
}

/** Org-scope permissions the principal holds, for `/me/permissions` and UI gating. */
export function orgPermissionsOf(principal: Principal): string[] {
  return ALL_PERMISSION_KEYS.filter(
    (p) => !isProjectPermission(p) && principal.orgRoles.some((role) => grantFor(role, p) === 'granted'),
  ).sort();
}

/** Project-scope permissions the principal holds in one project ("policy" grants excluded). */
export async function projectPermissionsOf(
  db: Db,
  principal: Principal,
  projectId: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const permission of PROJECT_PERMISSION_KEYS) {
    if ((await authorize(db, principal, permission, projectId)).allowed) out.push(permission);
  }
  return out.sort();
}

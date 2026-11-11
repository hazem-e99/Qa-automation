import { permissions, rolePermissions, roles, sql, type Db } from '@qos/db';
import { uuidv7 } from '@qos/kernel-domain';
import { ALL_PERMISSION_KEYS, allGrants, ROLES, type RoleKey } from '../domain/rbac.js';

/**
 * Makes the role and permission tables match the catalog in code. Idempotent and safe to run from
 * several processes at start-up. The tables exist for foreign keys and reporting; authorization
 * decisions are taken from the catalog itself.
 */
export async function syncRbacCatalog(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('identity.rbac_catalog'))`);
    for (const [key, def] of Object.entries(ROLES) as [RoleKey, { scope: string }][]) {
      await tx
        .insert(roles)
        .values({ id: uuidv7(), key, scope: def.scope, isBuiltin: true })
        .onConflictDoUpdate({ target: roles.key, set: { scope: def.scope, isBuiltin: true } });
    }
    for (const key of ALL_PERMISSION_KEYS) {
      await tx.insert(permissions).values({ key, description: key }).onConflictDoNothing();
    }
    const roleRows = await tx.select().from(roles);
    const idByKey = new Map(roleRows.map((r) => [r.key, r.id]));
    // Rebuild the grants of built-in roles so removed grants disappear too.
    await tx.execute(
      sql`delete from identity.role_permissions where role_id in (select id from identity.roles where is_builtin)`,
    );
    const rows = allGrants().map((g) => ({
      roleId: idByKey.get(g.role)!,
      permissionKey: g.permission,
      grant: g.grant,
    }));
    if (rows.length) await tx.insert(rolePermissions).values(rows);
    await tx.execute(
      sql`delete from identity.permissions where key not in (${sql.join(
        ALL_PERMISSION_KEYS.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
  });
}

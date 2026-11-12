import { SETTINGS_SECTIONS, type SettingsSection } from '@qos/contracts';
import { and, appendAudit, desc, eq, projectSettings, projectSettingsHistory, type Db } from '@qos/db';
import type { Principal } from '@qos/identity';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { assertProjectWritable, type Project } from './projects.js';

export interface SettingsView {
  readonly section: SettingsSection;
  readonly schemaVersion: number;
  /** 0 means "never saved": the data are the section defaults. */
  readonly version: number;
  readonly data: Record<string, unknown>;
}

const defaultsOf = (section: SettingsSection) =>
  SETTINGS_SECTIONS[section].schema.parse({}) as Record<string, unknown>;

export async function getSettings(db: Db, project: Project, section: SettingsSection): Promise<SettingsView> {
  const def = SETTINGS_SECTIONS[section];
  const [row] = await db
    .select()
    .from(projectSettings)
    .where(and(eq(projectSettings.projectId, project.id), eq(projectSettings.section, section)));
  if (!row) return { section, schemaVersion: def.schemaVersion, version: 0, data: defaultsOf(section) };
  // Stored data are re-validated on read; new fields get their defaults.
  return {
    section,
    schemaVersion: def.schemaVersion,
    version: row.version,
    data: def.schema.parse(row.data) as Record<string, unknown>,
  };
}

/**
 * Replaces one settings section (BR-M02-6, M02-AC-08). Validated by the section's schema, refused
 * when the client's version is stale, and every change writes a history version and an audit event.
 */
export async function updateSettings(
  db: Db,
  actor: Principal,
  project: Project,
  section: SettingsSection,
  input: { expectedVersion: number; data: Record<string, unknown> },
): Promise<SettingsView> {
  assertProjectWritable(project);
  const def = SETTINGS_SECTIONS[section];
  const parsed = def.schema.safeParse(input.data);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(',');
    throw new DomainError('settings.invalid', { section, fields });
  }
  const data = parsed.data as Record<string, unknown>;
  return db.transaction(async (tx) => {
    const now = new Date();
    const [current] = await tx
      .select()
      .from(projectSettings)
      .where(and(eq(projectSettings.projectId, project.id), eq(projectSettings.section, section)))
      .for('update');
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new DomainError('settings.version_conflict', { section, currentVersion });
    }
    const version = currentVersion + 1;
    if (current) {
      await tx
        .update(projectSettings)
        .set({ data, version, schemaVersion: def.schemaVersion, updatedAt: now })
        .where(and(eq(projectSettings.projectId, project.id), eq(projectSettings.section, section)));
    } else {
      // A concurrent first save loses on the primary key and surfaces as a conflict.
      try {
        await tx.insert(projectSettings).values({
          projectId: project.id,
          section,
          schemaVersion: def.schemaVersion,
          data,
          version,
          updatedAt: now,
        });
      } catch {
        throw new DomainError('settings.version_conflict', { section, currentVersion: 1 });
      }
    }
    await tx.insert(projectSettingsHistory).values({
      id: uuidv7(),
      projectId: project.id,
      section,
      version,
      data,
      changedBy: actor.userId,
      changedAt: now,
    });
    const before = current
      ? (def.schema.parse(current.data) as Record<string, unknown>)
      : defaultsOf(section);
    const changed = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(before[k]));
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.settings.changed',
      targetType: 'settings',
      targetId: `${project.id}:${section}`,
      summary: { section, version, changed: changed.sort() },
      source: 'api',
    });
    return { section, schemaVersion: def.schemaVersion, version, data };
  });
}

export async function settingsHistory(db: Db, project: Project, section: SettingsSection, limit = 50) {
  const rows = await db
    .select()
    .from(projectSettingsHistory)
    .where(and(eq(projectSettingsHistory.projectId, project.id), eq(projectSettingsHistory.section, section)))
    .orderBy(desc(projectSettingsHistory.version))
    .limit(limit);
  return rows.map((r) => ({
    version: r.version,
    data: r.data as Record<string, unknown>,
    changedBy: r.changedBy,
    changedAt: r.changedAt.toISOString(),
  }));
}

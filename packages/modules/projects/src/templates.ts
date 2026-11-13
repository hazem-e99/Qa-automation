import { isSettingsSection, SETTINGS_SECTIONS, type SettingsSection } from '@qos/contracts';
import {
  and,
  appendAudit,
  eq,
  projectBindings,
  projectEnvironments,
  projectSettings,
  projectSettingsHistory,
  projectTemplates,
  projects as projectsTable,
  isNull,
  type Db,
  type Tx,
} from '@qos/db';
import type { Principal } from '@qos/identity';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { BindingRole } from '@qos/ports';
import { bindConnection } from './bindings.js';
import { validateEnvironment } from './environments.js';
import { createProject, type CreateProjectInput, type Project } from './projects.js';

/**
 * Project templates and cloning (T-P2-14, M02-FR-02). A template carries settings sections and
 * environments. It never carries secrets: environment test logins must be entered again.
 * Built-in templates are defined here; organization templates are saved from a project.
 */
export interface TemplateEnvironment {
  readonly name: string;
  readonly baseUrls: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly isProduction: boolean;
  readonly resetHookUrl: string | null;
  readonly tags: readonly string[];
}
export interface TemplateData {
  readonly settings: Partial<Record<SettingsSection, Record<string, unknown>>>;
  readonly environments: readonly TemplateEnvironment[];
}
export interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly builtin: boolean;
  readonly settingsSections: string[];
  readonly environments: string[];
  readonly createdAt: string | null;
}

export const BUILTIN_TEMPLATES: Readonly<
  Record<string, { name: string; description: string; data: TemplateData }>
> = {
  'builtin-web-app': {
    name: 'Web app – standard',
    description: 'Browser UI testing on Chromium and Firefox; preconditions and expected results required.',
    data: {
      settings: {
        testing_rules: { mandatoryFields: ['preconditions', 'expectedResult'], defaultPriority: 'medium' },
        execution: { browsers: ['chromium', 'firefox'], retries: 1, testTimeoutSeconds: 60 },
        quality: { requirementCoverageTargetPct: 80, flakyThresholdPct: 5 },
      },
      environments: [],
    },
  },
  'builtin-api-service': {
    name: 'API service',
    description: 'API-first testing: short timeouts, tests tagged "api", higher coverage target.',
    data: {
      settings: {
        testing_rules: {
          requiredTags: ['api'],
          mandatoryFields: ['expectedResult'],
          defaultPriority: 'high',
        },
        execution: { browsers: ['chromium'], retries: 0, testTimeoutSeconds: 30, maxShards: 2 },
        quality: { requirementCoverageTargetPct: 90, flakyThresholdPct: 2 },
      },
      environments: [],
    },
  },
};

/**
 * Validates template data against the current settings schemas, which also migrates data saved
 * under an older schema (M02 §13). Unknown sections are refused.
 */
function normalize(raw: unknown): TemplateData {
  const data = (raw ?? {}) as { settings?: Record<string, unknown>; environments?: unknown[] };
  const settings: Partial<Record<SettingsSection, Record<string, unknown>>> = {};
  for (const [section, value] of Object.entries(data.settings ?? {})) {
    if (!isSettingsSection(section)) throw new DomainError('template.invalid', { section });
    const parsed = SETTINGS_SECTIONS[section].schema.safeParse(value ?? {});
    if (!parsed.success) throw new DomainError('template.invalid', { section });
    settings[section] = parsed.data as Record<string, unknown>;
  }
  const environments = (data.environments ?? []).map((e) => {
    const v = validateEnvironment(e as TemplateEnvironment);
    return { ...v, allowedHosts: [...v.allowedHosts], baseUrls: [...v.baseUrls], tags: [...v.tags] };
  });
  return { settings, environments };
}

const summarize = (
  id: string,
  name: string,
  description: string,
  builtin: boolean,
  data: TemplateData,
  createdAt: Date | null,
): TemplateView => ({
  id,
  name,
  description,
  builtin,
  settingsSections: Object.keys(data.settings).sort(),
  environments: data.environments.map((e) => e.name),
  createdAt: createdAt?.toISOString() ?? null,
});

export async function listTemplates(db: Db, orgId: string): Promise<TemplateView[]> {
  const rows = await db
    .select()
    .from(projectTemplates)
    .where(eq(projectTemplates.orgId, orgId))
    .orderBy(projectTemplates.name);
  return [
    ...Object.entries(BUILTIN_TEMPLATES).map(([id, t]) =>
      summarize(id, t.name, t.description, true, t.data, null),
    ),
    ...rows.map((r) => summarize(r.id, r.name, r.description, false, normalize(r.data), r.createdAt)),
  ];
}

async function templateData(
  db: Db | Tx,
  orgId: string,
  templateId: string,
): Promise<{ data: TemplateData; orgTemplateId: string | null }> {
  const builtin = BUILTIN_TEMPLATES[templateId];
  if (builtin) return { data: normalize(builtin.data), orgTemplateId: null };
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) throw new DomainError('template.not_found');
  const [row] = await db
    .select()
    .from(projectTemplates)
    .where(and(eq(projectTemplates.id, templateId), eq(projectTemplates.orgId, orgId)));
  if (!row) throw new DomainError('template.not_found');
  return { data: normalize(row.data), orgTemplateId: row.id };
}

/** What a project's configuration looks like as template data (secrets left out). */
async function snapshot(db: Db | Tx, project: Project): Promise<TemplateData> {
  const settingsRows = await db
    .select()
    .from(projectSettings)
    .where(eq(projectSettings.projectId, project.id));
  const envRows = await db
    .select()
    .from(projectEnvironments)
    .where(eq(projectEnvironments.projectId, project.id))
    .orderBy(projectEnvironments.name);
  return normalize({
    settings: Object.fromEntries(settingsRows.map((r) => [r.section, r.data])),
    environments: envRows.map((e) => ({
      name: e.name,
      baseUrls: e.baseUrls,
      allowedHosts: e.allowedHosts,
      isProduction: e.isProduction,
      resetHookUrl: e.resetHookUrl,
      tags: e.tags,
    })),
  });
}

/** Writes template data into a freshly created project, inside the creating transaction. */
async function applyIn(tx: Tx, actor: Principal, project: Project, data: TemplateData): Promise<void> {
  const now = new Date();
  for (const [section, value] of Object.entries(data.settings) as [
    SettingsSection,
    Record<string, unknown>,
  ][]) {
    await tx.insert(projectSettings).values({
      projectId: project.id,
      section,
      schemaVersion: SETTINGS_SECTIONS[section].schemaVersion,
      data: value,
      version: 1,
      updatedAt: now,
    });
    await tx.insert(projectSettingsHistory).values({
      id: uuidv7(),
      projectId: project.id,
      section,
      version: 1,
      data: value,
      changedBy: actor.userId,
      changedAt: now,
    });
  }
  for (const e of data.environments) {
    await tx.insert(projectEnvironments).values({
      id: uuidv7(),
      projectId: project.id,
      name: e.name,
      baseUrls: [...e.baseUrls],
      allowedHosts: [...e.allowedHosts],
      isProduction: e.isProduction,
      resetHookUrl: e.resetHookUrl,
      tags: [...e.tags],
      authSecretRef: null,
      authSecretUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Creates a project from a built-in or organization template, atomically. */
export async function createProjectFromTemplate(
  db: Db,
  actor: Principal,
  input: CreateProjectInput,
  templateId: string,
): Promise<Project> {
  const { data, orgTemplateId } = await templateData(db, actor.orgId, templateId);
  return db.transaction(async (tx) => {
    const project = await createProject(db, actor, input, tx);
    await applyIn(tx, actor, project, data);
    if (orgTemplateId) {
      await tx
        .update(projectsTable)
        .set({ templateId: orgTemplateId })
        .where(eq(projectsTable.id, project.id));
    }
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.template.applied',
      targetType: 'project',
      targetId: project.id,
      summary: {
        templateId,
        sections: Object.keys(data.settings).sort(),
        environments: data.environments.length,
      },
      source: 'api',
    });
    return project;
  });
}

/** Saves a project's settings and environments as an organization template. */
export async function saveAsTemplate(
  db: Db,
  actor: Principal,
  project: Project,
  input: { name: string; description?: string | undefined },
): Promise<TemplateView> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new DomainError('template.name_invalid');
  const description = (input.description ?? '').trim().slice(0, 500);
  const data = await snapshot(db, project);
  const id = uuidv7();
  const now = new Date();
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(projectTemplates)
      .values({ id, orgId: actor.orgId, name, description, data, createdBy: actor.userId, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: projectTemplates.id });
    if (!inserted.length) throw new DomainError('template.name_taken');
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.template.saved',
      targetType: 'project_template',
      targetId: id,
      summary: { name, from: project.key },
      source: 'api',
    });
  });
  return summarize(id, name, description, false, data, now);
}

export async function deleteTemplate(db: Db, actor: Principal, templateId: string): Promise<void> {
  if (BUILTIN_TEMPLATES[templateId]) throw new DomainError('template.builtin');
  await db.transaction(async (tx) => {
    const removed = /^[0-9a-f-]{36}$/i.test(templateId)
      ? await tx
          .delete(projectTemplates)
          .where(and(eq(projectTemplates.id, templateId), eq(projectTemplates.orgId, actor.orgId)))
          .returning({ name: projectTemplates.name })
      : [];
    if (!removed.length) throw new DomainError('template.not_found');
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.template.deleted',
      targetType: 'project_template',
      targetId: templateId,
      summary: { name: removed[0]!.name },
      source: 'api',
    });
  });
}

/**
 * Clones a project's configuration into a new project: settings, environments (without test
 * logins) and active bindings. A demo project clones into a demo project. Bindings are re-checked
 * against the connections' current capabilities; ones that no longer qualify are reported, not
 * copied. Members, requirements and tests are not copied.
 */
export async function cloneProject(
  db: Db,
  actor: Principal,
  source: Project,
  input: { key: string; name: string },
): Promise<{ project: Project; skippedBindings: { role: string; reason: string }[] }> {
  const data = await snapshot(db, source);
  const project = await db.transaction(async (tx) => {
    const created = await createProject(
      db,
      actor,
      {
        key: input.key,
        name: input.name,
        description: source.description,
        tags: source.tags,
        isDemo: source.isDemo,
      },
      tx,
    );
    await applyIn(tx, actor, created, data);
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: created.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.cloned',
      targetType: 'project',
      targetId: created.id,
      summary: {
        from: source.key,
        sections: Object.keys(data.settings).sort(),
        environments: data.environments.length,
      },
      source: 'api',
    });
    return created;
  });
  const skippedBindings: { role: string; reason: string }[] = [];
  const bindings = await db
    .select()
    .from(projectBindings)
    .where(and(eq(projectBindings.projectId, source.id), isNull(projectBindings.endedAt)));
  for (const b of bindings) {
    try {
      await bindConnection(db, actor, project, {
        role: b.role as BindingRole,
        connectionId: b.connectionId,
        config: b.config as Record<string, unknown>,
      });
    } catch (e) {
      skippedBindings.push({ role: b.role, reason: e instanceof DomainError ? e.code : 'error' });
    }
  }
  return { project, skippedBindings };
}

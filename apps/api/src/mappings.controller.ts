import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import {
  assertStatusMappingComplete,
  discoverMappings,
  getMapping,
  isMappingKind,
  lintMapping,
  listMappings,
  saveMapping,
  type IntegrationDeps,
  type MappingKind,
} from '@qos/integrations';
import { DomainError } from '@qos/kernel-domain';
import { listBindings, setDefectSync, type Project } from '@qos/projects';
import { z } from 'zod';
import { Auth, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INTEGRATIONS } from './tokens.js';

const Entries = z.array(z.object({ external: z.string().max(200), canonical: z.string().max(60) })).max(200);
const SaveMappingRequest = z.object({ expectedVersion: z.number().int().min(0), entries: Entries }).strict();
const ValidateRequest = z.object({ entries: Entries }).strict();
const DefectSyncRequest = z.object({ enabled: z.boolean() }).strict();

/**
 * Mapping editor (T-P2-32, M03 §7): value mappings of the project's issue-tracker binding.
 * Editing needs `project.settings.manage` (qa_lead, org_admin; M03 §2 "qa_lead edits mappings
 * for projects they lead"); reading needs `project.read`.
 */
@Controller('api/v1/projects/:key')
export class MappingsController {
  constructor(@Inject(INTEGRATIONS) private readonly deps: IntegrationDeps) {}

  private async tracker(project: Project) {
    const binding = (await listBindings(this.deps.db, project)).find((b) => b.role === 'issue_tracker');
    if (!binding) throw new DomainError('mapping.no_tracker');
    return {
      projectId: project.id,
      bindingId: binding.id,
      connectionId: binding.connectionId,
      config: binding.config,
    };
  }
  private kind(raw: string): MappingKind {
    if (!isMappingKind(raw)) throw new DomainError('mapping.kind_unknown');
    return raw;
  }
  private actor = (auth: AuthContext) => ({ orgId: auth.principal.orgId, userId: auth.principal.userId });

  @Get('mappings')
  @RequireProjectPermission('project.read')
  async list(@CurrentProject() project: Project) {
    const t = await this.tracker(project);
    return {
      bindingId: t.bindingId,
      connectionId: t.connectionId,
      defectSync: t.config.defectSync === true,
      mappings: await listMappings(this.deps.db, t.bindingId),
    };
  }

  /** Reads the external values from the tracker and suggests mappings for empty kinds. */
  @Post('mappings/discover')
  @RequireProjectPermission('project.settings.manage')
  @HttpCode(200)
  async discover(@Auth() auth: AuthContext, @CurrentProject() project: Project) {
    const t = await this.tracker(project);
    return discoverMappings(this.deps, this.actor(auth), t);
  }

  @Put('mappings/:kind')
  @RequireProjectPermission('project.settings.manage')
  async save(
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    const k = this.kind(kind);
    if (project.status === 'archived') throw new DomainError('project_archived');
    const t = await this.tracker(project);
    return saveMapping(this.deps.db, this.actor(auth), t, k, SaveMappingRequest.parse(body));
  }

  /** Dry run: lints the given entries against the last discovery, without saving. */
  @Post('mappings/:kind/validate')
  @RequireProjectPermission('project.read')
  @HttpCode(200)
  async validate(@Param('kind') kind: string, @Body() body: unknown, @CurrentProject() project: Project) {
    const k = this.kind(kind);
    const t = await this.tracker(project);
    const stored = await getMapping(this.deps.db, t.bindingId, k);
    return lintMapping(k, ValidateRequest.parse(body).entries, stored.discovered);
  }

  /**
   * Activates or pauses defect sync for the tracker binding. Activation is refused while the
   * status mapping does not cover every discovered external status (BR-M03-6, M03-AC-09).
   */
  @Post('defect-sync')
  @RequireProjectPermission('project.settings.manage')
  @HttpCode(200)
  async defectSync(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    const { enabled } = DefectSyncRequest.parse(body);
    const t = await this.tracker(project);
    if (enabled) await assertStatusMappingComplete(this.deps.db, t.bindingId);
    const b = await setDefectSync(this.deps.db, auth.principal, project, t.bindingId, enabled);
    return { bindingId: b.id, defectSync: b.config.defectSync === true };
  }
}

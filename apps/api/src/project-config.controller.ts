import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  BindingRequest,
  EnvironmentRequest,
  isSettingsSection,
  UpdateSettingsRequest,
  Uuid,
  type BindingResponse,
  type EnvironmentResponse,
  type SettingsResponse,
} from '@qos/contracts';
import { listSyncRuns, streamsForRole, type IntegrationDeps } from '@qos/integrations';
import { QUEUES } from '@qos/jobs';
import type { CoreInfra } from '@qos/kernel-infra';
import { DomainError } from '@qos/kernel-domain';
import {
  bindConnection,
  createEnvironment,
  deleteEnvironment,
  endBinding,
  getSettings,
  listBindings,
  listEnvironments,
  settingsHistory,
  updateEnvironment,
  updateSettings,
  type Binding,
  type Environment,
  type Project,
  bindingHealth,
  type BindingHealth,
} from '@qos/projects';
import { Auth, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INFRA, INTEGRATIONS } from './tokens.js';

const env = (e: Environment): EnvironmentResponse => ({
  ...e,
  baseUrls: [...e.baseUrls],
  allowedHosts: [...e.allowedHosts],
  tags: [...e.tags],
});
const binding = (b: Binding): BindingResponse => ({
  ...b,
  config: { ...b.config },
  warnings: [...b.warnings],
});
const sectionOf = (raw: string) => {
  if (!isSettingsSection(raw)) throw new DomainError('settings.section_unknown');
  return raw;
};

/** Environments, bindings and settings of one project (M02-FR-03/04, BR-M02-2/3/6). */
@Controller('api/v1/projects/:key')
export class ProjectConfigController {
  constructor(
    @Inject(INTEGRATIONS) private readonly deps: IntegrationDeps,
    @Inject(INFRA) private readonly infra: CoreInfra,
  ) {}

  @Get('environments')
  @RequireProjectPermission('project.read')
  async environments(@CurrentProject() project: Project): Promise<EnvironmentResponse[]> {
    return (await listEnvironments(this.deps.db, project)).map(env);
  }

  @Post('environments')
  @RequireProjectPermission('project.environments.manage')
  @HttpCode(201)
  async createEnvironment(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<EnvironmentResponse> {
    return env(await createEnvironment(this.deps, auth.principal, project, EnvironmentRequest.parse(body)));
  }

  @Put('environments/:envId')
  @RequireProjectPermission('project.environments.manage')
  async updateEnvironment(
    @Param('envId') envId: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<EnvironmentResponse> {
    const input = EnvironmentRequest.parse(body);
    return env(await updateEnvironment(this.deps, auth.principal, project, Uuid.parse(envId), input));
  }

  @Delete('environments/:envId')
  @RequireProjectPermission('project.environments.manage')
  @HttpCode(204)
  async deleteEnvironment(
    @Param('envId') envId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<void> {
    await deleteEnvironment(this.deps, auth.principal, project, Uuid.parse(envId));
  }

  /** Health of each active binding, from the last connection test (T-P2-17). */
  @Get('bindings/health')
  @RequireProjectPermission('project.read')
  bindingsHealth(@CurrentProject() project: Project): Promise<BindingHealth[]> {
    return bindingHealth(this.deps.db, project);
  }

  @Get('bindings')
  @RequireProjectPermission('project.read')
  async bindings(
    @CurrentProject() project: Project,
    @Query('history') history?: string,
  ): Promise<BindingResponse[]> {
    return (await listBindings(this.deps.db, project, { history: history === 'true' })).map(binding);
  }

  @Post('bindings')
  @RequireProjectPermission('project.bindings.manage')
  @HttpCode(201)
  async bind(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<BindingResponse> {
    return binding(await bindConnection(this.deps.db, auth.principal, project, BindingRequest.parse(body)));
  }

  @Delete('bindings/:bindingId')
  @RequireProjectPermission('project.bindings.manage')
  @HttpCode(204)
  async unbind(
    @Param('bindingId') bindingId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<void> {
    await endBinding(this.deps.db, auth.principal, project, Uuid.parse(bindingId));
  }

  @Get('settings/:section')
  @RequireProjectPermission('project.read')
  settings(@Param('section') section: string, @CurrentProject() project: Project): Promise<SettingsResponse> {
    return getSettings(this.deps.db, project, sectionOf(section));
  }

  @Put('settings/:section')
  @RequireProjectPermission('project.settings.manage')
  updateSettings(
    @Param('section') section: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<SettingsResponse> {
    return updateSettings(
      this.deps.db,
      auth.principal,
      project,
      sectionOf(section),
      UpdateSettingsRequest.parse(body),
    );
  }

  @Get('settings/:section/history')
  @RequireProjectPermission('audit.read')
  history(@Param('section') section: string, @CurrentProject() project: Project) {
    return settingsHistory(this.deps.db, project, sectionOf(section));
  }

  /** Recent sync runs of this project's bindings. */
  @Get('sync')
  @RequireProjectPermission('project.read')
  syncRuns(@CurrentProject() project: Project) {
    return listSyncRuns(this.deps.db, project.id);
  }

  /** Queues a sync of every stream of one binding (mode incremental or full). */
  @Post('sync/:bindingId/run')
  @RequireProjectPermission('project.settings.manage')
  @HttpCode(202)
  async runSync(
    @Param('bindingId') bindingId: string,
    @Query('mode') mode: string | undefined,
    @CurrentProject() project: Project,
  ) {
    if (mode !== undefined && mode !== 'incremental' && mode !== 'full')
      throw new DomainError('sync.mode_invalid');
    const id = Uuid.parse(bindingId);
    const binding = (await listBindings(this.deps.db, project)).find((b) => b.id === id);
    if (!binding) throw new DomainError('binding.not_found');
    const streams = streamsForRole(binding.role);
    if (streams.length === 0) throw new DomainError('sync.no_streams', { role: binding.role });
    const queued: string[] = [];
    for (const s of streams) {
      const jobId = await this.infra.jobs.send(
        QUEUES.integrationsSync.name,
        { bindingId: id, stream: s.name, mode: mode ?? 'incremental' },
        { singletonKey: `${id}:${s.name}` },
      );
      if (jobId) queued.push(s.name);
    }
    // A stream already queued is not queued twice (stately queue); it is still reported as pending.
    return { queued, pending: streams.map((s) => s.name).filter((n) => !queued.includes(n)) };
  }
}

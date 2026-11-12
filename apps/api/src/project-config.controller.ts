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
import type { IntegrationDeps } from '@qos/integrations';
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
} from '@qos/projects';
import { Auth, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INTEGRATIONS } from './tokens.js';

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
  constructor(@Inject(INTEGRATIONS) private readonly deps: IntegrationDeps) {}

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
}

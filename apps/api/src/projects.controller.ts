import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CreateProjectRequest,
  SetMemberRequest,
  UpdateProjectRequest,
  Uuid,
  type MemberResponse,
  type ProjectPermissionsResponse,
  type ProjectResponse,
} from '@qos/contracts';
import {
  listProjectMembers,
  orgPermissionsOf,
  projectPermissionsOf,
  removeProjectMember,
  setProjectMember,
} from '@qos/identity';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import {
  archiveProject,
  assertProjectWritable,
  createProject,
  deleteProject,
  listProjects,
  restoreProject,
  updateProject,
  type Project,
} from '@qos/projects';
import {
  Auth,
  Authenticated,
  CurrentProject,
  RequirePermission,
  RequireProjectPermission,
  type AuthContext,
} from './access.js';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA } from './tokens.js';

const view = (p: Project): ProjectResponse => ({
  id: p.id,
  key: p.key,
  name: p.name,
  description: p.description,
  tags: [...p.tags],
  status: p.status as ProjectResponse['status'],
  isDemo: p.isDemo,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

@Controller('api/v1/projects')
export class ProjectsController {
  constructor(
    @Inject(INFRA) private readonly infra: CoreInfra,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post()
  @RequirePermission('project.create')
  @HttpCode(201)
  async create(@Body() body: unknown, @Auth() auth: AuthContext): Promise<ProjectResponse> {
    const input = CreateProjectRequest.parse(body);
    if (input.isDemo && !this.config.QOS_DEMO_MODE) throw new DomainError('project.demo_mode_off');
    return view(await createProject(this.infra.db, auth.principal, input));
  }

  /** Only the projects the caller may see. Archived projects are left out unless asked for. */
  @Get()
  @Authenticated()
  async list(
    @Auth() auth: AuthContext,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<ProjectResponse[]> {
    const rows = await listProjects(this.infra.db, auth.principal, {
      includeArchived: includeArchived === 'true',
    });
    return rows.map(view);
  }

  @Get(':key')
  @RequireProjectPermission('project.read')
  get(@CurrentProject() project: Project): ProjectResponse {
    return view(project);
  }

  @Patch(':key')
  @RequireProjectPermission('project.settings.manage')
  async update(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<ProjectResponse> {
    const { key, ...input } = UpdateProjectRequest.parse(body);
    if (key !== undefined && key !== project.key) throw new DomainError('project.key_immutable');
    return view(await updateProject(this.infra.db, auth.principal, project, input));
  }

  @Post(':key/archive')
  @RequireProjectPermission('project.settings.manage')
  @HttpCode(200)
  async archive(@Auth() auth: AuthContext, @CurrentProject() project: Project): Promise<ProjectResponse> {
    return view(await archiveProject(this.infra.db, auth.principal, project));
  }

  @Post(':key/restore')
  @RequireProjectPermission('project.settings.manage')
  @HttpCode(200)
  async restore(@Auth() auth: AuthContext, @CurrentProject() project: Project): Promise<ProjectResponse> {
    return view(await restoreProject(this.infra.db, auth.principal, project));
  }

  @Delete(':key')
  @RequireProjectPermission('project.settings.manage')
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @CurrentProject() project: Project): Promise<void> {
    await deleteProject(this.infra.db, auth.principal, project);
  }

  /** The caller's permissions in this project, for UI gating. */
  @Get(':key/permissions')
  @RequireProjectPermission('project.read')
  async permissions(
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<ProjectPermissionsResponse> {
    return {
      org: orgPermissionsOf(auth.principal),
      project: await projectPermissionsOf(this.infra.db, auth.principal, project.id),
    };
  }

  @Get(':key/members')
  @RequireProjectPermission('project.read')
  members(@CurrentProject() project: Project): Promise<MemberResponse[]> {
    return listProjectMembers(this.infra.db, project.id);
  }

  @Put(':key/members/:userId')
  @RequireProjectPermission('members.manage')
  async setMember(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<MemberResponse> {
    assertProjectWritable(project);
    const { role } = SetMemberRequest.parse(body);
    return setProjectMember(this.infra.db, auth.principal, project.id, Uuid.parse(userId), role);
  }

  @Delete(':key/members/:userId')
  @RequireProjectPermission('members.manage')
  @HttpCode(204)
  async removeMember(
    @Param('userId') userId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ): Promise<void> {
    assertProjectWritable(project);
    await removeProjectMember(this.infra.db, auth.principal, project.id, Uuid.parse(userId));
  }
}

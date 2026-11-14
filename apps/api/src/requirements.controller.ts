import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { authorize } from '@qos/identity';
import type { CoreInfra } from '@qos/kernel-infra';
import { DomainError } from '@qos/kernel-domain';
import type { Project } from '@qos/projects';
import {
  bulkApprove,
  closeFinding,
  createManualRequirement,
  createSource,
  decideRequirement,
  editRequirement,
  findRequirementByKey,
  getRequirement,
  listFindings,
  listRequirements,
  listSources,
  markObsolete,
  reportConflict,
  submitForApproval,
  updateSource,
  withdrawFromReview,
} from '@qos/requirements';
import { z } from 'zod';
import { Auth, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INFRA } from './tokens.js';

const Content = z.object({
  title: z.string().max(300),
  bodyMd: z.string().max(100_000).default(''),
  priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
  tags: z.array(z.string().max(40)).max(30).default([]),
  acceptanceCriteria: z
    .array(z.object({ text: z.string().max(5000), origin: z.enum(['source', 'inferred']).default('source') }))
    .max(100)
    .default([]),
});
const EditRequest = Content.extend({ expectedLatestVersion: z.number().int().min(1) });
const SourceRequest = z
  .object({
    kind: z.enum(['external', 'document_set', 'spreadsheet', 'manual']),
    name: z.string().max(120),
    bindingId: z.uuid().nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const SourcePatch = z
  .object({
    name: z.string().max(120).optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const Decision = z
  .object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).nullish() })
  .strict();
const BulkApprove = z
  .object({
    keys: z.array(z.string().max(30)).min(1).max(200),
    includesInferred: z.boolean().default(false),
    comment: z.string().max(2000).nullish(),
  })
  .strict();
const Reason = z.object({ reason: z.string().max(500) }).strict();
const Conflict = z
  .object({ keys: z.array(z.string().max(30)).min(2).max(10), note: z.string().max(2000).default('') })
  .strict();
const CloseFinding = z
  .object({ status: z.enum(['resolved', 'waived', 'dismissed']), reason: z.string().max(2000) })
  .strict();

/** Requirements center (M04 §7). Requirements are addressed by their key, e.g. `PAY-R-3`. */
@Controller('api/v1/projects/:key')
export class RequirementsController {
  constructor(@Inject(INFRA) private readonly infra: CoreInfra) {}

  private async id(project: Project, reqKey: string): Promise<string> {
    const id = /^[A-Z][A-Z0-9]{1,9}-R-\d{1,9}$/.test(reqKey)
      ? await findRequirementByKey(this.infra.db, project, reqKey)
      : null;
    if (!id) throw new DomainError('requirement.not_found');
    return id;
  }

  @Get('requirement-sources')
  @RequireProjectPermission('project.read')
  sources(@CurrentProject() project: Project) {
    return listSources(this.infra.db, project);
  }

  @Post('requirement-sources')
  @RequireProjectPermission('requirement_source.manage')
  @HttpCode(201)
  createSource(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    return createSource(this.infra.db, auth.principal, project, SourceRequest.parse(body));
  }

  @Patch('requirement-sources/:sourceId')
  @RequireProjectPermission('requirement_source.manage')
  updateSource(
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return updateSource(
      this.infra.db,
      auth.principal,
      project,
      z.uuid().parse(sourceId),
      SourcePatch.parse(body),
    );
  }

  @Get('requirements')
  @RequireProjectPermission('project.read')
  list(
    @CurrentProject() project: Project,
    @Query('q') q?: string,
    @Query('state') state?: string,
    @Query('sourceId') sourceId?: string,
  ) {
    return listRequirements(this.infra.db, project, {
      ...(q ? { q: q.slice(0, 200) } : {}),
      ...(state
        ? {
            state: z
              .enum(['draft', 'in_review', 'approved', 'superseded', 'obsolete', 'rejected'])
              .parse(state),
          }
        : {}),
      ...(sourceId ? { sourceId: z.uuid().parse(sourceId) } : {}),
    });
  }

  @Post('requirements')
  @RequireProjectPermission('requirement.create')
  @HttpCode(201)
  create(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    return createManualRequirement(this.infra.db, auth.principal, project, Content.parse(body));
  }

  /** Approves several requirements in review; inferred items need `includesInferred` (M04-AC-02). */
  @Post('requirements/bulk-approve')
  @RequireProjectPermission('project.read')
  @HttpCode(200)
  async bulkApprove(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    const input = BulkApprove.parse(body);
    const ids = [];
    for (const k of input.keys) ids.push(await this.id(project, k));
    return bulkApprove(this.infra.db, auth.principal, project, {
      requirementIds: ids,
      includesInferred: input.includesInferred,
      comment: input.comment ?? null,
    });
  }

  @Get('requirements/:reqKey')
  @RequireProjectPermission('project.read')
  async get(@Param('reqKey') reqKey: string, @CurrentProject() project: Project) {
    return getRequirement(this.infra.db, project, await this.id(project, reqKey));
  }

  /** Every edit is a new draft version; the approved version stays effective. */
  @Put('requirements/:reqKey')
  @RequireProjectPermission('requirement.edit')
  async edit(
    @Param('reqKey') reqKey: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return editRequirement(
      this.infra.db,
      auth.principal,
      project,
      await this.id(project, reqKey),
      EditRequest.parse(body),
    );
  }

  @Post('requirements/:reqKey/submit')
  @RequireProjectPermission('requirement.edit')
  @HttpCode(200)
  async submit(
    @Param('reqKey') reqKey: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return submitForApproval(this.infra.db, auth.principal, project, await this.id(project, reqKey));
  }

  @Post('requirements/:reqKey/withdraw')
  @RequireProjectPermission('requirement.edit')
  @HttpCode(200)
  async withdraw(
    @Param('reqKey') reqKey: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return withdrawFromReview(this.infra.db, auth.principal, project, await this.id(project, reqKey));
  }

  /** Approver decision; eligibility comes from the project's approval policy (M14). */
  @Post('requirements/:reqKey/decision')
  @RequireProjectPermission('project.read')
  @HttpCode(200)
  async decision(
    @Param('reqKey') reqKey: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return decideRequirement(
      this.infra.db,
      auth.principal,
      project,
      await this.id(project, reqKey),
      Decision.parse(body),
    );
  }

  @Post('requirements/:reqKey/obsolete')
  @RequireProjectPermission('requirement.approve')
  @HttpCode(200)
  async obsolete(
    @Param('reqKey') reqKey: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return markObsolete(
      this.infra.db,
      auth.principal,
      project,
      await this.id(project, reqKey),
      Reason.parse(body).reason,
    );
  }

  @Get('requirement-findings')
  @RequireProjectPermission('project.read')
  findings(@CurrentProject() project: Project, @Query('status') status?: string) {
    return listFindings(
      this.infra.db,
      project,
      status ? { status: z.enum(['open', 'resolved', 'waived', 'dismissed']).parse(status) } : {},
    );
  }

  /** Records a conflict between requirements; it blocks their approval until closed. */
  @Post('requirement-findings')
  @RequireProjectPermission('requirement.edit')
  @HttpCode(201)
  async conflict(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    const input = Conflict.parse(body);
    const ids = [];
    for (const k of input.keys) ids.push(await this.id(project, k));
    return reportConflict(this.infra.db, auth.principal, project, { requirementIds: ids, note: input.note });
  }

  /** Resolve or dismiss needs `finding.resolve`; waiving needs `finding.waive` (BR-M04-6). */
  @Post('requirement-findings/:findingId/close')
  @RequireProjectPermission('finding.resolve')
  @HttpCode(200)
  async close(
    @Param('findingId') findingId: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    const input = CloseFinding.parse(body);
    if (
      input.status === 'waived' &&
      !(await authorize(this.infra.db, auth.principal, 'finding.waive', project.id)).allowed
    ) {
      throw new DomainError('forbidden');
    }
    return closeFinding(this.infra.db, auth.principal, project, z.uuid().parse(findingId), input);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { CoreInfra } from '@qos/kernel-infra';
import { DomainError } from '@qos/kernel-domain';
import type { Project } from '@qos/projects';
import {
  applySnapshotChanges,
  exportRequirements,
  findRequirementByKey,
  linkRequirement,
  mergeCandidate,
  requirementTrace,
  reviewTraceLink,
  snapshotChanges,
  unlinkRequirement,
} from '@qos/requirements';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Auth, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INFRA } from './tokens.js';

const KEY = /^[A-Z][A-Z0-9]{1,9}-R-\d{1,9}$/;
const ChangesQuery = z.object({ against: z.uuid().optional() }).strict();
const Merge = z.object({ itemId: z.uuid(), requirementKey: z.string().regex(KEY) }).strict();
const Link = z
  .object({ type: z.enum(['child_of', 'relates_to']), targetKey: z.string().regex(KEY) })
  .strict();
const ExportQuery = z
  .object({
    format: z.enum(['csv', 'xlsx']).default('csv'),
    view: z.enum(['requirements', 'trace']).optional(),
  })
  .strict();

/**
 * Document changes and impact (T-P3-11), candidate merge (M04-AC-10), the requirement trace view
 * and links (T-P3-12), and the export (T-P3-16).
 */
@Controller('api/v1/projects/:key')
export class TraceController {
  constructor(@Inject(INFRA) private readonly infra: CoreInfra) {}

  private async id(project: Project, reqKey: string): Promise<string> {
    const id = KEY.test(reqKey) ? await findRequirementByKey(this.infra.db, project, reqKey) : null;
    if (!id) throw new DomainError('requirement.not_found');
    return id;
  }

  /** Added, changed and removed requirements against the previous document version, with the tests they affect. */
  @Get('snapshots/:snapshotId/changes')
  @RequireProjectPermission('project.read')
  changes(
    @Param('snapshotId') snapshotId: string,
    @Query() query: Record<string, string>,
    @CurrentProject() project: Project,
  ) {
    const q = ChangesQuery.parse(query);
    return snapshotChanges(this.infra.db, project, z.uuid().parse(snapshotId), q.against);
  }

  @Post('snapshots/:snapshotId/apply-changes')
  @HttpCode(200)
  @RequireProjectPermission('requirement.edit')
  apply(
    @Param('snapshotId') snapshotId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return applySnapshotChanges(this.infra.db, auth.principal, project, z.uuid().parse(snapshotId));
  }

  @Post('candidates/merge')
  @HttpCode(200)
  @RequireProjectPermission('requirement.edit')
  async merge(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    const m = Merge.parse(body);
    return mergeCandidate(
      this.infra.db,
      auth.principal,
      project,
      m.itemId,
      await this.id(project, m.requirementKey),
    );
  }

  @Get('requirements/:reqKey/trace')
  @RequireProjectPermission('project.read')
  async trace(@Param('reqKey') reqKey: string, @CurrentProject() project: Project) {
    return requirementTrace(this.infra.db, project, await this.id(project, reqKey));
  }

  @Post('requirements/:reqKey/links')
  @HttpCode(200)
  @RequireProjectPermission('requirement.edit')
  async link(
    @Param('reqKey') reqKey: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    const id = await this.id(project, reqKey);
    return linkRequirement(this.infra.db, auth.principal, project, id, Link.parse(body));
  }

  @Delete('requirements/:reqKey/links/:linkId')
  @RequireProjectPermission('requirement.edit')
  async unlink(
    @Param('reqKey') reqKey: string,
    @Param('linkId') linkId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    const id = await this.id(project, reqKey);
    return unlinkRequirement(this.infra.db, auth.principal, project, id, z.uuid().parse(linkId));
  }

  /** Confirms a test link flagged after the requirement changed at its source. */
  @Post('requirements/:reqKey/links/:linkId/reviewed')
  @HttpCode(200)
  @RequireProjectPermission('requirement.edit')
  async reviewed(
    @Param('reqKey') reqKey: string,
    @Param('linkId') linkId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    const id = await this.id(project, reqKey);
    return reviewTraceLink(this.infra.db, auth.principal, project, id, z.uuid().parse(linkId));
  }

  @Get('requirements-export')
  @RequireProjectPermission('project.read')
  async export(
    @Query() query: Record<string, string>,
    @CurrentProject() project: Project,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const q = ExportQuery.parse(query);
    const file = await exportRequirements(this.infra.db, project, q);
    void reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store');
    return Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  }
}

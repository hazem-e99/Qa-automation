import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { CoreInfra } from '@qos/kernel-infra';
import type { ObjectStorage } from '@qos/ports';
import type { Project } from '@qos/projects';
import {
  acceptCandidates,
  getParsedDocument,
  getSnapshot,
  listCandidates,
  listDocuments,
  previewMapping,
  reextractSnapshot,
  rejectCandidates,
  uploadDocument,
  type DocumentDeps,
} from '@qos/requirements';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Auth, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INFRA, STORAGE } from './tokens.js';

/** Largest upload body accepted by the raw-body parser (the domain cap is 50 MiB). */
export const UPLOAD_BODY_LIMIT = 50 * 2 ** 20 + 1;

const UploadQuery = z
  .object({
    fileName: z.string().min(1).max(255),
    documentId: z.uuid().optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();
const ItemIds = z.object({ itemIds: z.array(z.uuid()).min(1).max(500) }).strict();
const Reject = ItemIds.extend({ reason: z.string().max(500).default('') }).strict();
const Preview = z.object({ mapping: z.record(z.string(), z.unknown()).nullish() }).strict();
const Status = z.enum(['candidate', 'accepted', 'rejected', 'merged', 'replaced']);

/**
 * Document ingestion and candidate review (M04 §7, T-P3-04/07/08). Uploads are raw bodies
 * (`application/octet-stream`) with the file name in the query; the server decides the type from
 * the bytes, never from the name or the content-type header.
 */
@Controller('api/v1/projects/:key')
export class DocumentsController {
  private readonly deps: DocumentDeps;

  constructor(@Inject(INFRA) infra: CoreInfra, @Inject(STORAGE) storage: ObjectStorage) {
    this.deps = { db: infra.db, storage, jobs: infra.jobs };
  }

  @Post('requirement-sources/:sourceId/documents')
  @RequireProjectPermission('document.upload')
  async upload(
    @Param('sourceId') sourceId: string,
    @Query() query: Record<string, string>,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // The source is looked up before the request is judged, so a foreign source is always a 404.
    const q = UploadQuery.safeParse(query);
    const bytes = Buffer.isBuffer(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array();
    const result = await uploadDocument(this.deps, auth.principal, project, z.uuid().parse(sourceId), {
      fileName: q.success ? q.data.fileName : '',
      bytes,
      documentId: q.success ? (q.data.documentId ?? null) : null,
      title: q.success ? (q.data.title ?? null) : null,
    });
    void reply.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Get('requirement-sources/:sourceId/documents')
  @RequireProjectPermission('project.read')
  documents(@Param('sourceId') sourceId: string, @CurrentProject() project: Project) {
    return listDocuments(this.deps.db, project, z.uuid().parse(sourceId));
  }

  @Get('snapshots/:snapshotId')
  @RequireProjectPermission('project.read')
  snapshot(@Param('snapshotId') snapshotId: string, @CurrentProject() project: Project) {
    return getSnapshot(this.deps.db, project, z.uuid().parse(snapshotId));
  }

  /** Parsed blocks with their locators, for the source viewer next to the candidates. */
  @Get('snapshots/:snapshotId/parsed')
  @RequireProjectPermission('project.read')
  parsed(@Param('snapshotId') snapshotId: string, @CurrentProject() project: Project) {
    return getParsedDocument(this.deps, project, z.uuid().parse(snapshotId));
  }

  @Get('snapshots/:snapshotId/candidates')
  @RequireProjectPermission('project.read')
  candidates(
    @Param('snapshotId') snapshotId: string,
    @CurrentProject() project: Project,
    @Query('status') status?: string,
  ) {
    return listCandidates(
      this.deps.db,
      project,
      z.uuid().parse(snapshotId),
      status ? { status: Status.parse(status) } : {},
    );
  }

  /** What a column mapping would extract from a parsed sheet; changes nothing. */
  @Post('snapshots/:snapshotId/mapping-preview')
  @RequireProjectPermission('requirement_source.manage')
  @HttpCode(200)
  preview(
    @Param('snapshotId') snapshotId: string,
    @Body() body: unknown,
    @CurrentProject() project: Project,
  ) {
    return previewMapping(
      this.deps,
      project,
      z.uuid().parse(snapshotId),
      Preview.parse(body ?? {}).mapping ?? null,
    );
  }

  /** Re-runs extraction with the source's saved mapping; open candidates are replaced. */
  @Post('snapshots/:snapshotId/re-extract')
  @RequireProjectPermission('requirement_source.manage')
  @HttpCode(200)
  reextract(
    @Param('snapshotId') snapshotId: string,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    return reextractSnapshot(this.deps, auth.principal, project, z.uuid().parse(snapshotId));
  }

  /** Accepts candidates as draft requirements; in bulk, low-confidence ones are skipped (M04-AC-07). */
  @Post('candidates/accept')
  @RequireProjectPermission('requirement.create')
  @HttpCode(200)
  accept(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    return acceptCandidates(this.deps.db, auth.principal, project, ItemIds.parse(body).itemIds);
  }

  @Post('candidates/reject')
  @RequireProjectPermission('requirement.create')
  @HttpCode(200)
  reject(@Body() body: unknown, @Auth() auth: AuthContext, @CurrentProject() project: Project) {
    const input = Reject.parse(body);
    return rejectCandidates(this.deps.db, auth.principal, project, input.itemIds, input.reason);
  }
}

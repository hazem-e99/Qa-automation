import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { CreateProbeRequest, Uuid, type ProbeResponse } from '@qos/contracts';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import { withIdempotency } from '@qos/platform';
import { createProbe, getProbe } from '@qos/probe';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from './access.js';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA } from './tokens.js';

/**
 * Platform probe endpoints: a diagnostic command that exercises the transaction path end to end.
 * Only platform administrators may use it, and the routes are disabled in production.
 */
@Controller('api/v1/platform/probes')
export class ProbeController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INFRA) private readonly infra: CoreInfra,
  ) {}

  @Post()
  @RequirePermission('system.settings')
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProbeResponse> {
    this.assertEnabled();
    const input = CreateProbeRequest.parse(body);
    const deps = { db: this.infra.db, jobs: this.infra.jobs };
    if (idempotencyKey === undefined) {
      const { id, operationId } = await createProbe(deps, input, 'anonymous');
      return { id, label: input.label, processedAt: null, operationId };
    }
    // The key record and the command share one transaction (doc 22 §4).
    const result = await withIdempotency(
      this.infra.db,
      { scope: 'platform.probe.create', key: idempotencyKey, request: input },
      async (tx) => {
        const { id, operationId } = await createProbe(deps, input, 'anonymous', tx);
        const response: ProbeResponse = { id, label: input.label, processedAt: null, operationId };
        return { status: 201, body: response };
      },
    );
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body as ProbeResponse;
  }

  @Get(':id')
  @RequirePermission('system.settings')
  async get(@Param('id') id: string): Promise<ProbeResponse> {
    this.assertEnabled();
    const row = await getProbe(this.infra.db, Uuid.parse(id));
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      label: row.label,
      processedAt: row.processedAt?.toISOString() ?? null,
      operationId: row.operationId,
    };
  }

  private assertEnabled(): void {
    if (this.config.NODE_ENV === 'production') throw new DomainError('platform.probe.disabled');
  }
}

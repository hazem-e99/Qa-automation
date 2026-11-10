import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { CreateProbeRequest, Uuid, type ProbeResponse } from '@qos/contracts';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import { createProbe, getProbe } from '@qos/probe';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA } from './tokens.js';

/**
 * Platform probe endpoints: a diagnostic command that exercises the transaction path end to end.
 * There is no authentication yet (identity arrives in P2), so the API binds to loopback only and
 * these routes are disabled in production.
 */
@Controller('api/v1/platform/probes')
export class ProbeController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INFRA) private readonly infra: CoreInfra,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<ProbeResponse> {
    this.assertEnabled();
    const input = CreateProbeRequest.parse(body);
    const { id } = await createProbe({ db: this.infra.db, jobs: this.infra.jobs }, input, 'anonymous');
    return { id, label: input.label, processedAt: null };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProbeResponse> {
    this.assertEnabled();
    const row = await getProbe(this.infra.db, Uuid.parse(id));
    if (!row) throw new NotFoundException();
    return { id: row.id, label: row.label, processedAt: row.processedAt?.toISOString() ?? null };
  }

  private assertEnabled(): void {
    if (this.config.NODE_ENV === 'production') throw new DomainError('platform.probe.disabled');
  }
}

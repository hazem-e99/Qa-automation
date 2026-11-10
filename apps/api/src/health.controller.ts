import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HealthResponse } from '@qos/contracts';
import { evaluateReadiness, liveness, type CoreInfra } from '@qos/kernel-infra';
import type { FastifyReply } from 'fastify';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA } from './tokens.js';

const SERVICE = 'api';

@Controller()
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INFRA) private readonly infra: CoreInfra,
  ) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Get('healthz')
  healthz(): HealthResponse {
    return liveness({ service: SERVICE, version: this.config.APP_VERSION });
  }

  /** Readiness: dependencies answer. 503 when any check fails. */
  @Get('readyz')
  async readyz(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResponse> {
    const result = await evaluateReadiness({
      service: SERVICE,
      version: this.config.APP_VERSION,
      checks: this.infra.checks,
    });
    if (result.status !== 'ok') reply.status(503);
    reply.header('cache-control', 'no-store');
    return result;
  }
}

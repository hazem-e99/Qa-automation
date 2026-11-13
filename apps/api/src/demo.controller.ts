import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { IntegrationDeps } from '@qos/integrations';
import { DomainError } from '@qos/kernel-domain';
import { findProjectByKey } from '@qos/projects';
import { Auth, Authenticated, RequirePermission, type AuthContext } from './access.js';
import type { ApiConfig } from './config.js';
import { DEMO_PROJECTS, seedDemo, type DemoSeedResult } from './demo-seed.js';
import { CONFIG, INTEGRATIONS } from './tokens.js';

/** Demo mode (FR-X-15): whether it is on, and the seed the onboarding screen can load. */
@Controller('api/v1/demo')
export class DemoController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INTEGRATIONS) private readonly deps: IntegrationDeps,
  ) {}

  @Get()
  @Authenticated()
  async status(@Auth() auth: AuthContext): Promise<{ enabled: boolean; seeded: boolean }> {
    if (!this.config.QOS_DEMO_MODE) return { enabled: false, seeded: false };
    const project = await findProjectByKey(this.deps.db, auth.principal.orgId, DEMO_PROJECTS[0].key);
    return { enabled: true, seeded: project?.isDemo === true };
  }

  /** Loads the demo seed. Safe to repeat: only missing pieces are created. */
  @Post('seed')
  @RequirePermission('project.create')
  @HttpCode(200)
  async seed(@Auth() auth: AuthContext): Promise<DemoSeedResult> {
    if (!this.config.QOS_DEMO_MODE) throw new DomainError('demo.disabled');
    return seedDemo(this.deps, auth.principal);
  }
}

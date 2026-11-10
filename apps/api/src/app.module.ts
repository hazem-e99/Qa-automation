import { Module, type DynamicModule } from '@nestjs/common';
import type { CoreInfra } from '@qos/kernel-infra';
import type { ApiConfig } from './config.js';
import { HealthController } from './health.controller.js';
import { ProbeController } from './probe.controller.js';
import { CONFIG, INFRA } from './tokens.js';

/** Composition root of the HTTP API. Infrastructure is built before Nest starts and passed in. */
@Module({})
export class AppModule {
  static register(config: ApiConfig, infra: CoreInfra): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProbeController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: INFRA, useValue: infra },
      ],
    };
  }
}

import { Module, type DynamicModule } from '@nestjs/common';
import type { CoreInfra } from '@qos/kernel-infra';
import type { ObjectStorage } from '@qos/ports';
import type { ApiConfig } from './config.js';
import { FilesController } from './files.controller.js';
import { HealthController } from './health.controller.js';
import type { OperationEvents } from './operation-events.js';
import { OperationsController } from './operations.controller.js';
import { ProbeController } from './probe.controller.js';
import { CONFIG, INFRA, OPERATION_EVENTS, STORAGE } from './tokens.js';

/** Composition root of the HTTP API. Infrastructure is built before Nest starts and passed in. */
@Module({})
export class AppModule {
  static register(
    config: ApiConfig,
    infra: CoreInfra,
    operationEvents: OperationEvents,
    storage: ObjectStorage,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProbeController, OperationsController, FilesController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: INFRA, useValue: infra },
        { provide: OPERATION_EVENTS, useValue: operationEvents },
        { provide: STORAGE, useValue: storage },
      ],
    };
  }
}

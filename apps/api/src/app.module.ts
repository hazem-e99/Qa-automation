import { Module, type DynamicModule } from '@nestjs/common';
import type { IntegrationDeps } from '@qos/integrations';
import type { CoreInfra } from '@qos/kernel-infra';
import type { ObjectStorage } from '@qos/ports';
import { AuthController } from './auth.controller.js';
import { ConnectionsController } from './connections.controller.js';
import type { ApiConfig } from './config.js';
import { DemoController } from './demo.controller.js';
import { FilesController } from './files.controller.js';
import { GovernanceController } from './governance.controller.js';
import { HealthController } from './health.controller.js';
import type { OperationEvents } from './operation-events.js';
import { OperationsController } from './operations.controller.js';
import { ProbeController } from './probe.controller.js';
import { ProjectConfigController } from './project-config.controller.js';
import { ProjectsController, ProjectTemplatesController } from './projects.controller.js';
import { CONFIG, INFRA, INTEGRATIONS, OPERATION_EVENTS, SECRETS, STORAGE } from './tokens.js';
import { UsersController } from './users.controller.js';

/** Composition root of the HTTP API. Infrastructure is built before Nest starts and passed in. */
@Module({})
export class AppModule {
  static register(
    config: ApiConfig,
    infra: CoreInfra,
    operationEvents: OperationEvents,
    storage: ObjectStorage,
    integrations: IntegrationDeps,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        ProbeController,
        ProjectsController,
        ProjectTemplatesController,
        ConnectionsController,
        ProjectConfigController,
        GovernanceController,
        OperationsController,
        FilesController,
        UsersController,
        DemoController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: INFRA, useValue: infra },
        { provide: OPERATION_EVENTS, useValue: operationEvents },
        { provide: STORAGE, useValue: storage },
        { provide: INTEGRATIONS, useValue: integrations },
        { provide: SECRETS, useValue: integrations.secrets },
      ],
    };
  }
}

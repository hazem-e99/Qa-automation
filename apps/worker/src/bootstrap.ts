import 'reflect-metadata';
import type { Server } from 'node:http';
import { Inject, Injectable, Module, type DynamicModule, type OnApplicationBootstrap } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PROBE_CREATED_EVENT } from '@qos/contracts';
import { OutboxDispatcher, QUEUES } from '@qos/jobs';
import {
  BaseConfig,
  closeServer,
  createCoreInfra,
  loadConfig,
  port,
  startHealthServer,
  type CoreInfra,
} from '@qos/kernel-infra';
import { onProbeCreated, processProbeJob, type ProbeJobData } from '@qos/probe';
import { z } from 'zod';

export const WorkerConfig = BaseConfig.extend({
  WORKER_HEALTH_PORT: port(3002),
  WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
  JOB_POLL_SECONDS: z.coerce.number().min(0.5).max(60).default(1),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

const INFRA = Symbol('qos.infra');
const DISPATCHER = Symbol('qos.dispatcher');

/** Registers job handlers and outbox subscribers. Each module adds its own lines here as it is built. */
@Injectable()
class Registrations implements OnApplicationBootstrap {
  constructor(
    @Inject(INFRA) private readonly infra: CoreInfra,
    @Inject(DISPATCHER) private readonly dispatcher: OutboxDispatcher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { db, jobs, logger } = this.infra;
    await jobs.work<ProbeJobData>(QUEUES.probeProcess.name, async (job) => {
      const { changed } = await processProbeJob(db, job);
      logger.info({ jobId: job.id, probeId: job.data.probeId, changed }, 'probe job handled');
    });
    this.dispatcher.subscribe(PROBE_CREATED_EVENT, 'probe.seen', onProbeCreated);
    await this.dispatcher.start();
  }
}

@Module({})
class WorkerModule {
  static register(infra: CoreInfra, dispatcher: OutboxDispatcher): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: INFRA, useValue: infra },
        { provide: DISPATCHER, useValue: dispatcher },
        Registrations,
      ],
    };
  }
}

export interface WorkerApp {
  readonly config: WorkerConfig;
  readonly infra: CoreInfra;
  readonly healthUrl: string;
  close(): Promise<void>;
}

export async function createWorkerApp(env: NodeJS.ProcessEnv = process.env): Promise<WorkerApp> {
  const config = loadConfig(WorkerConfig, env);
  const infra = await createCoreInfra(config, {
    service: 'worker',
    superviseJobs: true,
    jobPollingIntervalSeconds: config.JOB_POLL_SECONDS,
  });
  const dispatcher = new OutboxDispatcher({
    db: infra.db,
    connectionString: config.DATABASE_URL,
    logger: infra.logger,
  });
  let health: Server | null = null;
  try {
    const ctx = await NestFactory.createApplicationContext(WorkerModule.register(infra, dispatcher), {
      logger: false,
    });
    health = await startHealthServer(
      config.WORKER_HEALTH_PORT,
      { service: 'worker', version: config.APP_VERSION, checks: infra.checks },
      config.WORKER_HEALTH_HOST,
    );
    const address = health.address();
    const actualPort = typeof address === 'object' && address ? address.port : config.WORKER_HEALTH_PORT;
    let closed = false;
    return {
      config,
      infra,
      healthUrl: `http://${config.WORKER_HEALTH_HOST}:${actualPort}`,
      close: async () => {
        if (closed) return;
        closed = true;
        if (health) await closeServer(health);
        await dispatcher.stop();
        await ctx.close();
        await infra.close(); // pg-boss stops gracefully: in-flight jobs finish or are redelivered later
      },
    };
  } catch (e) {
    if (health) await closeServer(health);
    await dispatcher.stop();
    await infra.close();
    throw e;
  }
}

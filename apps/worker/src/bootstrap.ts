import 'reflect-metadata';
import type { Server } from 'node:http';
import { Inject, Injectable, Module, type DynamicModule, type OnApplicationBootstrap } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GeminiConnection } from '@qos/adapters-ai-gemini';
import { AzureDevOpsConnection } from '@qos/adapters-azure-devops';
import { GitHubRepositoryProvider } from '@qos/adapters-github';
import { LocalGitRepositoryProvider } from '@qos/adapters-local-git';
import { MockIssueTracker, MockRepositoryProvider } from '@qos/adapters-mock';
import { DbEnvelopeSecretStore, loadMasterKeyFile } from '@qos/adapters-secrets-db';
import { PROBE_CREATED_EVENT } from '@qos/contracts';
import { checkBindingsHealth, checkCredentialExpiry } from '@qos/governance';
import { ProviderRegistry, type IntegrationDeps } from '@qos/integrations';
import { OutboxDispatcher, QUEUES } from '@qos/jobs';
import {
  BaseConfig,
  closeServer,
  ConfigError,
  createCoreInfra,
  loadConfig,
  port,
  SafeHttpClient,
  startHealthServer,
  type CoreInfra,
} from '@qos/kernel-infra';
import { onProbeCreated, processProbeJob, type ProbeJobData } from '@qos/probe';
import { onApprovalDecided } from '@qos/requirements';
import { z } from 'zod';
import { SyncRuntime } from './sync-runtime.js';

export const WorkerConfig = BaseConfig.extend({
  WORKER_HEALTH_PORT: port(3002),
  WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
  JOB_POLL_SECONDS: z.coerce.number().min(0.5).max(60).default(1),
  /** Sync poll interval. Doc 13: commits 2 min; one interval for all streams in the pilot. */
  SYNC_POLL_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),
  INBOX_POLL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
  /** How often credential expiry is checked (M03-FR-05). Warnings are deduplicated per day. */
  EXPIRY_CHECK_SECONDS: z.coerce.number().int().min(10).max(86_400).default(3600),
  /** How often bindings are checked (T-P2-17); connections tested longer ago than the stale age are re-tested. */
  BINDINGS_HEALTH_SECONDS: z.coerce.number().int().min(10).max(86_400).default(3600),
  BINDINGS_STALE_HOURS: z.coerce.number().min(0).max(168).default(6),
  QOS_MASTER_KEY_FILE: z.string().min(1).optional(),
  /**
   * Folders the Local Git adapter may read (doc 13 §7), comma-separated absolute paths. Mount them
   * read-only. Empty: the adapter is not registered.
   */
  QOS_LOCAL_GIT_ROOTS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  QOS_DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

const INFRA = Symbol('qos.infra');
const DISPATCHER = Symbol('qos.dispatcher');
const SYNC = Symbol('qos.sync');

/** Registers job handlers and outbox subscribers. Each module adds its own lines here as it is built. */
@Injectable()
class Registrations implements OnApplicationBootstrap {
  constructor(
    @Inject(INFRA) private readonly infra: CoreInfra,
    @Inject(DISPATCHER) private readonly dispatcher: OutboxDispatcher,
    @Inject(SYNC) private readonly sync: SyncRuntime,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { db, jobs, logger } = this.infra;
    await jobs.work<ProbeJobData>(QUEUES.probeProcess.name, async (job) => {
      const { changed } = await processProbeJob(db, job);
      logger.info({ jobId: job.id, probeId: job.data.probeId, changed }, 'probe job handled');
    });
    this.dispatcher.subscribe(PROBE_CREATED_EVENT, 'probe.seen', onProbeCreated);
    // Approvals decided in the generic inbox reach the requirement they target (idempotent).
    this.dispatcher.subscribe('approval.decided', 'requirements.apply-approval', onApprovalDecided);
    await this.dispatcher.start();
    await this.sync.start();
  }
}

@Module({})
class WorkerModule {
  static register(infra: CoreInfra, dispatcher: OutboxDispatcher, sync: SyncRuntime): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: INFRA, useValue: infra },
        { provide: DISPATCHER, useValue: dispatcher },
        { provide: SYNC, useValue: sync },
        Registrations,
      ],
    };
  }
}

export interface WorkerApp {
  readonly config: WorkerConfig;
  readonly infra: CoreInfra;
  readonly sync: SyncRuntime;
  readonly healthUrl: string;
  close(): Promise<void>;
}

export async function createWorkerApp(env: NodeJS.ProcessEnv = process.env): Promise<WorkerApp> {
  const config = loadConfig(WorkerConfig, env);
  if (!config.QOS_MASTER_KEY_FILE && config.NODE_ENV === 'production') {
    throw new ConfigError(['QOS_MASTER_KEY_FILE: required in production']);
  }
  const masterKey = config.QOS_MASTER_KEY_FILE ? loadMasterKeyFile(config.QOS_MASTER_KEY_FILE) : null;
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
  // Composition root: the only place in the worker that names concrete adapters.
  const registry = new ProviderRegistry()
    .register(new GitHubRepositoryProvider())
    .register(new AzureDevOpsConnection())
    .register(new GeminiConnection());
  if (config.QOS_LOCAL_GIT_ROOTS.length)
    registry.register(new LocalGitRepositoryProvider({ roots: config.QOS_LOCAL_GIT_ROOTS }));
  if (config.QOS_DEMO_MODE) registry.register(new MockRepositoryProvider()).register(new MockIssueTracker());
  const integrations: IntegrationDeps = {
    db: infra.db,
    registry,
    secrets: masterKey ? new DbEnvelopeSecretStore(infra.db, masterKey) : null,
    http: new SafeHttpClient({ timeoutMs: 15_000, retries: 2 }),
    logger: infra.logger,
  };
  const sync = new SyncRuntime(integrations, infra.jobs, {
    pollSeconds: config.SYNC_POLL_SECONDS,
    inboxSeconds: config.INBOX_POLL_SECONDS,
  });
  const expiryCheck = async () => {
    try {
      const { warned } = await checkCredentialExpiry(infra.db);
      if (warned) infra.logger.info({ warned }, 'credential expiry warnings sent');
    } catch (err) {
      infra.logger.error({ err }, 'credential expiry check failed');
    }
  };
  const bindingsCheck = async () => {
    try {
      const r = await checkBindingsHealth(integrations, { staleHours: config.BINDINGS_STALE_HOURS });
      if (r.tested || r.unhealthy) infra.logger.info(r, 'bindings health check');
    } catch (err) {
      infra.logger.error({ err }, 'bindings health check failed');
    }
  };
  let expiryTimer: NodeJS.Timeout | null = null;
  let bindingsTimer: NodeJS.Timeout | null = null;
  let health: Server | null = null;
  try {
    const ctx = await NestFactory.createApplicationContext(WorkerModule.register(infra, dispatcher, sync), {
      logger: false,
    });
    void expiryCheck();
    expiryTimer = setInterval(() => void expiryCheck(), config.EXPIRY_CHECK_SECONDS * 1000);
    expiryTimer.unref();
    void bindingsCheck();
    bindingsTimer = setInterval(() => void bindingsCheck(), config.BINDINGS_HEALTH_SECONDS * 1000);
    bindingsTimer.unref();
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
      sync,
      healthUrl: `http://${config.WORKER_HEALTH_HOST}:${actualPort}`,
      close: async () => {
        if (closed) return;
        closed = true;
        if (health) await closeServer(health);
        sync.stop();
        if (expiryTimer) clearInterval(expiryTimer);
        if (bindingsTimer) clearInterval(bindingsTimer);
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

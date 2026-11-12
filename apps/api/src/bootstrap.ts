import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MockIssueTracker, MockRepositoryProvider } from '@qos/adapters-mock';
import { DbEnvelopeSecretStore, loadMasterKeyFile } from '@qos/adapters-secrets-db';
import { LocalFsObjectStorage } from '@qos/adapters-storage-localfs';
import type { ApiError } from '@qos/contracts';
import type { Tx } from '@qos/db';
import { syncRbacCatalog } from '@qos/identity';
import { ProviderRegistry, type IntegrationDeps } from '@qos/integrations';
import {
  ConfigError,
  createCoreInfra,
  loadConfig,
  SafeHttpClient,
  TokenBucketLimiter,
  type CoreInfra,
} from '@qos/kernel-infra';
import { currentCorrelationId, runWithCorrelation } from '@qos/observability';
import type { ObjectStorage, SecretStore } from '@qos/ports';
import { AppModule } from './app.module.js';
import { ApiConfig } from './config.js';
import { ApiErrorFilter } from './error.filter.js';
import { OperationEvents } from './operation-events.js';
import { PolicyGuard } from './policy.guard.js';
import { createWebhookListener } from './webhook-listener.js';

export interface ApiApp {
  readonly app: NestFastifyApplication;
  readonly config: ApiConfig;
  readonly infra: CoreInfra;
  readonly storage: ObjectStorage;
  /** Null only outside production, when no master key file is configured. */
  readonly secrets: SecretStore<Tx> | null;
  /** Base URL of the webhook listener once `listen()` has run. */
  readonly webhookUrl: string | null;
  /** Starts listening and returns the base URL. */
  listen(): Promise<string>;
  /** Graceful shutdown: stop accepting requests, then close the job queue and the pool. */
  close(): Promise<void>;
}

const UNLIMITED_PATHS = new Set(['/healthz', '/readyz']);

export interface ApiAppOptions {
  /** Capture stream for log lines (tests scan them for secrets). Defaults to stdout. */
  readonly logDestination?: { write(line: string): void };
}

export async function createApiApp(
  env: NodeJS.ProcessEnv = process.env,
  options: ApiAppOptions = {},
): Promise<ApiApp> {
  const config = loadConfig(ApiConfig, env);
  // No plaintext fallback: production refuses to start without a readable master key (M14).
  if (!config.QOS_MASTER_KEY_FILE && config.NODE_ENV === 'production') {
    throw new ConfigError(['QOS_MASTER_KEY_FILE: required in production']);
  }
  const masterKey = config.QOS_MASTER_KEY_FILE ? loadMasterKeyFile(config.QOS_MASTER_KEY_FILE) : null;
  const infra = await createCoreInfra(config, {
    service: 'api',
    superviseJobs: false,
    ...(options.logDestination ? { logDestination: options.logDestination } : {}),
  });
  const operationEvents = new OperationEvents(config.DATABASE_URL, infra.logger);
  // Composition root: the only place that names a concrete storage adapter.
  const storage: ObjectStorage = new LocalFsObjectStorage(config.STORAGE_DIR);
  const secrets = masterKey ? new DbEnvelopeSecretStore(infra.db, masterKey) : null;
  // Composition root: the only place that names concrete provider adapters.
  const registry = new ProviderRegistry();
  if (config.QOS_DEMO_MODE) registry.register(new MockRepositoryProvider()).register(new MockIssueTracker());
  const integrations: IntegrationDeps = {
    db: infra.db,
    registry,
    secrets,
    http: new SafeHttpClient({ timeoutMs: 15_000, retries: 2 }),
    logger: infra.logger,
  };
  try {
    await syncRbacCatalog(infra.db);
    await operationEvents.start();
    const adapter = new FastifyAdapter({ bodyLimit: 1_048_576, requestTimeout: 30_000 });
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, infra, operationEvents, storage, integrations),
      adapter,
      { logger: false },
    );
    const fastify = app.getHttpAdapter().getInstance();
    const limiter = new TokenBucketLimiter({
      ratePerSecond: config.RATE_LIMIT_RPS,
      burst: config.RATE_LIMIT_BURST,
    });

    // Every request runs inside a correlation context; the id is echoed back to the caller.
    fastify.addHook('onRequest', (req, reply, done) => {
      const incoming = req.headers['x-correlation-id'];
      runWithCorrelation(typeof incoming === 'string' ? incoming : null, () => {
        void reply.header('x-correlation-id', currentCorrelationId());
        // Rate limit per client address until sessions and tokens exist (P2). Health is exempt
        // so that orchestrator probes are never throttled.
        if (!UNLIMITED_PATHS.has(req.url)) {
          const decision = limiter.take(`ip:${req.ip}`);
          if (!decision.allowed) {
            const body: ApiError = {
              code: 'rate_limited',
              params: { retryAfterSeconds: decision.retryAfterSeconds },
              correlationId: currentCorrelationId(),
            };
            void reply.status(429).header('retry-after', String(decision.retryAfterSeconds)).send(body);
            return;
          }
        }
        done();
      });
    });
    fastify.addHook('onResponse', (req, reply, done) => {
      if (!UNLIMITED_PATHS.has(req.url)) {
        infra.logger.info(
          { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
          'request',
        );
      }
      done();
    });
    app.useGlobalFilters(new ApiErrorFilter(infra.logger));
    // Deny by default: every route must declare its access (BR-M13-1).
    app.useGlobalGuards(
      new PolicyGuard(infra, {
        idleMinutes: config.SESSION_IDLE_MINUTES,
        absoluteDays: config.SESSION_ABSOLUTE_DAYS,
      }),
    );
    await app.init();
    const webhooks = createWebhookListener({ ...integrations, storage });
    let closed = false;
    let webhookUrl: string | null = null;
    return {
      app,
      config,
      infra,
      storage,
      secrets,
      get webhookUrl() {
        return webhookUrl;
      },
      listen: async () => {
        await app.listen(config.API_PORT, config.API_HOST);
        webhookUrl = await webhooks.listen({ port: config.WEBHOOK_PORT, host: config.WEBHOOK_HOST });
        return app.getUrl();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await operationEvents.stop(); // ends open SSE streams' subscriptions
        fastify.server.closeAllConnections(); // open SSE responses would otherwise block close()
        await webhooks.close();
        await app.close();
        await infra.close();
      },
    };
  } catch (e) {
    await operationEvents.stop();
    await infra.close();
    throw e;
  }
}

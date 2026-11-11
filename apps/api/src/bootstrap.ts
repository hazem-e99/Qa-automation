import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DbEnvelopeSecretStore, loadMasterKeyFile } from '@qos/adapters-secrets-db';
import { LocalFsObjectStorage } from '@qos/adapters-storage-localfs';
import type { ApiError } from '@qos/contracts';
import type { Tx } from '@qos/db';
import { syncRbacCatalog } from '@qos/identity';
import {
  ConfigError,
  createCoreInfra,
  loadConfig,
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

export interface ApiApp {
  readonly app: NestFastifyApplication;
  readonly config: ApiConfig;
  readonly infra: CoreInfra;
  readonly storage: ObjectStorage;
  /** Null only outside production, when no master key file is configured. */
  readonly secrets: SecretStore<Tx> | null;
  /** Starts listening and returns the base URL. */
  listen(): Promise<string>;
  /** Graceful shutdown: stop accepting requests, then close the job queue and the pool. */
  close(): Promise<void>;
}

const UNLIMITED_PATHS = new Set(['/healthz', '/readyz']);

export async function createApiApp(env: NodeJS.ProcessEnv = process.env): Promise<ApiApp> {
  const config = loadConfig(ApiConfig, env);
  // No plaintext fallback: production refuses to start without a readable master key (M14).
  if (!config.QOS_MASTER_KEY_FILE && config.NODE_ENV === 'production') {
    throw new ConfigError(['QOS_MASTER_KEY_FILE: required in production']);
  }
  const masterKey = config.QOS_MASTER_KEY_FILE ? loadMasterKeyFile(config.QOS_MASTER_KEY_FILE) : null;
  const infra = await createCoreInfra(config, { service: 'api', superviseJobs: false });
  const operationEvents = new OperationEvents(config.DATABASE_URL, infra.logger);
  // Composition root: the only place that names a concrete storage adapter.
  const storage: ObjectStorage = new LocalFsObjectStorage(config.STORAGE_DIR);
  const secrets = masterKey ? new DbEnvelopeSecretStore(infra.db, masterKey) : null;
  try {
    await syncRbacCatalog(infra.db);
    await operationEvents.start();
    const adapter = new FastifyAdapter({ bodyLimit: 1_048_576, requestTimeout: 30_000 });
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, infra, operationEvents, storage),
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
    let closed = false;
    return {
      app,
      config,
      infra,
      storage,
      secrets,
      listen: async () => {
        await app.listen(config.API_PORT, config.API_HOST);
        return app.getUrl();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await operationEvents.stop(); // ends open SSE streams' subscriptions
        fastify.server.closeAllConnections(); // open SSE responses would otherwise block close()
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

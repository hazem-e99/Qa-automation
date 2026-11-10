import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createCoreInfra, loadConfig, type CoreInfra } from '@qos/kernel-infra';
import { currentCorrelationId, runWithCorrelation } from '@qos/observability';
import { AppModule } from './app.module.js';
import { ApiConfig } from './config.js';
import { ApiErrorFilter } from './error.filter.js';

export interface ApiApp {
  readonly app: NestFastifyApplication;
  readonly config: ApiConfig;
  readonly infra: CoreInfra;
  /** Starts listening and returns the base URL. */
  listen(): Promise<string>;
  /** Graceful shutdown: stop accepting requests, then close the job queue and the pool. */
  close(): Promise<void>;
}

export async function createApiApp(env: NodeJS.ProcessEnv = process.env): Promise<ApiApp> {
  const config = loadConfig(ApiConfig, env);
  const infra = await createCoreInfra(config, { service: 'api', superviseJobs: false });
  try {
    const adapter = new FastifyAdapter({ bodyLimit: 1_048_576, requestTimeout: 30_000 });
    const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config, infra), adapter, {
      logger: false,
    });
    const fastify = app.getHttpAdapter().getInstance();
    // Every request runs inside a correlation context; the id is echoed back to the caller.
    fastify.addHook('onRequest', (req, reply, done) => {
      const incoming = req.headers['x-correlation-id'];
      runWithCorrelation(typeof incoming === 'string' ? incoming : null, () => {
        void reply.header('x-correlation-id', currentCorrelationId());
        done();
      });
    });
    fastify.addHook('onResponse', (req, reply, done) => {
      if (req.url !== '/healthz' && req.url !== '/readyz') {
        infra.logger.info(
          { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
          'request',
        );
      }
      done();
    });
    app.useGlobalFilters(new ApiErrorFilter(infra.logger));
    await app.init();
    let closed = false;
    return {
      app,
      config,
      infra,
      listen: async () => {
        await app.listen(config.API_PORT, config.API_HOST);
        return app.getUrl();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await app.close();
        await infra.close();
      },
    };
  } catch (e) {
    await infra.close();
    throw e;
  }
}

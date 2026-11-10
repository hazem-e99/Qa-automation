import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createPool, pingDb } from '@qos/db';
import { BaseConfig, closeServer, ConfigError, loadConfig, port, startHealthServer } from '@qos/kernel-infra';
import { createLogger } from '@qos/observability';
import { z } from 'zod';

/**
 * Execution controller: empty composition root in P1 (T-P1-04). Sandbox orchestration arrives in P6.
 * It is the only process that will ever reach the container runtime, and it exposes no inbound API
 * besides health.
 */
const ControllerConfig = BaseConfig.extend({
  CONTROLLER_HEALTH_PORT: port(3003),
  CONTROLLER_HEALTH_HOST: z.string().default('127.0.0.1'),
});

@Module({})
class ControllerModule {}

try {
  const config = loadConfig(ControllerConfig);
  const logger = createLogger({ service: 'execution-controller', level: config.LOG_LEVEL });
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: 3,
    applicationName: 'qos-controller',
  });
  await pingDb(pool);
  const ctx = await NestFactory.createApplicationContext(ControllerModule, { logger: false });
  const health = await startHealthServer(
    config.CONTROLLER_HEALTH_PORT,
    { service: 'execution-controller', version: config.APP_VERSION, checks: { db: () => pingDb(pool) } },
    config.CONTROLLER_HEALTH_HOST,
  );
  logger.info({ port: config.CONTROLLER_HEALTH_PORT }, 'execution-controller started (no run handling yet)');
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => process.exit(1), 25_000).unref();
      void (async () => {
        await closeServer(health);
        await ctx.close();
        await pool.end();
      })().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
} catch (e) {
  console.error(
    e instanceof ConfigError
      ? e.message
      : `execution-controller failed to start: ${e instanceof Error ? e.message : e}`,
  );
  process.exit(1);
}

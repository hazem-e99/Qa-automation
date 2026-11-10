import { ConfigError } from '@qos/kernel-infra';
import { createWorkerApp } from './bootstrap.js';

try {
  const worker = await createWorkerApp();
  worker.infra.logger.info({ health: worker.healthUrl }, 'worker started');
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      worker.infra.logger.info({ signal }, 'shutting down');
      setTimeout(() => process.exit(1), 25_000).unref();
      void worker.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
} catch (e) {
  console.error(
    e instanceof ConfigError ? e.message : `worker failed to start: ${e instanceof Error ? e.message : e}`,
  );
  process.exit(1);
}

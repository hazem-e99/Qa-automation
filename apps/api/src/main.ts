import { ConfigError } from '@qos/kernel-infra';
import { createApiApp } from './bootstrap.js';

try {
  const api = await createApiApp();
  const url = await api.listen();
  api.infra.logger.info({ url }, 'api listening');
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      api.infra.logger.info({ signal }, 'shutting down');
      // Force exit if a graceful stop hangs.
      setTimeout(() => process.exit(1), 25_000).unref();
      void api.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
} catch (e) {
  // Configuration errors name variables only. Other boot errors print the message, not the stack.
  console.error(
    e instanceof ConfigError ? e.message : `api failed to start: ${e instanceof Error ? e.message : e}`,
  );
  process.exit(1);
}

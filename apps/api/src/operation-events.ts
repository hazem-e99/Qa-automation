import { EventEmitter } from 'node:events';
import type { Logger } from '@qos/observability';
import pg from 'pg';

/**
 * One LISTEN connection per API process, fanned out to SSE subscribers by operation id.
 * If the connection drops it reconnects; subscribers also re-read state on a timer, so a missed
 * notification only delays an update.
 */
export class OperationEvents {
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private stopped = false;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.connectionString,
      application_name: 'qos-api-sse',
    });
    client.on('notification', (n) => {
      if (n.payload) this.emitter.emit(n.payload);
    });
    client.on('error', (err) => {
      this.logger.warn({ err }, 'operation listener lost; reconnecting');
      if (this.client === client) this.client = null;
      if (!this.stopped) setTimeout(() => void this.start().catch(() => undefined), 3_000).unref();
    });
    await client.connect();
    await client.query('listen qos_operations');
    this.client = client;
  }

  subscribe(operationId: string, listener: () => void): () => void {
    this.emitter.on(operationId, listener);
    return () => this.emitter.off(operationId, listener);
  }

  get subscriberCount(): number {
    return this.emitter.eventNames().reduce((n, name) => n + this.emitter.listenerCount(name), 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.emitter.removeAllListeners();
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }
}

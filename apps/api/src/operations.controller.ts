import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { Uuid, type OperationResponse } from '@qos/contracts';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import { getOperation, isTerminal } from '@qos/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiConfig } from './config.js';
import type { OperationEvents } from './operation-events.js';
import { CONFIG, INFRA, OPERATION_EVENTS } from './tokens.js';

const HEARTBEAT_MS = 15_000;
const RECHECK_MS = 5_000;
const MAX_STREAM_MS = 10 * 60_000;

@Controller('api/v1/operations')
export class OperationsController {
  private openStreams = 0;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INFRA) private readonly infra: CoreInfra,
    @Inject(OPERATION_EVENTS) private readonly events: OperationEvents,
  ) {}

  @Get(':id')
  async get(@Param('id') id: string): Promise<OperationResponse> {
    const op = await getOperation(this.infra.db, Uuid.parse(id));
    if (!op) throw new NotFoundException();
    return op;
  }

  /**
   * Server-sent events for one operation: the current state first, then every change, and the
   * stream closes when the operation reaches a final status. Clients may reconnect at any time;
   * each connection starts from the current state, so no event history is needed.
   */
  @Get(':id/events')
  async stream(
    @Param('id') rawId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = Uuid.parse(rawId);
    const first = await getOperation(this.infra.db, id);
    if (!first) throw new NotFoundException();
    if (this.openStreams >= this.config.SSE_MAX_STREAMS) throw new DomainError('operations.too_many_streams');

    this.openStreams++;
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    let lastSent = '';
    let busy = false;
    let again = false;
    const send = (op: OperationResponse) => {
      const data = JSON.stringify(op);
      if (data === lastSent) return;
      lastSent = data;
      res.write(`event: operation\ndata: ${data}\n\n`);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      this.openStreams--;
      unsubscribe();
      clearInterval(heartbeat);
      clearInterval(recheck);
      clearTimeout(deadline);
      res.end();
    };
    const push = async () => {
      if (closed) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const op = await getOperation(this.infra.db, id);
          if (closed) return;
          if (!op) return close();
          send(op);
          if (isTerminal(op.status)) return close();
        } while (again);
      } catch (err) {
        this.infra.logger.warn({ err }, 'operation stream read failed');
        close();
      } finally {
        busy = false;
      }
    };

    const unsubscribe = this.events.subscribe(id, () => void push());
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const recheck = setInterval(() => void push(), RECHECK_MS);
    const deadline = setTimeout(close, MAX_STREAM_MS);
    req.raw.on('close', close);

    send(first);
    if (isTerminal(first.status)) close();
    else void push(); // catch a change that happened between the first read and the subscription
  }
}

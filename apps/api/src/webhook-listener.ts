import { receiveWebhook, type IntegrationDeps } from '@qos/integrations';
import { TokenBucketLimiter } from '@qos/kernel-infra';
import { runWithCorrelation } from '@qos/observability';
import type { ObjectStorage } from '@qos/ports';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Transport limit. It is above the 1 MiB delivery limit on purpose: bodies up to 2 MiB are read and
 * answered with 413 by the ingress check; anything larger is cut off by the server.
 */
const BODY_LIMIT = 2 * 1024 * 1024;

/**
 * Public webhook ingress on its own port (M03 §7: "separate listener in local mode"). It has no
 * sessions, no cookies and no other routes, so it can be exposed through a tunnel on its own.
 */
export function createWebhookListener(deps: IntegrationDeps & { storage: ObjectStorage }): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT, requestTimeout: 15_000, logger: false });
  // 50 deliveries per second per connection (doc 21 §rate limiting).
  const limiter = new TokenBucketLimiter({ ratePerSecond: 50, burst: 100 });

  // Keep the exact bytes: signatures are computed over the raw body.
  // Replace the JSON parser too: a parsed body would no longer match the signature.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post<{ Params: { connectionId: string; token: string } }>(
    '/webhooks/:connectionId/:token',
    async (req, reply) => {
      const { connectionId, token } = req.params;
      if (!/^[0-9a-f-]{36}$/.test(connectionId) || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
        return reply.status(404).send({ code: 'http.404' });
      }
      const decision = limiter.take(`connection:${connectionId}`);
      if (!decision.allowed) {
        return reply
          .status(429)
          .header('retry-after', String(decision.retryAfterSeconds))
          .send({ code: 'rate_limited' });
      }
      const rawBody = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
      const outcome = await runWithCorrelation(null, () =>
        receiveWebhook(deps, { connectionId, token, headers: req.headers, rawBody }),
      );
      switch (outcome.result) {
        case 'accepted':
          return reply.status(202).send({ status: 'accepted' });
        case 'duplicate':
          // 2xx so the provider stops retrying a delivery we already have.
          return reply.status(202).send({ status: 'duplicate' });
        case 'rejected':
          return reply.status(outcome.reason === 'too_large' ? 413 : 401).send({ code: 'webhook.rejected' });
        default:
          return reply.status(404).send({ code: 'http.404' });
      }
    },
  );

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ code: 'http.404' }));
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) return reply.status(413).send({ code: 'webhook.rejected' });
    deps.logger.error({ err }, 'webhook listener error');
    return reply.status(500).send({ code: 'internal' });
  });
  return app;
}

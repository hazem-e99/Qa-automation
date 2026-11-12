import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, appendAudit, connections, eq, inboxMessages, webhookEndpoints, type Db } from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { receiveInboxMessage, recordInboxMarker } from '@qos/platform';
import type { CapabilityManifest, ObjectStorage } from '@qos/ports';
import type { Actor, IntegrationDeps } from './connections.js';

export type Verification = 'hmac_sha256' | 'shared_token' | 'basic_auth';
type Headers = Readonly<Record<string, string | string[] | undefined>>;

export const MAX_WEBHOOK_BYTES = 1024 * 1024;

const sha256 = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const header = (h: Headers, name: string | undefined): string | null => {
  if (!name) return null;
  const v = h[name.toLowerCase()];
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
};
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies one delivery against the endpoint's secret (doc 13): HMAC-SHA256 over the raw body,
 * a shared token header, or Basic auth. Comparisons are constant-time.
 */
export function verifyDelivery(
  verification: Verification,
  webhook: NonNullable<CapabilityManifest['webhook']>,
  secret: string,
  headers: Headers,
  rawBody: Uint8Array,
): VerifyResult {
  if (verification === 'hmac_sha256') {
    const given = header(headers, webhook.signatureHeader);
    if (!given) return { ok: false, reason: 'signature_missing' };
    const hex = given.startsWith('sha256=') ? given.slice(7) : given;
    if (!/^[0-9a-f]{64}$/i.test(hex)) return { ok: false, reason: 'signature_malformed' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return sameText(expected, hex.toLowerCase()) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  }
  if (verification === 'shared_token') {
    const given = header(headers, webhook.signatureHeader);
    if (!given) return { ok: false, reason: 'token_missing' };
    return sameText(given, secret) ? { ok: true } : { ok: false, reason: 'token_mismatch' };
  }
  const auth = header(headers, 'authorization');
  if (!auth?.startsWith('Basic ')) return { ok: false, reason: 'basic_missing' };
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return decoded.includes(':') && sameText(password, secret)
    ? { ok: true }
    : { ok: false, reason: 'basic_mismatch' };
}

export interface WebhookEndpointView {
  readonly connectionId: string;
  readonly verification: Verification;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastDeliveryAt: string | null;
}

/** Returned once, at creation or rotation. Neither value can be read back later. */
export interface WebhookEndpointSecrets extends WebhookEndpointView {
  /** Path to register at the provider: `/webhooks/{connectionId}/{token}` on the webhook listener. */
  readonly path: string;
  readonly signingSecret: string;
}

/**
 * Creates the webhook endpoint of a connection, or replaces it (rotation). The URL carries a
 * random path token; the signing secret goes to the SecretStore. Both are shown only in this answer.
 */
export async function createWebhookEndpoint(
  deps: IntegrationDeps,
  actor: Actor,
  connectionId: string,
): Promise<WebhookEndpointSecrets> {
  if (!deps.secrets) throw new DomainError('secrets.unavailable');
  const secrets = deps.secrets;
  return deps.db.transaction(async (tx) => {
    const [conn] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.orgId, actor.orgId)));
    if (!conn) throw new DomainError('connection.not_found');
    if (conn.status === 'retired') throw new DomainError('connection.retired');
    const webhook = deps.registry.get(conn.providerType).manifest().webhook;
    if (!webhook || webhook.verification === 'none') throw new DomainError('webhook.unsupported');
    const token = randomBytes(24).toString('base64url');
    const signingSecret = randomBytes(32).toString('hex');
    const [old] = await tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.connectionId, connectionId));
    if (old) {
      await secrets.delete(old.secretRef, tx);
      await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, old.id));
    }
    const id = uuidv7();
    const secretRef = await secrets.put(
      { ownerType: 'webhook_endpoint', ownerId: id, purpose: webhook.verification, value: signingSecret },
      tx,
    );
    const now = new Date();
    await tx.insert(webhookEndpoints).values({
      id,
      connectionId,
      pathSecretHash: sha256(token),
      verification: webhook.verification,
      secretRef,
      createdAt: now,
    });
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: old ? 'webhook.rotated' : 'webhook.created',
      targetType: 'connection',
      targetId: connectionId,
      summary: { verification: webhook.verification },
      source: 'api',
    });
    return {
      connectionId,
      verification: webhook.verification,
      enabled: true,
      createdAt: now.toISOString(),
      lastDeliveryAt: null,
      path: `/webhooks/${connectionId}/${token}`,
      signingSecret,
    };
  });
}

export async function getWebhookEndpoint(
  db: Db,
  actor: Actor,
  connectionId: string,
): Promise<WebhookEndpointView | null> {
  const [row] = await db
    .select({ endpoint: webhookEndpoints })
    .from(webhookEndpoints)
    .innerJoin(connections, eq(connections.id, webhookEndpoints.connectionId))
    .where(and(eq(webhookEndpoints.connectionId, connectionId), eq(connections.orgId, actor.orgId)));
  if (!row) return null;
  const e = row.endpoint;
  return {
    connectionId: e.connectionId,
    verification: e.verification as Verification,
    enabled: e.enabled,
    createdAt: e.createdAt.toISOString(),
    lastDeliveryAt: e.lastDeliveryAt?.toISOString() ?? null,
  };
}

export type WebhookOutcome =
  | { readonly result: 'accepted'; readonly inboxId: string }
  | { readonly result: 'duplicate' }
  | { readonly result: 'rejected'; readonly reason: string }
  | { readonly result: 'unknown_endpoint' };

/**
 * Ingress of one delivery (doc 13 §1, ADR-0014). Unknown connection and wrong path token look the
 * same. A verified delivery is stored in the inbox (body in object storage); a redelivery with the
 * same dedupe key is recorded as `duplicate`; a failed verification is recorded as `rejected`.
 * Nothing in the payload is trusted here: processors re-fetch the item through the adapter.
 */
export async function receiveWebhook(
  deps: IntegrationDeps & { storage: ObjectStorage },
  input: { connectionId: string; token: string; headers: Headers; rawBody: Uint8Array },
): Promise<WebhookOutcome> {
  if (!deps.secrets) return { result: 'unknown_endpoint' };
  const [row] = await deps.db
    .select({
      endpoint: webhookEndpoints,
      providerType: connections.providerType,
      status: connections.status,
    })
    .from(webhookEndpoints)
    .innerJoin(connections, eq(connections.id, webhookEndpoints.connectionId))
    .where(eq(webhookEndpoints.connectionId, input.connectionId));
  if (!row || !row.endpoint.enabled || row.status === 'retired') return { result: 'unknown_endpoint' };
  if (!sameText(sha256(input.token), row.endpoint.pathSecretHash)) return { result: 'unknown_endpoint' };
  const webhook = deps.registry.has(row.providerType)
    ? deps.registry.get(row.providerType).manifest().webhook
    : undefined;
  if (!webhook) return { result: 'unknown_endpoint' };

  const eventType = (header(input.headers, webhook.eventTypeHeader) ?? 'unknown').slice(0, 100);
  const deliveryId = header(input.headers, webhook.deliveryIdHeader);
  const dedupeKey = deliveryId
    ? `delivery:${deliveryId.slice(0, 200)}`
    : `hash:${sha256(eventType + '\n') + sha256(input.rawBody)}`;

  if (input.rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    await recordInboxMarker(deps.db, {
      connectionId: input.connectionId,
      dedupeKey,
      eventType,
      kind: 'rejected',
      headers: input.headers,
      reason: 'too_large',
    });
    return { result: 'rejected', reason: 'too_large' };
  }
  const secret = await deps.secrets.get(row.endpoint.secretRef);
  const verdict = verifyDelivery(
    row.endpoint.verification as Verification,
    webhook,
    secret,
    input.headers,
    input.rawBody,
  );
  if (!verdict.ok) {
    await recordInboxMarker(deps.db, {
      connectionId: input.connectionId,
      dedupeKey,
      eventType,
      kind: 'rejected',
      headers: input.headers,
      reason: verdict.reason,
    });
    deps.logger.warn({ connectionId: input.connectionId, reason: verdict.reason }, 'webhook rejected');
    return { result: 'rejected', reason: verdict.reason };
  }

  return deps.db.transaction(async (tx) => {
    const received = await receiveInboxMessage(tx, {
      connectionId: input.connectionId,
      dedupeKey,
      eventType,
      verification: 'ok',
      headers: input.headers,
    });
    if (received.duplicate || !received.id) {
      await recordInboxMarker(tx, {
        connectionId: input.connectionId,
        dedupeKey,
        eventType,
        kind: 'duplicate',
        headers: input.headers,
      });
      return { result: 'duplicate' as const };
    }
    // The body is kept for the processor; the database row holds only a reference.
    const bodyRef = `webhooks/${input.connectionId}/${received.id}.json`;
    await deps.storage.put(bodyRef, input.rawBody, 'application/json');
    await tx.update(inboxMessages).set({ bodyRef }).where(eq(inboxMessages.id, received.id));
    await tx
      .update(webhookEndpoints)
      .set({ lastDeliveryAt: new Date() })
      .where(eq(webhookEndpoints.id, row.endpoint.id));
    return { result: 'accepted' as const, inboxId: received.id };
  });
}

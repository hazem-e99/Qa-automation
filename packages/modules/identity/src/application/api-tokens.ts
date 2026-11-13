import { randomBytes } from 'node:crypto';
import {
  and,
  apiTokens,
  appendAudit,
  eq,
  isNull,
  organizations,
  serviceAccounts,
  sql,
  users,
  type Db,
  type Tx,
} from '@qos/db';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { SecretStore } from '@qos/ports';
import {
  apiTokenMatches,
  hashApiToken,
  isTokenScope,
  newApiToken,
  parseApiToken,
  TOKEN_MAX_DAYS,
  type TokenScope,
} from '../domain/api-token.js';
import type { Principal } from './auth.js';

/**
 * Service accounts and their API tokens (T-P2-43, M13-FR-04). Tokens are shown once, stored as
 * an HMAC with a per-organization pepper that lives in the secret store, and carry explicit
 * scopes plus an optional project restriction. Personal tokens (M13-FR-05) are not offered yet.
 */
export interface ServiceAccountView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: 'active' | 'disabled';
  readonly owner: { readonly id: string; readonly displayName: string; readonly active: boolean };
  /** True when the owner is deactivated: the account needs a new owner (M13 §14). */
  readonly needsReassignment: boolean;
  readonly activeTokens: number;
  readonly createdAt: Date;
}

export interface ApiTokenView {
  readonly id: string;
  readonly serviceAccountId: string;
  readonly name: string;
  /** `qos_<prefix>_…`: enough to recognise a token, useless to authenticate. */
  readonly display: string;
  readonly scopes: TokenScope[];
  readonly projectIds: string[] | null;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/** What the policy guard attaches to a request authenticated with a token. */
export interface TokenPrincipal {
  readonly kind: 'service_account';
  readonly tokenId: string;
  readonly orgId: string;
  readonly serviceAccountId: string;
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly projectIds: readonly string[] | null;
}

const tokenView = (t: typeof apiTokens.$inferSelect): ApiTokenView => ({
  id: t.id,
  serviceAccountId: t.ownerId,
  name: t.name,
  display: `qos_${t.prefix}_…`,
  scopes: t.scopes.filter(isTokenScope),
  projectIds: t.projectIds,
  expiresAt: t.expiresAt,
  lastUsedAt: t.lastUsedAt,
  revokedAt: t.revokedAt,
  createdAt: t.createdAt,
});

/** Pepper per organization, created on first use. Cached: it never changes. */
const pepperCache = new Map<string, string>();
async function pepperFor(db: Db, secrets: SecretStore<Tx> | null, orgId: string): Promise<string> {
  const cached = pepperCache.get(orgId);
  if (cached) return cached;
  if (!secrets) throw new DomainError('secrets.unavailable');
  const pepper = await db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
    if (!org) throw new DomainError('org.not_found');
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    const ref = typeof settings.apiTokenPepperRef === 'string' ? settings.apiTokenPepperRef : null;
    if (ref) return secrets.get(ref);
    const value = randomBytes(32).toString('base64url');
    const newRef = await secrets.put(
      { ownerType: 'organization', ownerId: orgId, purpose: 'api_token_pepper', value },
      tx,
    );
    await tx
      .update(organizations)
      .set({ settings: { ...settings, apiTokenPepperRef: newRef } })
      .where(eq(organizations.id, orgId));
    return value;
  });
  pepperCache.set(orgId, pepper);
  return pepper;
}

export async function createServiceAccount(
  db: Db,
  actor: Principal,
  input: { name: string; description?: string | undefined },
): Promise<ServiceAccountView> {
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(name)) throw new DomainError('service_account.name_invalid');
  const description = (input.description ?? '').trim().slice(0, 500);
  const id = uuidv7();
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(serviceAccounts)
      .values({
        id,
        orgId: actor.orgId,
        name,
        description,
        ownerUserId: actor.userId,
        status: 'active',
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: serviceAccounts.id });
    if (!inserted.length) throw new DomainError('service_account.name_taken');
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.service_account.created',
      targetType: 'service_account',
      targetId: id,
      summary: { name },
      source: 'api',
    });
  });
  return getServiceAccount(db, actor.orgId, id);
}

export async function listServiceAccounts(db: Db, orgId: string): Promise<ServiceAccountView[]> {
  const rows = await db
    .select({ sa: serviceAccounts, ownerName: users.displayName, ownerStatus: users.status })
    .from(serviceAccounts)
    .innerJoin(users, eq(users.id, serviceAccounts.ownerUserId))
    .where(eq(serviceAccounts.orgId, orgId))
    .orderBy(serviceAccounts.name);
  const counts = await db.execute<{ owner_id: string; n: number }>(sql`
    select owner_id, count(*)::int as n from identity.api_tokens
    where org_id = ${orgId} and owner_type = 'service_account' and revoked_at is null and expires_at > now()
    group by owner_id`);
  const n = new Map(counts.rows.map((r) => [r.owner_id, r.n]));
  return rows.map(({ sa, ownerName, ownerStatus }) => ({
    id: sa.id,
    name: sa.name,
    description: sa.description,
    status: sa.status as ServiceAccountView['status'],
    owner: { id: sa.ownerUserId, displayName: ownerName, active: ownerStatus === 'active' },
    needsReassignment: ownerStatus !== 'active',
    activeTokens: n.get(sa.id) ?? 0,
    createdAt: sa.createdAt,
  }));
}

export async function getServiceAccount(db: Db, orgId: string, id: string): Promise<ServiceAccountView> {
  const found = (await listServiceAccounts(db, orgId)).find((s) => s.id === id);
  if (!found) throw new DomainError('service_account.not_found');
  return found;
}

/** Disable (tokens stop working at once) or enable a service account, or give it a new owner. */
export async function updateServiceAccount(
  db: Db,
  actor: Principal,
  id: string,
  input: { status?: 'active' | 'disabled' | undefined; ownerUserId?: string | undefined },
): Promise<ServiceAccountView> {
  await db.transaction(async (tx) => {
    const [sa] = await tx
      .select()
      .from(serviceAccounts)
      .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.orgId, actor.orgId)))
      .for('update');
    if (!sa) throw new DomainError('service_account.not_found');
    const set: Partial<typeof serviceAccounts.$inferInsert> = {};
    if (input.status && input.status !== sa.status) set.status = input.status;
    if (input.ownerUserId && input.ownerUserId !== sa.ownerUserId) {
      const [owner] = await tx
        .select({ status: users.status })
        .from(users)
        .where(and(eq(users.id, input.ownerUserId), eq(users.orgId, actor.orgId)));
      if (owner?.status !== 'active') throw new DomainError('service_account.owner_invalid');
      set.ownerUserId = input.ownerUserId;
    }
    if (!Object.keys(set).length) return;
    await tx.update(serviceAccounts).set(set).where(eq(serviceAccounts.id, id));
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.service_account.updated',
      targetType: 'service_account',
      targetId: id,
      summary: { ...set },
      source: 'api',
    });
  });
  return getServiceAccount(db, actor.orgId, id);
}

export interface NewApiToken {
  readonly name: string;
  readonly scopes: readonly string[];
  /** Null or absent: every project of the organization. The caller validates the ids. */
  readonly projectIds?: readonly string[] | null | undefined;
  readonly expiresInDays: number;
}

/** Creates a token. Unknown scopes are refused with the list of disallowed ones (M13 §13). */
export async function createApiToken(
  db: Db,
  secrets: SecretStore<Tx> | null,
  actor: Principal,
  serviceAccountId: string,
  input: NewApiToken,
  now: Date = new Date(),
): Promise<{ token: string; view: ApiTokenView }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) throw new DomainError('token.name_invalid');
  const disallowed = input.scopes.filter((s) => !isTokenScope(s));
  if (disallowed.length) throw new DomainError('token.scope_invalid', { disallowed: disallowed.join(',') });
  if (!input.scopes.length) throw new DomainError('token.scope_required');
  if (
    !Number.isInteger(input.expiresInDays) ||
    input.expiresInDays < 1 ||
    input.expiresInDays > TOKEN_MAX_DAYS
  ) {
    throw new DomainError('token.expiry_invalid', { maxDays: TOKEN_MAX_DAYS });
  }
  const sa = await getServiceAccount(db, actor.orgId, serviceAccountId);
  if (sa.status !== 'active') throw new DomainError('service_account.disabled');
  const pepper = await pepperFor(db, secrets, actor.orgId);
  const { token, prefix } = newApiToken();
  const id = uuidv7();
  const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(apiTokens)
      .values({
        id,
        orgId: actor.orgId,
        ownerType: 'service_account',
        ownerId: sa.id,
        name,
        prefix,
        tokenHash: hashApiToken(pepper, token),
        scopes: [...new Set(input.scopes)],
        projectIds: input.projectIds?.length ? [...new Set(input.projectIds)] : null,
        expiresAt,
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.token.created',
      targetType: 'api_token',
      targetId: id,
      summary: {
        serviceAccountId: sa.id,
        prefix,
        scopes: inserted!.scopes,
        projectIds: inserted!.projectIds,
        expiresAt: expiresAt.toISOString(),
      },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'token.created',
      aggregateType: 'api_token',
      aggregateId: id,
      payload: { serviceAccountId: sa.id, scopes: inserted!.scopes },
    });
    return inserted!;
  });
  return { token, view: tokenView(row) };
}

export async function listApiTokens(
  db: Db,
  orgId: string,
  serviceAccountId: string,
): Promise<ApiTokenView[]> {
  await getServiceAccount(db, orgId, serviceAccountId); // 404 for another organization's account
  const rows = await db
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.orgId, orgId),
        eq(apiTokens.ownerType, 'service_account'),
        eq(apiTokens.ownerId, serviceAccountId),
      ),
    )
    .orderBy(apiTokens.createdAt);
  return rows.reverse().map(tokenView);
}

export async function revokeApiToken(
  db: Db,
  actor: Principal,
  tokenId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const revoked = await tx
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.orgId, actor.orgId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id, prefix: apiTokens.prefix });
    if (!revoked.length) {
      const [exists] = await tx
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.orgId, actor.orgId)));
      if (!exists) throw new DomainError('token.not_found');
      return; // already revoked: idempotent
    }
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.token.revoked',
      targetType: 'api_token',
      targetId: tokenId,
      summary: { prefix: revoked[0]!.prefix },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'token.revoked',
      aggregateType: 'api_token',
      aggregateId: tokenId,
      payload: {},
    });
  });
}

/**
 * Authenticates a bearer token. Null for anything unknown, malformed, revoked, expired, or
 * belonging to a disabled service account. Records last use at most once a minute.
 */
export async function resolveApiToken(
  db: Db,
  secrets: SecretStore<Tx> | null,
  raw: string,
  now: Date = new Date(),
): Promise<TokenPrincipal | null> {
  const parsed = parseApiToken(raw);
  if (!parsed) return null;
  const [row] = await db
    .select({ token: apiTokens, sa: serviceAccounts })
    .from(apiTokens)
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, apiTokens.ownerId))
    .where(and(eq(apiTokens.prefix, parsed.prefix), eq(apiTokens.ownerType, 'service_account')));
  if (!row || row.token.revokedAt || row.token.expiresAt <= now || row.sa.status !== 'active') return null;
  let pepper: string;
  try {
    pepper = await pepperFor(db, secrets, row.token.orgId);
  } catch {
    return null;
  }
  if (!apiTokenMatches(pepper, raw, row.token.tokenHash)) return null;
  if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id));
  }
  return {
    kind: 'service_account',
    tokenId: row.token.id,
    orgId: row.token.orgId,
    serviceAccountId: row.sa.id,
    name: row.sa.name,
    scopes: row.token.scopes.filter(isTokenScope),
    projectIds: row.token.projectIds,
  };
}

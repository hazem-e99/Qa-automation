import { createHash } from 'node:crypto';
import {
  and,
  appendAudit,
  eq,
  isNull,
  mfaChallenges,
  mfaRecoveryCodes,
  sql,
  users,
  type Db,
  type Tx,
} from '@qos/db';
import { DomainError } from '@qos/kernel-domain';
import type { SecretStore } from '@qos/ports';
import argon2 from 'argon2';
import {
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../domain/totp.js';
import {
  hashOpaque,
  issueSession,
  type ClientInfo,
  type Principal,
  type SessionIssued,
  type SessionPolicy,
} from './auth.js';

/**
 * TOTP multi-factor authentication (T-P2-02). Optional per user; once enabled, every password
 * login needs a second step. The TOTP secret lives only in the secret store.
 */
export const MFA_MAX_ATTEMPTS = 5;
export const MFA_ISSUER = 'QualityOS';
const hashCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

function requireSecrets(secrets: SecretStore<Tx> | null): SecretStore<Tx> {
  if (!secrets) throw new DomainError('secrets.unavailable');
  return secrets;
}

async function loadUser(db: Db | Tx, userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new DomainError('user.not_found');
  return u;
}

export interface MfaStatus {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly recoveryCodesLeft: number;
}

export async function mfaStatus(db: Db, userId: string): Promise<MfaStatus> {
  const u = await loadUser(db, userId);
  const left = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from identity.mfa_recovery_codes where user_id = ${userId} and used_at is null`,
  );
  return {
    enabled: u.mfaEnabledAt !== null,
    pending: u.mfaEnabledAt === null && u.mfaSecretRef !== null,
    recoveryCodesLeft: u.mfaEnabledAt ? (left.rows[0]?.n ?? 0) : 0,
  };
}

/**
 * Starts enrollment: a new secret, stored as pending until a code confirms it. Starting again
 * replaces a pending secret. Returns the secret and its otpauth URI for the authenticator app.
 */
export async function beginMfaEnrollment(
  db: Db,
  secretStore: SecretStore<Tx> | null,
  principal: Principal,
): Promise<{ secret: string; otpauthUri: string }> {
  const secrets = requireSecrets(secretStore);
  const secret = newTotpSecret();
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, principal.userId)).for('update');
    if (!u) throw new DomainError('user.not_found');
    if (u.mfaEnabledAt) throw new DomainError('mfa.already_enabled');
    if (u.mfaSecretRef) {
      await secrets.rotate(u.mfaSecretRef, secret, tx);
    } else {
      const ref = await secrets.put(
        { ownerType: 'user', ownerId: u.id, purpose: 'mfa_totp', value: secret },
        tx,
      );
      await tx.update(users).set({ mfaSecretRef: ref }).where(eq(users.id, u.id));
    }
  });
  return { secret, otpauthUri: otpauthUri(MFA_ISSUER, principal.email, secret) };
}

/** Confirms enrollment with a code from the app. Returns the recovery codes, shown once. */
export async function confirmMfaEnrollment(
  db: Db,
  secretStore: SecretStore<Tx> | null,
  principal: Principal,
  code: string,
  now: Date = new Date(),
): Promise<{ recoveryCodes: string[] }> {
  const secrets = requireSecrets(secretStore);
  const codes = newRecoveryCodes();
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, principal.userId)).for('update');
    if (!u) throw new DomainError('user.not_found');
    if (u.mfaEnabledAt) throw new DomainError('mfa.already_enabled');
    if (!u.mfaSecretRef) throw new DomainError('mfa.not_enrolling');
    const step = verifyTotp(await secrets.get(u.mfaSecretRef), code.trim(), now);
    if (step === null) throw new DomainError('mfa.code_invalid');
    await tx.update(users).set({ mfaEnabledAt: now, mfaLastStep: step }).where(eq(users.id, u.id));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, u.id));
    await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: u.id, codeHash: hashCode(c) })));
    await appendAudit(tx, {
      orgId: u.orgId,
      actorType: 'user',
      actorId: u.id,
      action: 'identity.mfa.enabled',
      targetType: 'user',
      targetId: u.id,
      summary: { recoveryCodes: codes.length },
      source: 'api',
    });
  });
  return { recoveryCodes: codes };
}

/** Removes MFA from an account: secret, recovery codes and open challenges. */
async function clearMfa(tx: Tx, secrets: SecretStore<Tx>, user: { id: string; mfaSecretRef: string | null }) {
  if (user.mfaSecretRef) await secrets.delete(user.mfaSecretRef, tx);
  await tx
    .update(users)
    .set({ mfaSecretRef: null, mfaEnabledAt: null, mfaLastStep: null })
    .where(eq(users.id, user.id));
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id));
  await tx.delete(mfaChallenges).where(eq(mfaChallenges.userId, user.id));
}

/** The user turns MFA off: needs the password and a current code (or a recovery code). */
export async function disableOwnMfa(
  db: Db,
  secretStore: SecretStore<Tx> | null,
  principal: Principal,
  input: { password: string; code: string },
  now: Date = new Date(),
): Promise<void> {
  const secrets = requireSecrets(secretStore);
  const outcome = await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, principal.userId)).for('update');
    if (!u?.passwordHash || !u.mfaEnabledAt || !u.mfaSecretRef) throw new DomainError('mfa.not_enabled');
    const passwordOk = await argon2.verify(u.passwordHash, input.password).catch(() => false);
    if (!passwordOk || !(await secondFactorOk(tx, secrets, u, input.code, now))) return 'invalid' as const;
    await clearMfa(tx, secrets, u);
    await appendAudit(tx, {
      orgId: u.orgId,
      actorType: 'user',
      actorId: u.id,
      action: 'identity.mfa.disabled',
      targetType: 'user',
      targetId: u.id,
      summary: { by: 'self' },
      source: 'api',
    });
    return 'ok' as const;
  });
  if (outcome === 'invalid') throw new DomainError('mfa.code_invalid');
}

/** An administrator removes MFA from someone who lost their device. Audited. */
export async function resetUserMfa(
  db: Db,
  secretStore: SecretStore<Tx> | null,
  actor: Principal,
  userId: string,
): Promise<void> {
  const secrets = requireSecrets(secretStore);
  await db.transaction(async (tx) => {
    const [u] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, actor.orgId)))
      .for('update');
    if (!u) throw new DomainError('user.not_found');
    await clearMfa(tx, secrets, u);
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.mfa.reset',
      targetType: 'user',
      targetId: u.id,
      summary: {},
      source: 'api',
    });
  });
}

/**
 * Checks a TOTP code (refusing reuse of a step already accepted) or consumes a recovery code.
 * Both updates are conditional, so two concurrent requests cannot both use the same code.
 */
async function secondFactorOk(
  tx: Tx,
  secrets: SecretStore<Tx>,
  user: { id: string; mfaSecretRef: string | null; mfaLastStep: number | null },
  code: string,
  now: Date,
): Promise<boolean> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    if (!user.mfaSecretRef) return false;
    const step = verifyTotp(await secrets.get(user.mfaSecretRef), trimmed, now, user.mfaLastStep);
    if (step === null) return false;
    const res = await tx.execute(
      sql`update identity.users set mfa_last_step = ${step}
          where id = ${user.id} and (mfa_last_step is null or mfa_last_step < ${step})`,
    );
    return (res.rowCount ?? 0) === 1;
  }
  if (trimmed.length < 8 || trimmed.length > 20) return false;
  const used = await tx
    .update(mfaRecoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, user.id),
        eq(mfaRecoveryCodes.codeHash, hashCode(trimmed)),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ userId: mfaRecoveryCodes.userId });
  return used.length === 1;
}

/**
 * Second login step. A challenge allows MFA_MAX_ATTEMPTS codes and then disappears; every
 * failure is audited. Failures are recorded after the transaction commits, so they count.
 */
export async function verifyMfaLogin(
  db: Db,
  secretStore: SecretStore<Tx> | null,
  input: { challengeToken: string; code: string },
  client: ClientInfo,
  policy: SessionPolicy,
  now: Date = new Date(),
): Promise<SessionIssued> {
  const secrets = requireSecrets(secretStore);
  const invalid = new DomainError('auth.mfa_invalid');
  if (typeof input.challengeToken !== 'string' || input.challengeToken.length > 200) throw invalid;
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ challenge: mfaChallenges, user: users })
      .from(mfaChallenges)
      .innerJoin(users, eq(users.id, mfaChallenges.userId))
      .where(eq(mfaChallenges.id, hashOpaque(input.challengeToken)))
      .for('update');
    if (!row) return { kind: 'invalid' as const };
    const { challenge, user } = row;
    if (
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attempts >= MFA_MAX_ATTEMPTS ||
      user.status !== 'active' ||
      !user.mfaEnabledAt
    ) {
      await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
      return { kind: 'invalid' as const };
    }
    if (!(await secondFactorOk(tx, secrets, user, input.code, now))) {
      return { kind: 'failed' as const, challengeId: challenge.id, user };
    }
    await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
    return { kind: 'ok' as const, session: await issueSession(tx, user, client, policy, 'mfa') };
  });
  if (outcome.kind === 'ok') return outcome.session;
  if (outcome.kind === 'failed') {
    await db.transaction(async (tx) => {
      await tx
        .update(mfaChallenges)
        .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
        .where(eq(mfaChallenges.id, outcome.challengeId));
      await appendAudit(tx, {
        orgId: outcome.user.orgId,
        actorType: 'user',
        actorId: outcome.user.id,
        action: 'identity.login.failed',
        targetType: 'user',
        targetId: outcome.user.id,
        summary: { reason: 'mfa_code' },
        source: 'api',
        ip: client.ip ?? null,
      });
    });
  }
  throw invalid;
}

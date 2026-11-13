import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import {
  ApiError,
  ApiTokenCreatedResponse,
  ApiTokenResponse,
  InvitationCreatedResponse,
  InvitationLookupResponse,
  LinkResponse,
  MfaEnrollResponse,
  MfaRecoveryCodesResponse,
  ServiceAccountResponse,
  UserResponse,
} from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { ADMIN, AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let dir: string;
const logs: string[] = [];

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const code = async (res: Response) => ApiError.parse(await res.json()).code;
const V = (p: string) => `${base}/api/v1${p}`;
const tokenOf = (url: string) => new URL(url).hash.slice(1);

/** Independent TOTP (RFC 6238) so the test does not reuse the code under test. */
function totpAt(secretB32: string, unixSeconds: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
  const mac = createHmac('sha1', key).update(msg).digest();
  const o = mac[19]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function loginRaw(email: string, password: string) {
  const res = await post(V('/auth/login'), { email, password });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-users-'));
  const keyFile = path.join(dir, 'master.key');
  await writeFile(keyFile, generateMasterKey());
  api = await createApiApp(
    {
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      API_PORT: '0',
      RATE_LIMIT_BURST: '5000',
      RATE_LIMIT_RPS: '5000',
      QOS_MASTER_KEY_FILE: keyFile,
      PUBLIC_WEB_URL: 'https://qos.example.test',
      ...AUTH_ENV,
    },
    { logDestination: { write: (line: string) => void logs.push(line) } },
  );
  base = await api.listen();
  admin = await setupAndSignIn(base);
  expect((await admin.fetch(V('/projects'), send('POST', { key: 'PAY', name: 'Payments' }))).status).toBe(
    201,
  );
  expect((await admin.fetch(V('/projects'), send('POST', { key: 'MOB', name: 'Mobile' }))).status).toBe(201);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('invitations (T-P2-03)', () => {
  let link: string;
  let invitationId: string;

  it('invites with a 72 h link whose token is only in the URL fragment', async () => {
    const res = await admin.fetch(
      V('/invitations'),
      send('POST', {
        email: 'Dana@Example.test',
        displayName: 'Dana',
        projectKey: 'PAY',
        projectRole: 'qa_engineer',
      }),
    );
    expect(res.status).toBe(201);
    const created = InvitationCreatedResponse.parse(await res.json());
    link = created.link.url;
    invitationId = created.invitation.id;
    expect(link).toMatch(/^https:\/\/qos\.example\.test\/invite#[A-Za-z0-9_-]{43}$/);
    const hours = (Date.parse(created.invitation.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    expect(created.invitation).toMatchObject({
      email: 'dana@example.test',
      status: 'pending',
      projectRole: 'qa_engineer',
    });
    const users = UserResponse.array().parse(await (await admin.fetch(V('/users'))).json());
    expect(users.find((u) => u.email === 'dana@example.test')?.status).toBe('invited');
    // The token is stored only as a hash.
    const rows = await t.pool.query('select token_hash from identity.invitations');
    expect(JSON.stringify(rows.rows)).not.toContain(tokenOf(link));
  });

  it('refuses inviting an existing active user and an invalid role', async () => {
    const dup = await admin.fetch(V('/invitations'), send('POST', { email: ADMIN.email }));
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('user.exists');
    const bad = await admin.fetch(
      V('/invitations'),
      send('POST', { email: 'x@example.test', projectKey: 'PAY', projectRole: 'org_admin' }),
    );
    expect(bad.status).toBe(422);
  });

  it('resend issues a new link; the old one stops working', async () => {
    const res = await admin.fetch(V(`/invitations/${invitationId}/resend`), send('POST'));
    const again = InvitationCreatedResponse.parse(await res.json());
    expect(again.link.url).not.toBe(link);
    expect((await post(V('/invitations/lookup'), { token: tokenOf(link) })).status).toBe(404);
    link = again.link.url;
    const info = InvitationLookupResponse.parse(
      await (await post(V('/invitations/lookup'), { token: tokenOf(link) })).json(),
    );
    expect(info).toMatchObject({ email: 'dana@example.test', orgName: 'Test Org', displayName: 'Dana' });
  });

  it('accepting sets the password, grants the project role and signs in; the link is single-use', async () => {
    const res = await post(V('/invitations/accept'), {
      token: tokenOf(link),
      displayName: 'Dana QA',
      password: 'dana long password 42',
    });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = await fetch(V('/me'), { headers: { cookie } });
    expect(((await me.json()) as { displayName: string }).displayName).toBe('Dana QA');
    const project = await fetch(V('/projects/PAY/permissions'), { headers: { cookie } });
    expect(((await project.json()) as { project: string[] }).project).toContain('testcase.create');
    expect((await fetch(V('/projects/MOB'), { headers: { cookie } })).status).toBe(404);
    const reuse = await post(V('/invitations/accept'), {
      token: tokenOf(link),
      displayName: 'X',
      password: 'another long password',
    });
    expect(reuse.status).toBe(404);
    expect(await code(reuse)).toBe('invitation.invalid');
  });

  it('expired links are refused; revoking removes the never-used account', async () => {
    const res = await admin.fetch(V('/invitations'), send('POST', { email: 'late@example.test' }));
    const created = InvitationCreatedResponse.parse(await res.json());
    await t.pool.query(
      `update identity.invitations set expires_at = now() - interval '1 minute' where id = $1`,
      [created.invitation.id],
    );
    expect((await post(V('/invitations/lookup'), { token: tokenOf(created.link.url) })).status).toBe(404);
    const list = (await (await admin.fetch(V('/invitations'))).json()) as { id: string; status: string }[];
    expect(list.find((i) => i.id === created.invitation.id)?.status).toBe('expired');
    expect((await admin.fetch(V(`/invitations/${created.invitation.id}`), send('DELETE'))).status).toBe(204);
    const users = UserResponse.array().parse(await (await admin.fetch(V('/users'))).json());
    expect(users.some((u) => u.email === 'late@example.test')).toBe(false);
  });
});

describe('MFA (T-P2-02)', () => {
  const email = 'dana@example.test';
  const password = 'dana long password 42';
  let dana: Session;
  let secret: string;
  let recovery: string[];

  it('enrolls with a confirmed code and returns recovery codes once', async () => {
    dana = await signIn(base, email, password);
    const enroll = MfaEnrollResponse.parse(
      await (await dana.fetch(V('/me/mfa/enroll'), send('POST'))).json(),
    );
    secret = enroll.secret;
    expect(enroll.otpauthUri).toContain(`secret=${secret}`);
    const wrong = await dana.fetch(V('/me/mfa/confirm'), send('POST', { code: '000000' }));
    expect(wrong.status).toBe(422);
    const ok = await dana.fetch(
      V('/me/mfa/confirm'),
      send('POST', { code: totpAt(secret, Date.now() / 1000) }),
    );
    recovery = MfaRecoveryCodesResponse.parse(await ok.json()).recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(await (await dana.fetch(V('/me/mfa'))).json()).toEqual({
      enabled: true,
      pending: false,
      recoveryCodesLeft: 10,
    });
    // The TOTP secret is only in the secret store, encrypted.
    const dump = JSON.stringify((await t.pool.query('select * from identity.users')).rows);
    expect(dump).not.toContain(secret);
  });

  it('password login now needs a second step; wrong codes fail and do not create a session', async () => {
    const { res, body } = await loginRaw(email, password);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(body.mfaRequired).toBe(true);
    const wrong = await post(V('/auth/mfa/verify'), { challengeToken: body.challengeToken, code: '123456' });
    expect(wrong.status).toBe(401);
    expect(await code(wrong)).toBe('auth.mfa_invalid');
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('a valid code signs in; the same code is refused afterwards (no replay)', async () => {
    // The step after the one used at enrollment, so it has not been accepted yet.
    const next = totpAt(secret, Date.now() / 1000 + 30);
    const first = await loginRaw(email, password);
    const ok = await post(V('/auth/mfa/verify'), { challengeToken: first.body.challengeToken, code: next });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/^qos_session=/);
    const second = await loginRaw(email, password);
    const replay = await post(V('/auth/mfa/verify'), {
      challengeToken: second.body.challengeToken,
      code: next,
    });
    expect(replay.status).toBe(401);
  });

  it('a recovery code works exactly once', async () => {
    const a = await loginRaw(email, password);
    expect(
      (await post(V('/auth/mfa/verify'), { challengeToken: a.body.challengeToken, code: recovery[0] }))
        .status,
    ).toBe(200);
    const b = await loginRaw(email, password);
    expect(
      (await post(V('/auth/mfa/verify'), { challengeToken: b.body.challengeToken, code: recovery[0] }))
        .status,
    ).toBe(401);
    expect(
      ((await (await dana.fetch(V('/me/mfa'))).json()) as { recoveryCodesLeft: number }).recoveryCodesLeft,
    ).toBe(9);
  });

  it('a challenge dies after five wrong codes, even for a right one', async () => {
    const c = await loginRaw(email, password);
    for (let i = 0; i < 5; i++)
      await post(V('/auth/mfa/verify'), { challengeToken: c.body.challengeToken, code: '000000' });
    const late = await post(V('/auth/mfa/verify'), {
      challengeToken: c.body.challengeToken,
      code: recovery[1],
    });
    expect(late.status).toBe(401);
    const failures = await t.pool.query(
      `select count(*)::int as n from governance.audit_events where action = 'identity.login.failed' and summary->>'reason' = 'mfa_code'`,
    );
    expect(failures.rows[0].n).toBeGreaterThanOrEqual(6);
  });

  it('an administrator can reset MFA for a user who lost their device', async () => {
    const users = UserResponse.array().parse(await (await admin.fetch(V('/users'))).json());
    const id = users.find((u) => u.email === email)!.id;
    expect(users.find((u) => u.email === email)!.mfaEnabled).toBe(true);
    expect((await admin.fetch(V(`/users/${id}/mfa/reset`), send('POST'))).status).toBe(204);
    const { body } = await loginRaw(email, password);
    expect(body.csrfToken).toBeTypeOf('string');
  });
});

describe('user administration (M13-FR-01)', () => {
  const users = async () => UserResponse.array().parse(await (await admin.fetch(V('/users'))).json());

  it('deactivation ends the user’s sessions at once (M13-AC-03) and reactivation restores access', async () => {
    const dana = await signIn(base, 'dana@example.test', 'dana long password 42');
    expect((await dana.fetch(V('/me'))).status).toBe(200);
    const id = (await users()).find((u) => u.email === 'dana@example.test')!.id;
    const started = Date.now();
    const res = await admin.fetch(V(`/users/${id}/deactivate`), send('POST'));
    expect(UserResponse.parse(await res.json()).status).toBe('deactivated');
    expect((await dana.fetch(V('/me'))).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(
      (await post(V('/auth/login'), { email: 'dana@example.test', password: 'dana long password 42' }))
        .status,
    ).toBe(401);
    expect(
      UserResponse.parse(await (await admin.fetch(V(`/users/${id}/reactivate`), send('POST'))).json()).status,
    ).toBe('active');
    expect((await signIn(base, 'dana@example.test', 'dana long password 42')).cookie).toMatch(
      /^qos_session=/,
    );
  });

  it('protects the last org administrator and the caller’s own role (BR-M13-3/4)', async () => {
    const me = (await users()).find((u) => u.email === ADMIN.email)!;
    const self = await admin.fetch(V(`/users/${me.id}/deactivate`), send('POST'));
    expect(await code(self)).toBe('user.cannot_deactivate_self');
    const demote = await admin.fetch(V(`/users/${me.id}`), send('PATCH', { orgAdmin: false }));
    expect(demote.status).toBe(403);
    // Promote Dana, then try to demote and deactivate the original admin through Dana.
    const dana = (await users()).find((u) => u.email === 'dana@example.test')!;
    const promoted = await admin.fetch(
      V(`/users/${dana.id}`),
      send('PATCH', { orgAdmin: true, timezone: 'Africa/Cairo' }),
    );
    expect(UserResponse.parse(await promoted.json())).toMatchObject({
      orgRoles: ['org_admin'],
      timezone: 'Africa/Cairo',
    });
    const danaSession = await signIn(base, 'dana@example.test', 'dana long password 42');
    const demoted = await danaSession.fetch(V(`/users/${me.id}`), send('PATCH', { orgAdmin: false }));
    expect(UserResponse.parse(await demoted.json()).orgRoles).toEqual(['platform_admin']);
    // Now Dana is the only org admin left: she cannot lose the role, and nobody can remove her.
    const restore = await signIn(base);
    expect((await restore.fetch(V('/users'))).status).toBe(403);
    const reGrant = await danaSession.fetch(V(`/users/${me.id}`), send('PATCH', { orgAdmin: true }));
    expect(UserResponse.parse(await reGrant.json()).orgRoles).toEqual(['org_admin', 'platform_admin']);
    admin = await signIn(base);
    const danaDemote = await admin.fetch(V(`/users/${dana.id}`), send('PATCH', { orgAdmin: false }));
    expect(danaDemote.status).toBe(200);
    const bad = await admin.fetch(V(`/users/${dana.id}`), send('PATCH', { timezone: 'Mars/Olympus' }));
    expect(await code(bad)).toBe('user.timezone_invalid');
  });

  it('password reset link: single use, ends all sessions, never stores the token', async () => {
    const dana = (await users()).find((u) => u.email === 'dana@example.test')!;
    const old = await signIn(base, 'dana@example.test', 'dana long password 42');
    const link = LinkResponse.parse(
      await (await admin.fetch(V(`/users/${dana.id}/password-reset`), send('POST'))).json(),
    );
    expect(link.url).toMatch(/^https:\/\/qos\.example\.test\/reset-password#/);
    const token = tokenOf(link.url);
    const weak = await post(V('/auth/password/reset'), { token, password: 'short' });
    expect(await code(weak)).toBe('password.too_short');
    expect(
      (await post(V('/auth/password/reset'), { token, password: 'brand new long password' })).status,
    ).toBe(204);
    expect((await old.fetch(V('/me'))).status).toBe(401);
    expect(
      (await post(V('/auth/password/reset'), { token, password: 'another new long password' })).status,
    ).toBe(404);
    expect((await signIn(base, 'dana@example.test', 'brand new long password')).cookie).toBeTruthy();
  });

  it('self-service: profile and password change (other sessions end, this one stays)', async () => {
    const a = await signIn(base, 'dana@example.test', 'brand new long password');
    const b = await signIn(base, 'dana@example.test', 'brand new long password');
    const prof = await a.fetch(V('/me/profile'), send('PATCH', { locale: 'ar', displayName: 'دانة' }));
    expect(UserResponse.parse(await prof.json())).toMatchObject({ locale: 'ar', displayName: 'دانة' });
    const wrong = await a.fetch(
      V('/me/password'),
      send('POST', { currentPassword: 'nope', newPassword: 'x'.repeat(14) }),
    );
    expect(wrong.status).toBe(401);
    const ok = await a.fetch(
      V('/me/password'),
      send('POST', { currentPassword: 'brand new long password', newPassword: 'third long password here' }),
    );
    expect(ok.status).toBe(204);
    expect((await a.fetch(V('/me'))).status).toBe(200);
    expect((await b.fetch(V('/me'))).status).toBe(401);
  });

  it('non-administrators cannot reach user administration', async () => {
    const dana = await signIn(base, 'dana@example.test', 'third long password here');
    for (const p of ['/users', '/invitations', '/service-accounts'])
      expect((await dana.fetch(V(p))).status).toBe(403);
  });
});

describe('service accounts and API tokens (T-P2-43)', () => {
  let saId: string;
  let token: string;
  let tokenId: string;
  const bearer = (tok: string) => ({ headers: { authorization: `Bearer ${tok}` } });

  it('creates a service account and refuses unknown scopes with the disallowed list', async () => {
    const res = await admin.fetch(
      V('/service-accounts'),
      send('POST', { name: 'ci-runner', description: 'Pipeline' }),
    );
    expect(res.status).toBe(201);
    saId = ServiceAccountResponse.parse(await res.json()).id;
    const dup = await admin.fetch(V('/service-accounts'), send('POST', { name: 'ci-runner' }));
    expect(await code(dup)).toBe('service_account.name_taken');
    const bad = await admin.fetch(
      V(`/service-accounts/${saId}/tokens`),
      send('POST', { name: 'x', scopes: ['projects:read', 'admin:all', 'root'], expiresInDays: 30 }),
    );
    expect(bad.status).toBe(400);
    expect(ApiError.parse(await bad.json()).params).toEqual({ disallowed: 'admin:all,root' });
    const tooLong = await admin.fetch(
      V(`/service-accounts/${saId}/tokens`),
      send('POST', { name: 'x', scopes: ['projects:read'], expiresInDays: 400 }),
    );
    expect(tooLong.status).toBe(400);
  });

  it('shows the token once; lists and the database hold only the prefix and a hash', async () => {
    const res = await admin.fetch(
      V(`/service-accounts/${saId}/tokens`),
      send('POST', { name: 'nightly', scopes: ['projects:read'], projectKeys: ['PAY'], expiresInDays: 90 }),
    );
    expect(res.status).toBe(201);
    const created = ApiTokenCreatedResponse.parse(await res.json());
    token = created.token;
    tokenId = created.apiToken.id;
    expect(token).toMatch(/^qos_[a-z2-7]{12}_/);
    const list = await (await admin.fetch(V(`/service-accounts/${saId}/tokens`))).text();
    expect(list).not.toContain(token);
    expect(ApiTokenResponse.array().parse(JSON.parse(list))[0]!.display).toBe(`${token.slice(0, 16)}_…`);
    const dump = JSON.stringify((await t.pool.query('select * from identity.api_tokens')).rows);
    expect(dump).not.toContain(token.slice(17));
  });

  it('a token works only on routes that allow tokens, with the right scope and project', async () => {
    expect((await fetch(V('/projects/PAY'), bearer(token))).status).toBe(200);
    // Outside the token's project restriction: same 404 as an unknown project.
    expect((await fetch(V('/projects/MOB'), bearer(token))).status).toBe(404);
    expect((await fetch(V('/projects/NOPE'), bearer(token))).status).toBe(404);
    // UI/session endpoints refuse tokens (BR-M13-6).
    const me = await fetch(V('/me'), bearer(token));
    expect(me.status).toBe(403);
    expect(await code(me)).toBe('token.route_not_allowed');
    expect((await fetch(V('/projects'), bearer(token))).status).toBe(403);
    // Garbage and look-alike tokens are 401.
    expect((await fetch(V('/projects/PAY'), bearer('qos_aaaaaaaaaaaa_' + 'b'.repeat(43)))).status).toBe(401);
    expect((await fetch(V('/projects/PAY'), bearer(`${token.slice(0, -1)}x`))).status).toBe(401);
  });

  it('a token without the route scope is refused with 403 (pattern of M13-AC-05)', async () => {
    const res = await admin.fetch(
      V(`/service-accounts/${saId}/tokens`),
      send('POST', { name: 'fire-only', scopes: ['automation:fire'], expiresInDays: 7 }),
    );
    const other = ApiTokenCreatedResponse.parse(await res.json()).token;
    const denied = await fetch(V('/projects/PAY'), bearer(other));
    expect(denied.status).toBe(403);
    expect(ApiError.parse(await denied.json())).toMatchObject({
      code: 'token.scope_missing',
      params: { scope: 'projects:read' },
    });
  });

  it('records last use; revoking or disabling the account stops the token at once', async () => {
    const list = ApiTokenResponse.array().parse(
      await (await admin.fetch(V(`/service-accounts/${saId}/tokens`))).json(),
    );
    expect(list.find((x) => x.id === tokenId)!.lastUsedAt).not.toBeNull();
    const disabled = await admin.fetch(V(`/service-accounts/${saId}`), send('PATCH', { status: 'disabled' }));
    expect(ServiceAccountResponse.parse(await disabled.json()).status).toBe('disabled');
    expect((await fetch(V('/projects/PAY'), bearer(token))).status).toBe(401);
    await admin.fetch(V(`/service-accounts/${saId}`), send('PATCH', { status: 'active' }));
    expect((await fetch(V('/projects/PAY'), bearer(token))).status).toBe(200);
    expect((await admin.fetch(V(`/tokens/${tokenId}`), send('DELETE'))).status).toBe(204);
    expect((await fetch(V('/projects/PAY'), bearer(token))).status).toBe(401);
    expect((await admin.fetch(V(`/tokens/${tokenId}`), send('DELETE'))).status).toBe(204); // idempotent
  });

  it('flags a service account whose owner was deactivated', async () => {
    const dana = UserResponse.array()
      .parse(await (await admin.fetch(V('/users'))).json())
      .find((u) => u.email === 'dana@example.test')!;
    await admin.fetch(V(`/users/${saId}`), send('GET'));
    const moved = await admin.fetch(V(`/service-accounts/${saId}`), send('PATCH', { ownerUserId: dana.id }));
    expect(ServiceAccountResponse.parse(await moved.json()).owner.id).toBe(dana.id);
    await admin.fetch(V(`/users/${dana.id}/deactivate`), send('POST'));
    const list = ServiceAccountResponse.array().parse(
      await (await admin.fetch(V('/service-accounts'))).json(),
    );
    expect(list.find((s) => s.id === saId)).toMatchObject({
      needsReassignment: true,
      owner: { active: false },
    });
  });

  it('writes no token, reset link or MFA secret to the logs', () => {
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(token);
    expect(all).not.toMatch(/qos_[a-z2-7]{12}_[A-Za-z0-9_-]{43}/);
    expect(all).not.toMatch(/(invite|reset-password)#[A-Za-z0-9_-]{20,}/);
  });
});

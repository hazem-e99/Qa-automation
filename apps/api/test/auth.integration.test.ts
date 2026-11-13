import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, MeResponse, PermissionsResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { hashPassword } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { listRoutes } from '../dist/route-inventory.js';
import { ADMIN, AUTH_ENV, runSetup, SETUP_TOKEN, signIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
const env = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: t.url,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_BURST: '1000',
  RATE_LIMIT_RPS: '1000',
  ...AUTH_ENV,
  ...extra,
});
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const code = async (res: Response) => ApiError.parse(await res.json()).code;

beforeAll(async () => {
  t = await startTestDatabase();
  api = await createApiApp(env({ API_PORT: '0' }));
  base = await api.listen();
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
});

describe('route inventory (M13-AC-01)', () => {
  it('every route declares its access, and only an explicit short list is public', () => {
    const routes = listRoutes(api.app);
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes.filter((r) => r.access === null)).toEqual([]);
    const isPublic = routes
      .filter((r) => r.access?.kind === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(isPublic).toEqual([
      'GET /files/*',
      'GET /healthz',
      'GET /readyz',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/mfa/verify',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/invitations/accept',
      'POST /api/v1/invitations/lookup',
      'POST /api/v1/setup',
    ]);
  });

  it('protected routes answer 401 without a session', async () => {
    for (const r of listRoutes(api.app).filter((x) => x.access?.kind !== 'public')) {
      const path = r.path.replace(':id', '0190a5e0-7c1a-7000-8000-000000000001');
      const res = await fetch(base + path, { method: r.method });
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(await code(res)).toBe('http.401');
    }
  });
});

describe('first-run setup', () => {
  it('needs the setup token, validates input, works once, then refuses', async () => {
    const noToken = await fetch(`${base}/api/v1/setup`, json(ADMIN));
    expect(noToken.status).toBe(403);
    const wrong = await fetch(
      `${base}/api/v1/setup`,
      json(ADMIN, { 'x-setup-token': 'x'.repeat(SETUP_TOKEN.length) }),
    );
    expect(wrong.status).toBe(403);

    const weak = await runSetup(base, { ...ADMIN, password: 'short' });
    expect(weak.status).toBe(400);
    expect(await code(weak)).toBe('password.too_short');

    expect((await runSetup(base)).status).toBe(201);
    const again = await runSetup(base, { ...ADMIN, email: 'other@example.test' });
    expect(again.status).toBe(409);
    expect(await code(again)).toBe('setup.already_done');
  });

  it('is absent (404) when no setup token is configured', async () => {
    const plain = await createApiApp({
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      API_PORT: '0',
      WEBHOOK_PORT: '0',
    });
    const url = await plain.listen();
    try {
      expect((await fetch(`${url}/api/v1/setup`, json(ADMIN, { 'x-setup-token': SETUP_TOKEN }))).status).toBe(
        404,
      );
    } finally {
      await plain.close();
    }
  });
});

describe('login, session cookie and CSRF', () => {
  let s: Session;

  it('rejects bad credentials with one generic error', async () => {
    for (const body of [
      { email: ADMIN.email, password: 'definitely wrong' },
      { email: 'ghost@example.test', password: ADMIN.password },
    ]) {
      const res = await fetch(`${base}/api/v1/auth/login`, json(body));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe('auth.invalid_credentials');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('sets an HttpOnly, SameSite=Lax cookie and returns the CSRF token', async () => {
    const res = await fetch(
      `${base}/api/v1/auth/login`,
      json({ email: ADMIN.email, password: ADMIN.password }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^qos_session=[A-Za-z0-9_-]{40,};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure'); // COOKIE_SECURE=false in this test only
    expect(res.headers.get('cache-control')).toBe('no-store');
    s = await signIn(base);
  });

  it('marks the cookie Secure by default', async () => {
    const secure = await createApiApp({ ...env({ API_PORT: '0' }), COOKIE_SECURE: 'true' });
    const url = await secure.listen();
    try {
      const res = await fetch(
        `${url}/api/v1/auth/login`,
        json({ email: ADMIN.email, password: ADMIN.password }),
      );
      expect(res.headers.get('set-cookie')).toContain('Secure');
    } finally {
      await secure.close();
    }
  });

  it('serves /me and /me/permissions to the signed-in user', async () => {
    const me = MeResponse.parse(await (await s.fetch(`${base}/api/v1/me`)).json());
    expect(me).toMatchObject({ email: ADMIN.email, csrfToken: s.csrfToken });
    expect([...me.orgRoles].sort()).toEqual(['org_admin', 'platform_admin']);
    const perms = PermissionsResponse.parse(await (await s.fetch(`${base}/api/v1/me/permissions`)).json());
    expect(perms.org).toEqual(
      expect.arrayContaining(['user.manage', 'system.settings', 'connection.manage']),
    );
  });

  it('refuses a state-changing request without the CSRF token, or with a wrong one', async () => {
    const probe = `${base}/api/v1/platform/probes`;
    const noHeader = await fetch(probe, json({ label: 'x' }, { cookie: s.cookie }));
    expect(noHeader.status).toBe(403);
    expect(await code(noHeader)).toBe('csrf.invalid');
    const wrong = await fetch(
      probe,
      json({ label: 'x' }, { cookie: s.cookie, 'x-csrf-token': 'A'.repeat(43) }),
    );
    expect(wrong.status).toBe(403);
    const other = await signIn(base); // a valid token of another session does not work either
    const crossed = await fetch(
      probe,
      json({ label: 'x' }, { cookie: s.cookie, 'x-csrf-token': other.csrfToken }),
    );
    expect(crossed.status).toBe(403);
    expect((await s.fetch(probe, json({ label: 'ok' }))).status).toBe(201);
  });

  it('logout ends the session; the old cookie stops working at once', async () => {
    const temp = await signIn(base);
    const out = await temp.fetch(`${base}/api/v1/auth/logout`, { method: 'POST' });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await temp.fetch(`${base}/api/v1/me`)).status).toBe(401);
    expect((await s.fetch(`${base}/api/v1/me`)).status).toBe(200);
  });

  it('ignores a forged or malformed cookie', async () => {
    for (const cookie of ['qos_session=forged-value-that-is-long-enough-000000', 'qos_session=', 'other=1']) {
      expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status, cookie).toBe(401);
    }
  });
});

describe('permissions', () => {
  it('a signed-in user without the permission gets 403, and deactivation cuts access at once', async () => {
    const id = uuidv7();
    const org = (await t.pool.query('select id from identity.organizations')).rows[0].id;
    await t.pool.query(
      `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
       values ($1, $2, 'member@example.test', 'Member', $3, 'active', now())`,
      [id, org, await hashPassword('member long password')],
    );
    const member = await signIn(base, 'member@example.test', 'member long password');
    expect((await member.fetch(`${base}/api/v1/me`)).status).toBe(200);
    const denied = await member.fetch(`${base}/api/v1/platform/probes`, json({ label: 'no' }));
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('forbidden');
    const perms = PermissionsResponse.parse(
      await (await member.fetch(`${base}/api/v1/me/permissions`)).json(),
    );
    expect(perms.org).toEqual([]);

    await t.pool.query("update identity.users set status = 'deactivated' where id = $1", [id]);
    expect((await member.fetch(`${base}/api/v1/me`)).status).toBe(401); // M13-AC-03
  });
});

describe('login throttling', () => {
  it('allows 5 attempts a minute by default, then answers 429 with Retry-After', async () => {
    const strict = await createApiApp({ ...env({ API_PORT: '0' }), LOGIN_ATTEMPTS_PER_MINUTE: '5' });
    const url = await strict.listen();
    try {
      const attempt = (email: string, password = 'guess guess guess') =>
        fetch(`${url}/api/v1/auth/login`, json({ email, password }));
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await attempt(ADMIN.email)).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
      const refused = await attempt(ADMIN.email);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await code(refused)).toBe('auth.rate_limited');
      // The right password does not get through while the account is throttled.
      expect((await attempt(ADMIN.email, ADMIN.password)).status).toBe(429);
    } finally {
      await strict.close();
    }
  });
});

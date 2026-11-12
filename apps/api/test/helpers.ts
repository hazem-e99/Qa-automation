/** Shared helpers for API integration tests: first-run setup and an authenticated fetch. */
export const SETUP_TOKEN = 'test-only-setup-token-0123456789abcdef';
export const ADMIN = {
  orgName: 'Test Org',
  email: 'admin@example.test',
  displayName: 'Test Admin',
  password: 'correct horse battery staple',
};

/** Extra environment for an API under test: setup enabled, cookies usable over plain HTTP. */
export const AUTH_ENV = {
  SETUP_TOKEN,
  COOKIE_SECURE: 'false',
  LOGIN_ATTEMPTS_PER_MINUTE: '1000',
  // Several apps run at once in some tests: let each webhook listener take a free port.
  WEBHOOK_PORT: '0',
};

export interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
  /** fetch with the session cookie, plus the CSRF header on state-changing requests. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export async function runSetup(base: string, body: Record<string, unknown> = ADMIN): Promise<Response> {
  return fetch(`${base}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': SETUP_TOKEN },
    body: JSON.stringify(body),
  });
}

export async function signIn(base: string, email = ADMIN.email, password = ADMIN.password): Promise<Session> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return {
    cookie,
    csrfToken,
    fetch: (url, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      if (!['GET', 'HEAD'].includes(method)) headers.set('x-csrf-token', csrfToken);
      return fetch(url, { ...init, headers });
    },
  };
}

/** Runs first-run setup (once per database) and signs the administrator in. */
export async function setupAndSignIn(base: string): Promise<Session> {
  const res = await runSetup(base);
  if (res.status !== 201 && res.status !== 409) throw new Error(`setup failed with ${res.status}`);
  return signIn(base);
}

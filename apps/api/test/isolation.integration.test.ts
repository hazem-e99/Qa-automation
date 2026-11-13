import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { requestApproval } from '@qos/governance';
import { hashPassword, login, resolveSession } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { listRoutes } from '../dist/route-inventory.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

/**
 * Isolation harness (T-P2-46). Two organizations, and in organization A two projects, each with
 * one of every resource that exists so far. Every route that takes an id is then called by
 * organization A's administrator — who holds every org permission — with ids that belong to
 * organization B, or to A's other project under A's own project key. Every call must answer 404,
 * exactly like an id that does not exist, and B's data must be byte-for-byte unchanged afterwards.
 * New routes are covered automatically; a route with a parameter this harness cannot fill fails.
 */
let t: TestDatabase;
let api: ApiApp;
let base: string;
let dir: string;
let a: Session; // org A administrator
let b: Session; // org B administrator
const PW = 'isolation long password';

type Ids = {
  project: string;
  env: string;
  binding: string;
  connection: string;
  user: string;
  invitation: string;
  serviceAccount: string;
  token: string;
  template: string;
  approval: string;
  operation: string;
};
let foreignOrg: Ids; // organization B
let otherProject: { key: string; env: string; binding: string }; // A's second project

const V = (p: string) => `${base}/api/v1${p}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const json = async <T>(res: Response): Promise<T> => {
  if (res.status >= 300) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

/** Bodies that would succeed against the caller's own resources, so a 404 proves isolation. */
const BODIES: Record<string, unknown> = {
  'PATCH /api/v1/projects/:key': { name: 'Hijacked' },
  'POST /api/v1/projects/:key/save-as-template': { name: 'Hijacked template' },
  'POST /api/v1/projects/:key/clone': { key: 'HIJ', name: 'Hijacked' },
  'PUT /api/v1/projects/:key/members/:userId': { role: 'viewer' },
  'PUT /api/v1/projects/:key/environments/:envId': { name: 'hijacked', baseUrls: ['https://x.example.test'] },
  'PUT /api/v1/projects/:key/settings/:section': { expectedVersion: 0, data: {} },
  'PUT /api/v1/projects/:key/approval-policies/:action': { rules: { minApprovals: 1 } },
  'POST /api/v1/connections/:id/rotate-secret': { credential: 'mock-hijack-credential' },
  'POST /api/v1/connections/:id/webhook': {},
  'POST /api/v1/approvals/:id/approve': {},
  'POST /api/v1/approvals/:id/reject': {},
  'PATCH /api/v1/users/:id': { displayName: 'Hijacked' },
  'PATCH /api/v1/service-accounts/:id': { status: 'disabled' },
  'POST /api/v1/service-accounts/:id/tokens': { name: 'hijack', scopes: ['projects:read'], expiresInDays: 1 },
};

/** Fills a route's parameters with foreign ids; null when the route has no parameter. */
function foreignPaths(route: { method: string; path: string }): string[] {
  if (!route.path.includes(':')) return [];
  const id = (() => {
    const p = route.path;
    if (p.startsWith('/api/v1/connections/')) return foreignOrg.connection;
    if (p.startsWith('/api/v1/users/')) return foreignOrg.user;
    if (p.startsWith('/api/v1/invitations/')) return foreignOrg.invitation;
    if (p.startsWith('/api/v1/service-accounts/')) return foreignOrg.serviceAccount;
    if (p.startsWith('/api/v1/tokens/')) return foreignOrg.token;
    if (p.startsWith('/api/v1/approvals/')) return foreignOrg.approval;
    if (p.startsWith('/api/v1/operations/')) return foreignOrg.operation;
    if (p.startsWith('/api/v1/platform/probes/')) return uuidv7(); // probes: platform-only test resource
    return null;
  })();
  const fill = (key: string, sub: { env: string; binding: string; user: string }) =>
    route.path
      .replace(':key', key)
      .replace(':envId', sub.env)
      .replace(':bindingId', sub.binding)
      .replace(':userId', sub.user)
      .replace(':templateId', foreignOrg.template)
      .replace(':section', 'quality')
      .replace(':action', 'testcase.approve')
      .replace(':id', id ?? ':id');
  const out = [fill('TWO', { env: foreignOrg.env, binding: foreignOrg.binding, user: foreignOrg.user })];
  // Own project key, sub-resource of another project (same org) or another org.
  if (/:envId|:bindingId|:userId/.test(route.path)) {
    out.push(fill('ONE', { env: otherProject.env, binding: otherProject.binding, user: foreignOrg.user }));
    out.push(fill('ONE', { env: foreignOrg.env, binding: foreignOrg.binding, user: foreignOrg.user }));
  }
  return out;
}

/** Fingerprint of everything organization B owns. */
async function orgBFingerprint(): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await t.pool.query(sql, [foreignOrg.project])).rows);
  const parts = await Promise.all([
    q(`select * from projects.projects where id = $1`),
    q(`select * from projects.project_environments where project_id = $1 order by id`),
    q(`select * from projects.project_bindings where project_id = $1 order by id`),
    q(`select * from projects.project_settings where project_id = $1 order by section`),
    q(`select * from identity.project_memberships where project_id = $1 order by user_id`),
    q(`select * from governance.approval_requests where project_id = $1 order by id`),
    q(`select * from governance.approval_policies where project_id = $1 order by action`),
    q(
      `select c.* from integrations.connections c join projects.projects p on p.org_id = c.org_id where p.id = $1 order by c.id`,
    ),
    q(
      `select u.id, u.display_name, u.status, u.password_hash from identity.users u join projects.projects p on p.org_id = u.org_id where p.id = $1 order by u.id`,
    ),
    q(
      `select i.* from identity.invitations i join projects.projects p on p.org_id = i.org_id where p.id = $1 order by i.id`,
    ),
    q(
      `select s.* from identity.service_accounts s join projects.projects p on p.org_id = s.org_id where p.id = $1 order by s.id`,
    ),
    q(
      `select k.id, k.revoked_at, k.scopes from identity.api_tokens k join projects.projects p on p.org_id = k.org_id where p.id = $1 order by k.id`,
    ),
    q(
      `select x.* from projects.project_templates x join projects.projects p on p.org_id = x.org_id where p.id = $1 order by x.id`,
    ),
  ]);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** One of every resource in a project, through the public API. */
async function populate(s: Session, key: string, connectionName: string) {
  await json(await s.fetch(V('/projects'), send('POST', { key, name: `Project ${key}`, isDemo: true })));
  const env = await json<{ id: string }>(
    await s.fetch(
      V(`/projects/${key}/environments`),
      send('POST', { name: 'staging', baseUrls: [`https://${key.toLowerCase()}.example.test`] }),
    ),
  );
  let conn = (await json<{ id: string; displayName: string }[]>(await s.fetch(V('/connections')))).find(
    (c) => c.displayName === connectionName,
  );
  if (!conn) {
    conn = await json(
      await s.fetch(
        V('/connections'),
        send('POST', {
          providerType: 'mock_repository',
          displayName: connectionName,
          authStrategy: 'pat',
          credential: 'mock-full',
        }),
      ),
    );
    await json(await s.fetch(V(`/connections/${conn!.id}/test`), send('POST')));
  }
  const binding = await json<{ id: string }>(
    await s.fetch(
      V(`/projects/${key}/bindings`),
      send('POST', { role: 'repository', connectionId: conn!.id }),
    ),
  );
  return { env: env.id, binding: binding.id, connection: conn!.id };
}

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-iso-'));
  const keyFile = path.join(dir, 'master.key');
  await writeFile(keyFile, generateMasterKey());
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '0',
    RATE_LIMIT_BURST: '10000',
    RATE_LIMIT_RPS: '10000',
    QOS_MASTER_KEY_FILE: keyFile,
    QOS_DEMO_MODE: 'true',
    ...AUTH_ENV,
  });
  base = await api.listen();
  a = await setupAndSignIn(base);

  // Organization B, created the way a second tenant would exist (enterprise mode, P13).
  const orgB = uuidv7();
  const adminB = uuidv7();
  await t.pool.query(
    `insert into identity.organizations (id, name, slug, created_at) values ($1, 'Org B', 'org-b', now())`,
    [orgB],
  );
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
     values ($1, $2, 'admin@b.example.test', 'Admin B', $3, 'active', now())`,
    [adminB, orgB, await hashPassword(PW)],
  );
  await t.pool.query(
    `insert into identity.org_memberships (org_id, user_id, role_id)
     select $1, $2, id from identity.roles where key in ('org_admin', 'platform_admin')`,
    [orgB, adminB],
  );
  b = await signIn(base, 'admin@b.example.test', PW);

  const bRes = await populate(b, 'TWO', 'Repo B');
  const sa = await json<{ id: string }>(
    await b.fetch(V('/service-accounts'), send('POST', { name: 'b-runner' })),
  );
  const token = await json<{ apiToken: { id: string } }>(
    await b.fetch(
      V(`/service-accounts/${sa.id}/tokens`),
      send('POST', { name: 'b', scopes: ['projects:read'], expiresInDays: 5 }),
    ),
  );
  const inv = await json<{ invitation: { id: string } }>(
    await b.fetch(V('/invitations'), send('POST', { email: 'new@b.example.test' })),
  );
  const tpl = await json<{ id: string }>(
    await b.fetch(V('/projects/TWO/save-as-template'), send('POST', { name: 'B template' })),
  );
  const probe = await json<{ operationId: string }>(
    await b.fetch(V('/platform/probes'), send('POST', { label: 'b' })),
  );
  const projectB = (await t.pool.query(`select id from projects.projects where key = 'TWO'`)).rows[0]
    .id as string;
  const session = await login(t.db, { email: 'admin@b.example.test', password: PW });
  if (session.kind !== 'session') throw new Error('unexpected MFA challenge');
  const principalB = (await resolveSession(t.db, session.token))!;
  const approval = await t.db.transaction((tx) =>
    requestApproval(tx, principalB, {
      projectId: projectB,
      action: 'testcase.approve',
      targetType: 'test_case',
      targetId: 'TWO-TC-1',
      contentHash: 'a'.repeat(64),
    }),
  );
  foreignOrg = {
    project: projectB,
    ...bRes,
    user: adminB,
    invitation: inv.invitation.id,
    serviceAccount: sa.id,
    token: token.apiToken.id,
    template: tpl.id,
    approval: (approval as { id: string }).id,
    operation: probe.operationId,
  };

  await populate(a, 'ONE', 'Repo A');
  const other = await populate(a, 'ONE2', 'Repo A');
  otherProject = { key: 'ONE2', env: other.env, binding: other.binding };
}, 240_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('isolation harness (T-P2-46)', () => {
  it('every parameterized route answers 404 for foreign ids, and the other side is untouched', async () => {
    const before = await orgBFingerprint();
    const onePolicies = JSON.stringify(
      (await t.pool.query(`select * from projects.project_environments order by id`)).rows,
    );
    const routes = listRoutes(api.app).filter((r) => r.access?.kind !== 'public' && r.path.includes(':'));
    expect(routes.length).toBeGreaterThanOrEqual(45);
    const failures: string[] = [];
    let calls = 0;
    for (const r of routes) {
      const body = BODIES[`${r.method} ${r.path}`];
      for (const p of foreignPaths(r)) {
        if (p.includes(':')) {
          failures.push(`${r.method} ${r.path}: parameter not covered by the harness`);
          continue;
        }
        const url = V(p.replace('/api/v1', '')) + (p.endsWith('/role-check') ? '?role=repository' : '');
        const res = await a.fetch(
          url,
          send(r.method, body ?? (['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined)),
        );
        calls++;
        if (res.status !== 404)
          failures.push(`${r.method} ${p} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
        else await res.body?.cancel();
      }
    }
    expect(failures).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(55);
    expect(await orgBFingerprint()).toBe(before);
    // A's other project was not changed through A's own key either.
    const after = JSON.stringify(
      (await t.pool.query(`select * from projects.project_environments order by id`)).rows,
    );
    expect(after).toBe(onePolicies);
  });

  it('organization B still works normally afterwards', async () => {
    expect((await b.fetch(V('/projects/TWO'))).status).toBe(200);
    expect((await b.fetch(V(`/connections/${foreignOrg.connection}`))).status).toBe(200);
    expect((await b.fetch(V(`/operations/${foreignOrg.operation}`))).status).toBe(200);
    expect((await b.fetch(V(`/service-accounts/${foreignOrg.serviceAccount}/tokens`))).status).toBe(200);
  });

  it('lists never include the other organization’s rows', async () => {
    for (const p of [
      '/projects',
      '/connections',
      '/users',
      '/invitations',
      '/service-accounts',
      '/project-templates',
    ]) {
      const text = await (await a.fetch(V(p))).text();
      for (const id of Object.values(foreignOrg)) expect(text, p).not.toContain(id);
      expect(text, p).not.toContain('b.example.test');
    }
  });
});

describe('audit explorer API (T-P2-56)', () => {
  type Page = {
    items: { id: string; action: string; projectId: string | null }[];
    nextCursor: string | null;
  };

  it('searches only the caller’s organization and refuses foreign projects', async () => {
    const all = await json<Page>(await a.fetch(V('/audit?limit=200')));
    expect(all.items.length).toBeGreaterThan(5);
    expect(JSON.stringify(all)).not.toContain(foreignOrg.project);
    expect((await a.fetch(V('/audit?projectKey=TWO'))).status).toBe(404);
    const own = await json<Page>(await a.fetch(V('/audit?projectKey=ONE&limit=200')));
    expect(own.items.length).toBeGreaterThan(0);
    expect(new Set(own.items.map((i) => i.projectId)).size).toBe(1);
  });

  it('pages with a stable cursor and filters by action prefix', async () => {
    const first = await json<Page>(await a.fetch(V('/audit?limit=3')));
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = await json<Page>(await a.fetch(V(`/audit?limit=3&cursor=${first.nextCursor}`)));
    expect(second.items.map((i) => i.id)).not.toContain(first.items[0]!.id);
    const identity = await json<Page>(await a.fetch(V('/audit?action=identity.*&limit=200')));
    expect(identity.items.length).toBeGreaterThan(0);
    expect(identity.items.every((i) => i.action.startsWith('identity.'))).toBe(true);
    expect((await a.fetch(V('/audit?cursor=bm9wZQ'))).status).toBe(400);
  });
});

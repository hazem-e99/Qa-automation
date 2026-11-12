import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, MemberResponse, ProjectPermissionsResponse, ProjectResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { hashPassword } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import { nextSequenceValue } from '@qos/projects';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { listRoutes } from '../dist/route-inventory.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let orgId: string;
const PASSWORD = 'a long enough password';

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const code = async (res: Response) => ApiError.parse(await res.json()).code;
const addUser = async (email: string): Promise<{ id: string; session: Session }> => {
  const id = uuidv7();
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
     values ($1, $2, $3, $4, $5, 'active', now())`,
    [id, orgId, email, email, await hashPassword(PASSWORD)],
  );
  return { id, session: await signIn(base, email, PASSWORD) };
};
const P = (path = '') => `${base}/api/v1/projects${path}`;

beforeAll(async () => {
  t = await startTestDatabase();
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '0',
    RATE_LIMIT_BURST: '5000',
    RATE_LIMIT_RPS: '5000',
    ...AUTH_ENV,
  });
  base = await api.listen();
  admin = await setupAndSignIn(base);
  orgId = (await t.pool.query('select id from identity.organizations')).rows[0].id;
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
});

describe('creating projects', () => {
  it('creates a project, makes the creator its lead, and writes audit and outbox records', async () => {
    const res = await admin.fetch(
      P(),
      send('POST', { key: 'PAY', name: 'Payments', tags: ['Web', 'web', ' api '] }),
    );
    expect(res.status).toBe(201);
    const project = ProjectResponse.parse(await res.json());
    expect(project).toMatchObject({ key: 'PAY', name: 'Payments', status: 'active', tags: ['web', 'api'] });
    const members = MemberResponse.array().parse(await (await admin.fetch(P('/PAY/members'))).json());
    expect(members.map((m) => m.role)).toEqual(['qa_lead']);
    const audit = await t.pool.query(
      "select count(*)::int c from governance.audit_events where action = 'project.created'",
    );
    const outbox = await t.pool.query(
      "select count(*)::int c from platform.outbox_events where type = 'project.created'",
    );
    expect([audit.rows[0].c, outbox.rows[0].c]).toEqual([1, 1]);
  });

  it('rejects malformed keys and a key that is already used', async () => {
    for (const key of ['pay', 'P', '1AB', 'TOOLONGKEY1', 'PA-Y', '']) {
      expect((await admin.fetch(P(), send('POST', { key, name: 'Name' }))).status, key).toBe(400);
    }
    const dup = await admin.fetch(P(), send('POST', { key: 'PAY', name: 'Other' }));
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('project.key_taken');
  });

  it('needs the project.create permission', async () => {
    const { session } = await addUser('plain@example.test');
    const res = await session.fetch(P(), send('POST', { key: 'NOPE', name: 'Nope' }));
    expect(res.status).toBe(403);
  });
});

describe('project isolation (M13-AC-02)', () => {
  it('a member of project A gets 404 for everything in project B, same as for a project that does not exist', async () => {
    await admin.fetch(P(), send('POST', { key: 'AAA', name: 'Project A' }));
    await admin.fetch(P(), send('POST', { key: 'BBB', name: 'Project B' }));
    const engineer = await addUser('engineer@example.test');
    expect(
      (await admin.fetch(P(`/AAA/members/${engineer.id}`), send('PUT', { role: 'qa_engineer' }))).status,
    ).toBe(200);

    expect((await engineer.session.fetch(P('/AAA'))).status).toBe(200);
    const projectRoutes = listRoutes(api.app).filter((r) => r.path.includes('/projects/:key'));
    expect(projectRoutes.length).toBeGreaterThanOrEqual(9);
    for (const r of projectRoutes) {
      const path = (key: string) => base + r.path.replace(':key', key).replace(':userId', engineer.id);
      const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : { role: 'viewer', name: 'x' };
      const foreign = await engineer.session.fetch(path('BBB'), send(r.method, body));
      const missing = await engineer.session.fetch(path('ZZZ'), send(r.method, body));
      expect(foreign.status, `${r.method} ${r.path}`).toBe(404);
      expect(await foreign.json()).toEqual({
        ...((await missing.json()) as object),
        correlationId: expect.any(String),
      });
    }
    // Project B is untouched.
    expect((await admin.fetch(P('/BBB'))).status).toBe(200);
  });

  it('lists only the projects the caller may see', async () => {
    const engineer = await signIn(base, 'engineer@example.test', PASSWORD);
    const mine = ProjectResponse.array().parse(await (await engineer.fetch(P())).json());
    expect(mine.map((p) => p.key)).toEqual(['AAA']);
    const all = ProjectResponse.array().parse(await (await admin.fetch(P())).json());
    expect(all.map((p) => p.key)).toEqual(['AAA', 'BBB', 'PAY']);
  });

  it('a member without the permission gets 403 inside their own project', async () => {
    const engineer = await signIn(base, 'engineer@example.test', PASSWORD);
    const res = await engineer.fetch(P('/AAA'), send('PATCH', { name: 'Renamed' }));
    expect(res.status).toBe(403);
    const perms = ProjectPermissionsResponse.parse(
      await (await engineer.fetch(P('/AAA/permissions'))).json(),
    );
    expect(perms.project).toContain('testcase.create');
    expect(perms.project).not.toContain('project.settings.manage');
    expect(perms.project).not.toContain('codegen.request'); // policy-dependent
  });
});

describe('updating and lifecycle', () => {
  it('updates fields, but the key is immutable (M02-AC-06)', async () => {
    const ok = await admin.fetch(P('/PAY'), send('PATCH', { name: 'Payments v2', description: 'd' }));
    expect(ProjectResponse.parse(await ok.json())).toMatchObject({ key: 'PAY', name: 'Payments v2' });
    const res = await admin.fetch(P('/PAY'), send('PATCH', { key: 'PAY2', name: 'x y' }));
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('project.key_immutable');
    expect((await admin.fetch(P('/PAY2'))).status).toBe(404);
    expect(
      (await admin.fetch(P('/PAY'), send('PATCH', { key: 'PAY', name: 'Same key is fine' }))).status,
    ).toBe(200);
  });

  it('an archived project refuses writes with 409 and leaves default lists (M02-AC-07)', async () => {
    await admin.fetch(P(), send('POST', { key: 'ARC', name: 'Archive me' }));
    const member = await addUser('arc-member@example.test');
    expect((await admin.fetch(P('/ARC/archive'), send('POST'))).status).toBe(200);

    const writes: [string, string, unknown][] = [
      ['PATCH', '/ARC', { name: 'nope' }],
      ['PUT', `/ARC/members/${member.id}`, { role: 'viewer' }],
      ['DELETE', `/ARC/members/${member.id}`, undefined],
      ['POST', '/ARC/archive', undefined],
    ];
    for (const [method, path, body] of writes) {
      const res = await admin.fetch(P(path), send(method, body));
      expect(res.status, `${method} ${path}`).toBe(409);
    }
    expect(await code(await admin.fetch(P('/ARC'), send('PATCH', { name: 'nope' })))).toBe(
      'project_archived',
    );

    const keys = async (q = '') =>
      ProjectResponse.array()
        .parse(await (await admin.fetch(P(q))).json())
        .map((p) => p.key);
    expect(await keys()).not.toContain('ARC');
    expect(await keys('?includeArchived=true')).toContain('ARC');
    expect((await admin.fetch(P('/ARC'))).status).toBe(200); // still readable

    expect((await admin.fetch(P('/ARC/restore'), send('POST'))).status).toBe(200);
    expect((await admin.fetch(P('/ARC'), send('PATCH', { name: 'Back again' }))).status).toBe(200);
  });

  it('a deleted project disappears, and its key stays reserved', async () => {
    await admin.fetch(P(), send('POST', { key: 'DEL', name: 'Delete me' }));
    expect((await admin.fetch(P('/DEL'), send('DELETE'))).status).toBe(204);
    expect((await admin.fetch(P('/DEL'))).status).toBe(404);
    expect((await admin.fetch(P('?includeArchived=true'))).status).toBe(200);
    const again = await admin.fetch(P(), send('POST', { key: 'DEL', name: 'Reuse' }));
    expect(again.status).toBe(409);
    const row = await t.pool.query("select status, deleted_at from projects.projects where key = 'DEL'");
    expect(row.rows[0].status).toBe('deleted');
    expect(row.rows[0].deleted_at).not.toBeNull();
  });
});

describe('members (M13-AC-04)', () => {
  it('a lead cannot change their own role, grant a role above their own, or assign org roles', async () => {
    await admin.fetch(P(), send('POST', { key: 'MEM', name: 'Members' }));
    const lead = await addUser('lead@example.test');
    const other = await addUser('other@example.test');
    expect((await admin.fetch(P(`/MEM/members/${lead.id}`), send('PUT', { role: 'qa_lead' }))).status).toBe(
      200,
    );

    const own = await lead.session.fetch(P(`/MEM/members/${lead.id}`), send('PUT', { role: 'viewer' }));
    expect(own.status).toBe(403);
    expect(await code(own)).toBe('member.cannot_change_own_role');
    for (const role of ['org_admin', 'platform_admin', 'nonsense']) {
      const res = await lead.session.fetch(P(`/MEM/members/${other.id}`), send('PUT', { role }));
      expect(res.status, role).toBe(422);
      expect(await code(res)).toBe('member.role_invalid');
    }
    expect(
      (await lead.session.fetch(P(`/MEM/members/${other.id}`), send('PUT', { role: 'qa_engineer' }))).status,
    ).toBe(200);
    expect(
      (await lead.session.fetch(P(`/MEM/members/${other.id}`), send('PUT', { role: 'qa_lead' }))).status,
    ).toBe(200);

    // An engineer has no members.manage at all.
    const eng = await addUser('eng2@example.test');
    await admin.fetch(P(`/MEM/members/${eng.id}`), send('PUT', { role: 'qa_engineer' }));
    expect(
      (await eng.session.fetch(P(`/MEM/members/${other.id}`), send('PUT', { role: 'viewer' }))).status,
    ).toBe(403);
  });

  it('rejects unknown users and keeps at least one lead', async () => {
    const unknown = await admin.fetch(P(`/MEM/members/${uuidv7()}`), send('PUT', { role: 'viewer' }));
    expect(unknown.status).toBe(404);
    await admin.fetch(P(), send('POST', { key: 'SOLO', name: 'Solo' }));
    const me = (await (await admin.fetch(`${base}/api/v1/me`)).json()) as { id: string };
    const res = await admin.fetch(P(`/SOLO/members/${me.id}`), send('DELETE'));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('member.last_lead');
  });

  it('removing a member cuts their access at once', async () => {
    const temp = await addUser('temp@example.test');
    await admin.fetch(P(`/MEM/members/${temp.id}`), send('PUT', { role: 'viewer' }));
    expect((await temp.session.fetch(P('/MEM'))).status).toBe(200);
    expect((await admin.fetch(P(`/MEM/members/${temp.id}`), send('DELETE'))).status).toBe(204);
    expect((await temp.session.fetch(P('/MEM'))).status).toBe(404);
  });
});

describe('key sequences', () => {
  it('hands out gap-free, unique numbers under concurrency, per project and entity type', async () => {
    const id = (await t.pool.query("select id from projects.projects where key = 'PAY'")).rows[0]
      .id as string;
    const values = await Promise.all(
      Array.from({ length: 20 }, () => t.db.transaction((tx) => nextSequenceValue(tx, id, 'REQ'))),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await t.db.transaction((tx) => nextSequenceValue(tx, id, 'TC'))).toBe(1);
    await expect(
      t.db.transaction(async (tx) => {
        await nextSequenceValue(tx, id, 'REQ');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await t.db.transaction((tx) => nextSequenceValue(tx, id, 'REQ'))).toBe(21); // no gap after a rollback
  });
});

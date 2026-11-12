import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbEnvelopeSecretStore, generateMasterKey, parseMasterKey } from '@qos/adapters-secrets-db';
import { MockControls, MockIssueTracker, MockRepositoryProvider } from '@qos/adapters-mock';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { uuidv7 } from '@qos/kernel-domain';
import { createLogger } from '@qos/observability';
import type { CapabilityManifest, ProviderAdapter } from '@qos/ports';
import {
  checkConnectionForRole,
  connectionImpact,
  createConnection,
  getExternalRef,
  listCapabilities,
  listConnections,
  ProviderRegistry,
  retireConnection,
  rotateCredential,
  testConnection,
  upsertExternalRef,
  type IntegrationDeps,
} from '../src/index.js';

const logLines: string[] = [];
const logger = createLogger({
  service: 'test',
  level: 'debug',
  destination: { write: (s: string) => void logLines.push(s) },
});
const SECRET = 'mock-credential-value-7Qx;scopes=repo,issues:read';
let t: TestDatabase;
let deps: IntegrationDeps;
const repoControls = new MockControls();
const actor = { orgId: uuidv7(), userId: uuidv7() };

beforeAll(async () => {
  t = await startTestDatabase();
  deps = {
    db: t.db,
    registry: new ProviderRegistry()
      .register(new MockRepositoryProvider(repoControls))
      .register(new MockIssueTracker()),
    secrets: new DbEnvelopeSecretStore(t.db, parseMasterKey(generateMasterKey())),
    http: {
      request: async () => {
        throw new Error('no network in tests');
      },
    },
    logger,
  };
}, 180_000);
afterAll(async () => {
  await t?.stop();
});

describe('provider registry', () => {
  const fake = (m: Partial<CapabilityManifest>): ProviderAdapter => ({
    manifest: () =>
      ({
        providerType: 'fake_type',
        family: 'source_control',
        adapterVersion: '1',
        displayName: 'Fake',
        capabilities: [],
        limits: {},
        authStrategies: ['none'],
        ...m,
      }) as CapabilityManifest,
    testConnection: async () => ({ identity: 'x', scopesDiscovered: [], permissionChecks: [] }),
  });

  it('refuses capabilities outside the catalog or of another family, and duplicate types', () => {
    expect(() => new ProviderRegistry().register(fake({ capabilities: ['issues.create@1'] }))).toThrow(
      /unknown capabilities/,
    );
    expect(() => new ProviderRegistry().register(fake({ capabilities: ['repo.teleport@1'] }))).toThrow();
    expect(() => new ProviderRegistry().register(fake({})).register(fake({}))).toThrow(/twice/);
    expect(() => new ProviderRegistry().register(fake({ providerType: 'Bad Type' }))).toThrow(
      /invalid provider type/,
    );
  });

  it('lists a catalog and throws CapabilityMissingError for undeclared capabilities', () => {
    expect(deps.registry.catalog().map((m) => m.providerType)).toEqual([
      'mock_issue_tracker',
      'mock_repository',
    ]);
    expect(() => deps.registry.require('mock_repository', ['repo.pr.create@1'])).toThrow(
      /missing capabilities/,
    );
  });
});

describe('connections', () => {
  it('stores the credential in the secret store only, never in the connection row or audit', async () => {
    const c = await createConnection(deps, actor, {
      providerType: 'mock_issue_tracker',
      displayName: 'Tracker',
      authStrategy: 'pat',
      credential: SECRET,
    });
    expect(c).toMatchObject({ status: 'untested', hasCredential: true, isDemo: true });
    expect(JSON.stringify(c)).not.toContain('mock-credential-value');
    const dump = JSON.stringify(
      (await t.pool.query('select * from integrations.connections')).rows.concat(
        (await t.pool.query('select * from governance.audit_events')).rows,
      ),
    );
    expect(dump).not.toContain('mock-credential-value');
  });

  it('validates input: provider, auth strategy, name, base URL and credential', async () => {
    const base = {
      providerType: 'mock_repository',
      displayName: 'Repo',
      authStrategy: 'pat' as const,
      credential: 'x',
    };
    await expect(createConnection(deps, actor, { ...base, providerType: 'nope' })).rejects.toThrow(
      'connection.provider_unknown',
    );
    await expect(createConnection(deps, actor, { ...base, authStrategy: 'basic' })).rejects.toThrow(
      'connection.auth_strategy_invalid',
    );
    await expect(createConnection(deps, actor, { ...base, credential: '' })).rejects.toThrow(
      'connection.credential_required',
    );
    for (const baseUrl of ['http://plain.example.test', 'https://user:pw@x.example.test', 'not a url']) {
      await expect(createConnection(deps, actor, { ...base, baseUrl }), baseUrl).rejects.toThrow(
        'connection.base_url_invalid',
      );
    }
    await expect(createConnection(deps, actor, { ...base, displayName: 'Tracker' })).rejects.toThrow(
      'connection.name_taken',
    );
    const noSecrets = { ...deps, secrets: null };
    await expect(createConnection(noSecrets, actor, { ...base, displayName: 'Other' })).rejects.toThrow(
      'secrets.unavailable',
    );
  });

  it('a token without write scope yields effective capabilities without issues.create, and cannot serve as issue tracker (M03-AC-01)', async () => {
    const [c] = (await listConnections(t.db, actor)).filter((x) => x.displayName === 'Tracker');
    const outcome = await testConnection(deps, actor, c!.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.connection.status).toBe('degraded');
    const caps = Object.fromEntries(
      (await listCapabilities(t.db, actor, c!.id)).map((x) => [x.capability, x]),
    );
    expect(caps['issues.get@1']?.ok).toBe(true);
    expect(caps['issues.create@1']).toMatchObject({ ok: false, detail: 'issues:write' });
    const diff = await checkConnectionForRole(t.db, actor, c!.id, 'issue_tracker');
    expect(diff.ok).toBe(false);
    expect(diff.missingRequired).toEqual(['issues.create@1', 'issues.update@1']);
    expect(diff.missingOptional).toContain('issues.comment@1');
    // Wrong family is also rejected.
    expect((await checkConnectionForRole(t.db, actor, c!.id, 'repository')).familyMismatch).toBe(true);

    // After rotating to a full-scope credential, the same connection qualifies.
    await rotateCredential(deps, actor, c!.id, 'mock-credential-value-full');
    expect((await testConnection(deps, actor, c!.id)).connection.status).toBe('active');
    expect((await checkConnectionForRole(t.db, actor, c!.id, 'issue_tracker')).ok).toBe(true);
  });

  it('records a rejected credential as auth_failed and an outage as degraded, with no secret in logs', async () => {
    const c = await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Repo bad token',
      authStrategy: 'pat',
      credential: 'invalid',
    });
    expect((await testConnection(deps, actor, c.id)).connection.status).toBe('auth_failed');
    const ok = await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Repo flaky',
      authStrategy: 'pat',
      credential: 'mock-credential-value-repo',
    });
    repoControls.failNext('unavailable');
    const outcome = await testConnection(deps, actor, ok.id);
    expect(outcome).toMatchObject({ ok: false, errorKind: 'unavailable' });
    expect(outcome.connection.status).toBe('degraded');
    expect((await checkConnectionForRole(t.db, actor, ok.id, 'repository')).ok).toBe(false);
    expect(logLines.join('')).not.toContain('mock-credential-value');
  });

  it('an untested connection never qualifies for a role', async () => {
    const c = await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Repo untested',
      authStrategy: 'pat',
      credential: 'mock-credential-value-untested',
    });
    expect((await checkConnectionForRole(t.db, actor, c.id, 'repository')).ok).toBe(false);
  });

  it('connections of another organization are invisible', async () => {
    const [c] = await listConnections(t.db, actor);
    const stranger = { orgId: uuidv7(), userId: uuidv7() };
    expect(await listConnections(t.db, stranger)).toEqual([]);
    await expect(testConnection(deps, stranger, c!.id)).rejects.toThrow('connection.not_found');
  });
});

describe('external refs and retirement (M03-AC-05)', () => {
  it('upserts one row per external object and keeps history readable after retirement', async () => {
    const c = await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Repo to retire',
      authStrategy: 'pat',
      credential: 'mock-credential-value-retire',
    });
    const first = await upsertExternalRef(t.db, c.id, {
      externalType: 'commit',
      externalId: 'abc123',
      snapshot: { message: 'first' },
    });
    const again = await upsertExternalRef(t.db, c.id, {
      externalType: 'commit',
      externalId: 'abc123',
      externalVersion: '2',
      snapshot: { message: 'updated' },
    });
    expect(again.id).toBe(first.id);
    expect(again.snapshot).toEqual({ message: 'updated' });
    await expect(
      upsertExternalRef(t.db, c.id, {
        externalType: 'x',
        externalId: 'y',
        snapshot: { big: 'z'.repeat(20_000) },
      }),
    ).rejects.toThrow('external_ref.snapshot_too_large');

    expect(await connectionImpact(t.db, actor, c.id)).toEqual({ externalRefs: { commit: 1 } });
    const secretRef = (
      await t.pool.query('select secret_ref from integrations.connections where id = $1', [c.id])
    ).rows[0].secret_ref;
    const retired = await retireConnection(deps, actor, c.id);
    expect(retired).toMatchObject({ status: 'retired', hasCredential: false });
    const kept = await getExternalRef(t.db, first.id);
    expect(kept).toMatchObject({ status: 'source_retired', snapshot: { message: 'updated' } });
    // The credential is destroyed; the connection cannot be used or re-retired.
    expect(await deps.secrets!.describe(secretRef)).toBeNull();
    await expect(testConnection(deps, actor, c.id)).rejects.toThrow('connection.retired');
    await expect(retireConnection(deps, actor, c.id)).rejects.toThrow('connection.retired');
    await expect(
      upsertExternalRef(t.db, c.id, { externalType: 'commit', externalId: 'n', snapshot: {} }),
    ).rejects.toThrow('connection.retired');
  });
});

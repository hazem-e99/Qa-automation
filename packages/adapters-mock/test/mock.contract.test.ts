import { repositoryContract, spyContext } from '@qos/contract-tests';
import { describe, expect, it } from 'vitest';
import { MockControls, MockIssueTracker, MockRepositoryProvider } from '../src/index.js';

const controls = new MockControls();
repositoryContract('mock_repository', () => ({
  adapter: new MockRepositoryProvider(controls),
  mode: 'mock',
  secret: 'mock-secret-value-for-contract',
  repoId: '1001',
  injectFault: (kind, retryAfterMs) => controls.failNext(kind, 1, retryAfterMs),
  reset: () => controls.reset(),
}));

// The same suite against a mock with branch creation switched off: the capability-aware skips
// and the CapabilityMissingError path are exercised for real.
const reduced = new MockControls();
repositoryContract('mock_repository (no branch capability)', () => {
  reduced.disabled.add('repo.branch.create@1');
  return {
    adapter: new MockRepositoryProvider(reduced),
    mode: 'mock',
    secret: 'mock-secret-value-for-contract',
    repoId: '1001',
  };
});

describe('mock credentials and permission checks', () => {
  it('reports missing scopes per capability (basis of M03-AC-01)', async () => {
    const { ctx } = spyContext('mock-token;scopes=issues:read');
    const result = await new MockIssueTracker().testConnection(ctx);
    const byCap = Object.fromEntries(result.permissionChecks.map((c) => [c.capability, c]));
    expect(byCap['issues.get@1']).toEqual({ capability: 'issues.get@1', ok: true });
    expect(byCap['issues.create@1']).toEqual({
      capability: 'issues.create@1',
      ok: false,
      missing: 'issues:write',
    });
  });

  it('rejects the invalid credential with auth_failed', async () => {
    const { ctx } = spyContext('invalid');
    await expect(new MockIssueTracker().testConnection(ctx)).rejects.toMatchObject({ kind: 'auth_failed' });
  });
});

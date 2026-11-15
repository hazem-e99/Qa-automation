import { requirementsContract, spyContext } from '@qos/contract-tests';
import { describe, expect, it } from 'vitest';
import { AzureDevOpsConnection, htmlToMarkdown } from '../src/index.js';
import { FIXTURE_PAT, FixtureBoards, ORG, PROJECT } from './fixture-boards.js';

const STATUS: Record<string, number> = { auth_failed: 401, permission_denied: 403, unavailable: 503 };
const fixture = new FixtureBoards();
requirementsContract('azure_devops (Azure Boards)', () => ({
  adapter: new AzureDevOpsConnection({ pageSize: 10 }),
  mode: 'recorded',
  secret: FIXTURE_PAT,
  baseUrl: `https://dev.azure.com/${ORG}`,
  http: fixture,
  config: { project: PROJECT },
  changeItem: () => {
    fixture.change(1203, { title: 'Pay invoice by card or bank transfer' });
    return '1203';
  },
  injectFault: (kind, retryAfterMs) =>
    kind === 'rate_limited'
      ? fixture.failNext(429, { 'retry-after': String((retryAfterMs ?? 1000) / 1000) })
      : fixture.failNext(STATUS[kind] ?? 500),
  reset: () => fixture.reset(),
}));

describe('Azure Boards specifics (T-P3-10)', () => {
  const adapter = new AzureDevOpsConnection({ pageSize: 10 });
  const ctx = () => spyContext(FIXTURE_PAT, `https://dev.azure.com/${ORG}`, fixture).ctx;

  it('reads only the configured types, oldest change first, with a WIQL query and batch reads', async () => {
    fixture.reset();
    const page = await adapter.listChanged(ctx(), { project: PROJECT, workItemTypes: ['User Story'] });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toMatch(/^2026-09-01T08:00:\d{2}\.000Z\|\d+$/);
    const [wiql, batch] = fixture.calls;
    expect(wiql!.method).toBe('POST');
    expect(wiql!.url).toContain('/Payments%20App/_apis/wit/wiql?timePrecision=true&$top=10&api-version=7.1');
    expect((wiql!.body as { query: string }).query).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story') ORDER BY [System.ChangedDate] ASC, [System.Id] ASC",
    );
    expect(batch!.url).toContain('/_apis/wit/workitemsbatch?api-version=7.1');
    // Tasks (every fifth fixture item) are not requirements here.
    expect(page.items.map((i) => i.externalId)).not.toContain('1205');
  });

  it('quotes names in WIQL and filters by area path', async () => {
    fixture.reset();
    await adapter.listChanged(ctx(), {
      project: PROJECT,
      workItemTypes: ["O'Brien story"],
      areaPath: `${PROJECT}\\Billing`,
    });
    expect((fixture.calls[0]!.body as { query: string }).query).toContain(
      "[System.WorkItemType] IN ('O''Brien story') AND [System.AreaPath] UNDER 'Payments App\\Billing'",
    );
  });

  it('converts description and criteria to Markdown and maps tags, links and area', async () => {
    fixture.reset();
    const item = await adapter.getItem(ctx(), { project: PROJECT }, '1202');
    expect(item).toMatchObject({
      externalId: '1202',
      type: 'User Story',
      title: 'Pay invoice by card (2)',
      state: 'Active',
      removed: false,
      tags: [],
      area: 'Payments App\\Checkout',
      links: [
        { kind: 'parent', externalId: '1201' },
        { kind: 'related', externalId: '1203' },
      ],
      url: 'https://dev.azure.com/contoso-qa/Payments%20App/_workitems/edit/1202',
    });
    expect(item.descriptionMarkdown).toBe(
      'The payer can settle invoice **2** with a saved card.\n\n- Visa & Mastercard\n- 3-D Secure when asked',
    );
    expect(item.acceptanceCriteriaMarkdown).toBe(
      '1. Given an open invoice, when the payer confirms, then the invoice is _paid_.\n2. A declined card shows "Payment declined".',
    );
    expect((await adapter.getItem(ctx(), { project: PROJECT }, '1201')).tags).toEqual(['payments', 'cards']);
  });

  it('reads an older revision, and a Removed state marks the item removed', async () => {
    fixture.reset();
    fixture.change(1204, { state: 'Removed' });
    const now = await adapter.getItem(ctx(), { project: PROJECT }, '1204');
    expect(now.removed).toBe(true);
    const before = await adapter.getItem(
      ctx(),
      { project: PROJECT },
      '1204',
      String(Number(now.revision) - 1),
    );
    expect(before).toMatchObject({ removed: false, state: 'Active' });
  });

  it('validates the binding config and estimates the item count', async () => {
    fixture.reset();
    expect(await adapter.validateQuery(ctx(), { project: PROJECT })).toEqual({
      ok: true,
      estimatedCount: 36,
    });
    expect(await adapter.validateQuery(ctx(), {})).toMatchObject({ ok: false });
    await expect(adapter.listChanged(ctx(), { project: 'bad/name' })).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(adapter.listChanged(ctx(), { project: PROJECT }, 'not-a-cursor')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('treats an HTML sign-in page as a rejected credential', async () => {
    fixture.reset();
    fixture.failNext(203, { 'content-type': 'text/html' });
    await expect(adapter.listChanged(ctx(), { project: PROJECT })).rejects.toMatchObject({
      kind: 'auth_failed',
    });
  });
});

describe('HTML to Markdown', () => {
  it('drops scripts, styles, attributes and unsafe links; keeps text', () => {
    expect(
      htmlToMarkdown(
        '<p onclick="x()">Hi <a href="javascript:alert(1)">there</a> <a href="https://ex.example.test/a">docs</a></p><script>alert(1)</script><style>p{}</style><h2>Rules</h2>&#1575;&#1604;&#1583;&#1582;&#1608;&#1604;',
      ),
    ).toBe('Hi there [docs](https://ex.example.test/a)\n\n## Rules\n\nالدخول');
    expect(htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr></table>')).toBe('a | b |');
    expect(htmlToMarkdown(null)).toBe('');
  });
});

import type { OutboundHttp } from '@qos/ports';

/**
 * Fixture Azure Boards API for contract tests ("recorded" mode).
 *
 * Written from the Azure DevOps REST API documentation, api-version 7.1: WIQL - Query By Wiql,
 * Work Items - Get Work Items Batch, Work Items - Get Work Item ($expand=relations), Revisions -
 * Get. Same paths, methods, status codes and field names, synthetic data. Not captured from a live
 * organization: real recordings replace these once the owner's test organization exists.
 */
export const FIXTURE_PAT = 'fixture-pat-not-a-real-credential';
export const ORG = 'contoso-qa';
export const PROJECT = 'Payments App';
const BASE = `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT)}/_apis/wit`;

interface Item {
  id: number;
  rev: number;
  type: string;
  title: string;
  description: string;
  ac: string | null;
  state: string;
  tags: string;
  area: string;
  changed: string;
  relations: { rel: string; url: string }[];
  history: Item[];
}

type Res = { status: number; headers?: Record<string, string>; body?: unknown };

export class FixtureBoards implements OutboundHttp {
  readonly calls: { method: string; url: string; body: unknown }[] = [];
  private faults: Res[] = [];
  private items = new Map<number, Item>();
  private clock = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.faults = [];
    this.calls.length = 0;
    this.items.clear();
    this.clock = Date.UTC(2026, 8, 1, 8, 0, 0, 0);
    for (let i = 1; i <= 45; i++) {
      const id = 1200 + i;
      const story = i % 5 !== 0;
      this.items.set(id, {
        id,
        rev: 1 + (i % 3),
        type: story ? 'User Story' : 'Task',
        title: `Pay invoice by card (${i})`,
        description: `<div>The payer can settle invoice <b>${i}</b> with a saved card.</div><div><br></div><ul><li>Visa &amp; Mastercard</li><li>3-D Secure when asked</li></ul>`,
        ac: story
          ? `<ol><li>Given an open invoice, when the payer confirms, then the invoice is <i>paid</i>.</li><li>A declined card shows &quot;Payment declined&quot;.</li></ol>`
          : null,
        state: 'Active',
        tags: i % 2 ? 'payments; cards' : '',
        area: i % 4 ? `${PROJECT}\\Checkout` : `${PROJECT}\\Billing`,
        // Pairs of items share a change time, so the (time, id) cursor is exercised.
        changed: new Date(this.clock + Math.floor(i / 2) * 1000).toISOString(),
        relations:
          i === 2
            ? [
                { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${BASE}/workItems/1201` },
                { rel: 'System.LinkTypes.Related', url: `${BASE}/workItems/1203` },
                { rel: 'AttachedFile', url: `${BASE}/attachments/abc` },
              ]
            : [],
        history: [],
      });
    }
    this.clock += 100_000;
  }

  /** A new revision at the source. */
  change(id: number, patch: Partial<Pick<Item, 'title' | 'description' | 'ac' | 'state'>>): void {
    const item = this.items.get(id)!;
    item.history.push({ ...item, history: [] });
    Object.assign(item, patch, { rev: item.rev + 1, changed: new Date((this.clock += 1000)).toISOString() });
  }

  failNext(status: number, headers: Record<string, string> = {}): void {
    this.faults.push({ status, headers, body: { message: 'simulated' } });
  }

  async request(
    url: string,
    req: { method?: string; headers?: Readonly<Record<string, string>>; body?: string | Uint8Array } = {},
  ) {
    const method = req.method ?? 'GET';
    const body = typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : undefined;
    this.calls.push({ method, url, body });
    const ok = req.headers?.authorization === `Basic ${Buffer.from(`:${FIXTURE_PAT}`).toString('base64')}`;
    const r: Res =
      this.faults.shift() ??
      (ok
        ? this.route(method, url, body)
        : { status: 401, headers: { 'content-type': 'text/plain' }, body: '' });
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      status: r.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...(r.headers ?? {}) },
      body: new TextEncoder().encode(text),
      url,
    };
  }

  private route(method: string, url: string, body: unknown): Res {
    const u = new URL(url);
    if (u.searchParams.get('api-version') !== '7.1') return { status: 400, body: { message: 'api-version' } };
    if (u.pathname === `/${ORG}/_apis/projects`)
      return { status: 200, body: { count: 1, value: [{ id: 'p1', name: PROJECT }] } };
    const prefix = `/${ORG}/${encodeURIComponent(PROJECT)}/_apis/wit/`;
    if (!u.pathname.startsWith(prefix)) return { status: 404, body: { message: 'project not found' } };
    const rest = u.pathname.slice(prefix.length);
    if (rest === 'wiql' && method === 'POST') return this.wiql(u, body as { query: string });
    if (rest === 'workitemsbatch' && method === 'POST') {
      const { ids, fields } = body as { ids: number[]; fields: string[] };
      if (ids.length > 200) return { status: 400, body: { message: 'too many ids' } };
      const value = ids.flatMap((id) => {
        const it = this.items.get(id);
        if (!it) return [];
        const all = this.fields(it);
        return [{ id, rev: it.rev, fields: Object.fromEntries(fields.map((f) => [f, all[f]])) }];
      });
      return { status: 200, body: { count: value.length, value } };
    }
    const m = /^workitems\/(\d+)(?:\/revisions\/(\d+))?$/.exec(rest);
    if (m && method === 'GET') {
      const it = this.items.get(Number(m[1]));
      if (!it) return { status: 404, body: { message: `TF401232: Work item ${m[1]} does not exist` } };
      const version = m[2] ? [...it.history, it].find((h) => h.rev === Number(m[2])) : it;
      if (!version) return { status: 404, body: { message: 'revision not found' } };
      return {
        status: 200,
        body: {
          id: version.id,
          rev: version.rev,
          fields: this.fields(version),
          ...(u.searchParams.get('$expand') === 'relations' ? { relations: version.relations } : {}),
          _links: { html: { href: `https://dev.azure.com/${ORG}/_workitems/edit/${version.id}` } },
        },
      };
    }
    return { status: 404, body: { message: 'route not in fixture' } };
  }

  private fields(it: Item): Record<string, unknown> {
    return {
      'System.Id': it.id,
      'System.Rev': it.rev,
      'System.WorkItemType': it.type,
      'System.Title': it.title,
      'System.Description': it.description,
      ...(it.ac !== null ? { 'Microsoft.VSTS.Common.AcceptanceCriteria': it.ac } : {}),
      'System.State': it.state,
      'System.Tags': it.tags || undefined,
      'System.AreaPath': it.area,
      'System.IterationPath': `${PROJECT}\\Sprint 4`,
      'System.ChangedDate': it.changed,
      'System.TeamProject': PROJECT,
    };
  }

  /** Evaluates the subset of WIQL the adapter writes: type list, area, change time, order, $top. */
  private wiql(u: URL, body: { query: string }): Res {
    const q = body.query;
    if (
      !/^SELECT \[System\.Id\] FROM WorkItems WHERE /.test(q) ||
      u.searchParams.get('timePrecision') !== 'true'
    )
      return { status: 400, body: { message: 'unsupported query' } };
    const unq = (s: string) => s.slice(1, -1).replace(/''/g, "'");
    const types =
      /\[System\.WorkItemType\] IN \(((?:'(?:[^']|'')*'(?:, )?)+)\)/
        .exec(q)?.[1]
        ?.match(/'(?:[^']|'')*'/g)
        ?.map(unq) ?? [];
    const area = /\[System\.AreaPath\] UNDER ('(?:[^']|'')*')/.exec(q)?.[1];
    const since = /\[System\.ChangedDate\] >= ('(?:[^']|'')*')/.exec(q)?.[1];
    const top = Number(u.searchParams.get('$top') ?? 20000);
    const hits = [...this.items.values()]
      .filter((it) => types.includes(it.type))
      .filter((it) => !area || it.area === unq(area) || it.area.startsWith(`${unq(area)}\\`))
      .filter((it) => !since || it.changed >= new Date(unq(since)).toISOString())
      .sort((a, b) => a.changed.localeCompare(b.changed) || a.id - b.id)
      .slice(0, top);
    return {
      status: 200,
      body: {
        queryType: 'flat',
        workItems: hits.map((h) => ({ id: h.id, url: `${BASE}/workItems/${h.id}` })),
      },
    };
  }
}

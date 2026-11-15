import {
  ProviderError,
  type CapabilityManifest,
  type ConnectionContext,
  type ConnectionTestResult,
  type Page,
  type RequirementsSource,
  type SourceItem,
  type SourceItemHeader,
  type SourceItemLink,
} from '@qos/ports';
import { htmlToMarkdown } from './html-to-markdown.js';

export { htmlToMarkdown } from './html-to-markdown.js';

/**
 * Azure DevOps (doc 13 §3): PAT connection (T-P2-28) and Azure Boards as a requirements source
 * (T-P3-10).
 *
 * Requirements: work items of one project, of the configured types (and optionally under one area
 * path), are listed oldest change first through WIQL (`timePrecision=true`), their revision and
 * change time read in batches of up to 200, and each item read with its relations. Description
 * and acceptance criteria are HTML in Azure Boards and are converted to Markdown here.
 *
 * Not done here (and why):
 *  - Detecting global (all-organization) PATs: not visible from the PAT itself.
 *  - PAT expiry: the PAT lifecycle API needs a different (Entra) credential, so the expiry date
 *    cannot be read with the PAT; it is not reported.
 *  - `entra_client_credentials`: not offered until implemented (enterprise, P13).
 *  - Attachments: `requirements.attachments.read` is not declared yet.
 *  - Service hook payloads are never trusted (they are not signed): a delivery only triggers a
 *    re-fetch through this API (doc 13 §3).
 */
const ORG_URL = /^https:\/\/dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,48}[A-Za-z0-9]?)$/;
export const AZURE_DEVOPS_API_VERSION = '7.1';
/** Work item types read when the binding does not name any (Agile, Scrum, CMMI, Basic). */
export const DEFAULT_WORK_ITEM_TYPES = [
  'User Story',
  'Product Backlog Item',
  'Requirement',
  'Feature',
  'Issue',
];
const PROJECT_NAME = /^[^\\/:*?"<>|;#$%{}+=[\]@,]{1,64}$/;

type Json = Record<string, unknown>;
interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string }[];
  _links?: { html?: { href?: string } };
}

interface BoardsConfig {
  readonly project: string;
  readonly types: readonly string[];
  readonly areaPath: string | null;
}

export class AzureDevOpsConnection implements RequirementsSource {
  static readonly TYPE = 'azure_devops';

  /** `pageSize`: work items per listed page (WIQL `$top`, at most 200: the batch limit). */
  constructor(private readonly opts: { pageSize?: number } = {}) {}

  manifest(): CapabilityManifest {
    return {
      providerType: AzureDevOpsConnection.TYPE,
      family: 'requirements',
      adapterVersion: '0.2.0',
      displayName: 'Azure DevOps',
      capabilities: [
        'requirements.list_changed@1',
        'requirements.get@1',
        'requirements.revisions@1',
        'requirements.links@1',
        'requirements.query.validate@1',
      ],
      limits: {
        richText: 'html',
        maxPageSize: 200,
        rateLimitHint: 'Retry-After / X-RateLimit-* headers',
      },
      authStrategies: ['pat'],
      webhook: { verification: 'basic_auth', eventTypeHeader: 'x-qos-event' },
    };
  }

  async testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult> {
    const org = parseOrganization(ctx.baseUrl);
    const body = await this.call<{ value?: { name: string }[] }>(
      ctx,
      `https://dev.azure.com/${org}/_apis/projects?api-version=${AZURE_DEVOPS_API_VERSION}&$top=100`,
    );
    const projects = (body.value ?? []).map((p) => p.name);
    // Reading projects proves the PAT works for this organization. Whether it may read work items
    // of a given project is checked when a binding is validated (validateQuery).
    return {
      identity: `organization ${org}`,
      scopesDiscovered: projects.length ? ['vso.project (read)'] : [],
      permissionChecks: this.manifest().capabilities.map((capability) => ({ capability, ok: true })),
    };
  }

  async validateQuery(
    ctx: ConnectionContext,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<{ ok: boolean; estimatedCount?: number; error?: string }> {
    let config: BoardsConfig;
    try {
      config = boardsConfig(raw);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const r = await this.wiql(ctx, config, null, 20_000);
    return { ok: true, estimatedCount: r.length };
  }

  async listChanged(
    ctx: ConnectionContext,
    raw: Readonly<Record<string, unknown>>,
    cursor?: string,
  ): Promise<Page<SourceItemHeader>> {
    const config = boardsConfig(raw);
    const after = parseCursor(cursor);
    const top = Math.min(Math.max(this.opts.pageSize ?? 200, 1), 200);
    const ids = await this.wiql(ctx, config, after?.time ?? null, top);
    if (!ids.length) return { items: [], ...(cursor ? { resumeCursor: cursor } : {}) };
    const batch = await this.call<{ value?: WorkItem[] }>(
      ctx,
      `${projectBase(ctx, config)}/_apis/wit/workitemsbatch?api-version=${AZURE_DEVOPS_API_VERSION}`,
      {
        method: 'POST',
        body: { ids, fields: ['System.Id', 'System.Rev', 'System.ChangedDate'] },
      },
    );
    const headers = (batch.value ?? [])
      .map((w) => ({
        externalId: String(w.id),
        revision: String(w.rev ?? w.fields['System.Rev']),
        changedAt: new Date(String(w.fields['System.ChangedDate'])).toISOString(),
      }))
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt) || Number(a.externalId) - Number(b.externalId))
      // WIQL compares times only (>=): drop what the cursor already covered.
      .filter(
        (h) =>
          !after ||
          h.changedAt > after.time ||
          (h.changedAt === after.time && Number(h.externalId) > after.id),
      );
    const last = headers.at(-1);
    const key = last ? `${last.changedAt}|${last.externalId}` : cursor;
    return {
      items: headers,
      // A full page means more may follow; a page of only already-seen items stops the traversal.
      ...(ids.length === top && last ? { nextCursor: key! } : {}),
      ...(key ? { resumeCursor: key } : {}),
    };
  }

  async getItem(
    ctx: ConnectionContext,
    raw: Readonly<Record<string, unknown>>,
    externalId: string,
    revision?: string,
  ): Promise<SourceItem> {
    const config = boardsConfig(raw);
    if (!/^\d{1,10}$/.test(externalId)) throw new ProviderError('not_found', 'work item not found');
    if (revision !== undefined && !/^\d{1,6}$/.test(revision))
      throw new ProviderError('validation', 'invalid revision', { field: 'revision' });
    const path = revision ? `${externalId}/revisions/${revision}` : externalId;
    const w = await this.call<WorkItem>(
      ctx,
      `${projectBase(ctx, config)}/_apis/wit/workitems/${path}?$expand=relations&api-version=${AZURE_DEVOPS_API_VERSION}`,
    );
    const f = w.fields;
    const state = String(f['System.State'] ?? '');
    return {
      externalId: String(w.id),
      revision: String(w.rev ?? f['System.Rev']),
      type: String(f['System.WorkItemType'] ?? ''),
      title: htmlToMarkdown(String(f['System.Title'] ?? ''))
        .replace(/\s+/g, ' ')
        .trim(),
      descriptionMarkdown: htmlToMarkdown(f['System.Description'] as string | undefined),
      acceptanceCriteriaMarkdown:
        typeof f['Microsoft.VSTS.Common.AcceptanceCriteria'] === 'string'
          ? htmlToMarkdown(f['Microsoft.VSTS.Common.AcceptanceCriteria'])
          : null,
      state,
      removed: state === 'Removed',
      tags: String(f['System.Tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean),
      area: typeof f['System.AreaPath'] === 'string' ? f['System.AreaPath'] : null,
      iteration: typeof f['System.IterationPath'] === 'string' ? f['System.IterationPath'] : null,
      links: linksOf(w.relations ?? []),
      changedAt: new Date(String(f['System.ChangedDate'])).toISOString(),
      url: `https://dev.azure.com/${parseOrganization(ctx.baseUrl)}/${encodeURIComponent(config.project)}/_workitems/edit/${w.id}`,
    };
  }

  /** Ids of matching work items changed at or after `since`, oldest change first. */
  private async wiql(ctx: ConnectionContext, config: BoardsConfig, since: string | null, top: number) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const where = [
      '[System.TeamProject] = @project',
      `[System.WorkItemType] IN (${config.types.map(q).join(', ')})`,
      ...(config.areaPath ? [`[System.AreaPath] UNDER ${q(config.areaPath)}`] : []),
      ...(since ? [`[System.ChangedDate] >= ${q(since)}`] : []),
    ];
    const query = `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] ASC, [System.Id] ASC`;
    const r = await this.call<{ workItems?: { id: number }[] }>(
      ctx,
      `${projectBase(ctx, config)}/_apis/wit/wiql?timePrecision=true&$top=${top}&api-version=${AZURE_DEVOPS_API_VERSION}`,
      { method: 'POST', body: { query } },
    );
    return (r.workItems ?? []).map((w) => w.id);
  }

  /** One authenticated JSON request, with every failure normalized (doc 11 §7). */
  private async call<T>(
    ctx: ConnectionContext,
    url: string,
    req: { method?: string; body?: Json } = {},
  ): Promise<T> {
    const pat = await ctx.secret();
    let res;
    try {
      res = await ctx.http.request(url, {
        method: req.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(req.body ? { 'content-type': 'application/json' } : {}),
          // Azure DevOps PATs use Basic auth with an empty user name.
          authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
        },
        ...(req.body ? { body: JSON.stringify(req.body) } : {}),
      });
    } catch (e) {
      const reason = (e as { reason?: string } | null)?.reason;
      throw new ProviderError(
        reason === 'timeout' ? 'timeout' : 'unavailable',
        'Azure DevOps could not be reached',
      );
    }
    const contentType = res.headers['content-type'] ?? '';
    // An invalid PAT can be answered with 203 and an HTML sign-in page instead of 401.
    if (res.status === 401 || res.status === 203 || (res.status === 200 && !contentType.includes('json')))
      throw new ProviderError('auth_failed', 'Azure DevOps rejected the credential', {
        providerCode: String(res.status),
      });
    if (res.status === 403)
      throw new ProviderError('permission_denied', 'the PAT lacks a permission for this request', {
        providerCode: '403',
      });
    if (res.status === 404) throw new ProviderError('not_found', 'not found', { providerCode: '404' });
    if (res.status === 400)
      throw new ProviderError('validation', 'Azure DevOps refused the request', { providerCode: '400' });
    if (res.status === 429) {
      const retry = Number(res.headers['retry-after']);
      throw new ProviderError('rate_limited', 'Azure DevOps throttled the request', {
        retryAfterMs: retry > 0 ? retry * 1000 : 60_000,
        providerCode: '429',
      });
    }
    if (res.status >= 500)
      throw new ProviderError('unavailable', 'Azure DevOps is unavailable', {
        providerCode: String(res.status),
      });
    if (res.status !== 200)
      throw new ProviderError('unknown', 'unexpected Azure DevOps response', {
        providerCode: String(res.status),
      });
    try {
      return JSON.parse(new TextDecoder().decode(res.body)) as T;
    } catch {
      throw new ProviderError('unknown', 'Azure DevOps answered with invalid JSON');
    }
  }
}

function linksOf(relations: readonly { rel: string; url: string }[]): SourceItemLink[] {
  const kind: Record<string, SourceItemLink['kind']> = {
    'System.LinkTypes.Hierarchy-Reverse': 'parent',
    'System.LinkTypes.Hierarchy-Forward': 'child',
    'System.LinkTypes.Related': 'related',
  };
  return relations.flatMap((r) => {
    const k = kind[r.rel];
    const id = /\/workItems\/(\d+)$/i.exec(r.url)?.[1];
    return k && id ? [{ kind: k, externalId: id }] : [];
  });
}

function boardsConfig(raw: Readonly<Record<string, unknown>>): BoardsConfig {
  const project = typeof raw.project === 'string' ? raw.project.trim() : '';
  if (!PROJECT_NAME.test(project))
    throw new ProviderError('validation', 'binding config needs the Azure DevOps project name', {
      field: 'project',
    });
  const types = Array.isArray(raw.workItemTypes)
    ? raw.workItemTypes.filter((t): t is string => typeof t === 'string' && /^[\w .'-]{1,64}$/.test(t))
    : [...DEFAULT_WORK_ITEM_TYPES];
  if (!types.length || types.length > 20)
    throw new ProviderError('validation', 'workItemTypes must name 1 to 20 types', {
      field: 'workItemTypes',
    });
  const areaPath =
    typeof raw.areaPath === 'string' && raw.areaPath.trim() ? raw.areaPath.trim().slice(0, 256) : null;
  return { project, types, areaPath };
}

function projectBase(ctx: ConnectionContext, config: BoardsConfig): string {
  return `https://dev.azure.com/${parseOrganization(ctx.baseUrl)}/${encodeURIComponent(config.project)}`;
}

function parseCursor(cursor: string | undefined): { time: string; id: number } | null {
  if (!cursor) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\|(\d{1,10})$/.exec(cursor);
  if (!m) throw new ProviderError('validation', 'invalid cursor', { field: 'cursor' });
  return { time: new Date(m[1]!).toISOString(), id: Number(m[2]) };
}

/** The base URL must name exactly one organization (org-scoped PATs, doc 13 §3). */
export function parseOrganization(baseUrl: string | null): string {
  const m = ORG_URL.exec((baseUrl ?? '').replace(/\/+$/, ''));
  if (!m)
    throw new ProviderError('validation', 'base URL must be https://dev.azure.com/{organization}', {
      field: 'baseUrl',
    });
  return m[1]!;
}

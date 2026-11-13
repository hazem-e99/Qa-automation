import {
  ProviderError,
  type CapabilityManifest,
  type ConnectionContext,
  type ConnectionTestResult,
  type ProviderAdapter,
} from '@qos/ports';

/**
 * Azure DevOps connection (doc 13 §3, T-P2-28): the `pat` strategy only.
 *
 * Scope of this version: the connection test. It validates that the base URL names exactly one
 * organization (`https://dev.azure.com/{org}`) and that the PAT can read that organization's
 * projects. Work-item capabilities (requirements sync, issue sync) are added with P3 and P8, so
 * the manifest declares none yet: a connection cannot be bound before those adapters exist.
 *
 * Not done here (and why):
 *  - Detecting global (all-organization) PATs: not visible from the PAT itself.
 *  - PAT expiry: the PAT lifecycle API needs a different (Entra) credential, so the expiry date
 *    cannot be read with the PAT; it is not reported.
 *  - `entra_client_credentials`: not offered until implemented (enterprise, P13).
 */
const ORG_URL = /^https:\/\/dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,48}[A-Za-z0-9]?)$/;
export const AZURE_DEVOPS_API_VERSION = '7.1';

export class AzureDevOpsConnection implements ProviderAdapter {
  static readonly TYPE = 'azure_devops';

  manifest(): CapabilityManifest {
    return {
      providerType: AzureDevOpsConnection.TYPE,
      family: 'requirements',
      adapterVersion: '0.1.0',
      displayName: 'Azure DevOps',
      capabilities: [],
      limits: { richText: 'html', rateLimitHint: 'Retry-After / X-RateLimit-* headers' },
      authStrategies: ['pat'],
      webhook: { verification: 'basic_auth', eventTypeHeader: 'x-qos-event' },
    };
  }

  async testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult> {
    const org = parseOrganization(ctx.baseUrl);
    const pat = await ctx.secret();
    let res;
    try {
      res = await ctx.http.request(
        `https://dev.azure.com/${org}/_apis/projects?api-version=${AZURE_DEVOPS_API_VERSION}&$top=100`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            // Azure DevOps PATs use Basic auth with an empty user name.
            authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
          },
        },
      );
    } catch (e) {
      const reason = (e as { reason?: string } | null)?.reason;
      throw new ProviderError(
        reason === 'timeout' ? 'timeout' : 'unavailable',
        'Azure DevOps could not be reached',
      );
    }
    const contentType = res.headers['content-type'] ?? '';
    // An invalid PAT can be answered with 203 and an HTML sign-in page instead of 401.
    if (res.status === 401 || res.status === 203 || (res.status === 200 && !contentType.includes('json'))) {
      throw new ProviderError('auth_failed', 'Azure DevOps rejected the credential', {
        providerCode: String(res.status),
      });
    }
    if (res.status === 403)
      throw new ProviderError('permission_denied', 'the PAT cannot read projects', { providerCode: '403' });
    if (res.status === 404)
      throw new ProviderError('not_found', 'organization not found', { providerCode: '404' });
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
    const body = JSON.parse(new TextDecoder().decode(res.body)) as {
      count?: number;
      value?: { name: string }[];
    };
    const projects = (body.value ?? []).map((p) => p.name);
    return {
      identity: `organization ${org}`,
      scopesDiscovered: projects.length ? ['vso.project (read)'] : [],
      permissionChecks: [],
    };
  }
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

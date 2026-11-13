import {
  ProviderError,
  type CapabilityManifest,
  type ConnectionContext,
  type ConnectionTestResult,
  type ProviderAdapter,
} from '@qos/ports';

/**
 * Gemini connection (ADR-0019; the pilot AI provider). T-P2-29 scope: the connection test only.
 * Generation goes through the AI Gateway in P5. The API key travels in the `x-goog-api-key`
 * header, never in the URL.
 */
const API = 'https://generativelanguage.googleapis.com';

export class GeminiConnection implements ProviderAdapter {
  static readonly TYPE = 'gemini';

  manifest(): CapabilityManifest {
    return {
      providerType: GeminiConnection.TYPE,
      family: 'ai',
      adapterVersion: '0.1.0',
      displayName: 'Google Gemini',
      // Measured in spike T-P0-06: JSON-schema output and free text both work.
      capabilities: ['ai.generate.structured@1', 'ai.generate.text@1'],
      limits: { rateLimitHint: 'per-model quotas; free tier is small' },
      authStrategies: ['api_key'],
    };
  }

  async testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult> {
    const key = await ctx.secret();
    const base = (ctx.baseUrl ?? API).replace(/\/+$/, '');
    let res;
    try {
      res = await ctx.http.request(`${base}/v1beta/models?pageSize=100`, {
        method: 'GET',
        headers: { 'x-goog-api-key': key, accept: 'application/json' },
      });
    } catch (e) {
      const reason = (e as { reason?: string } | null)?.reason;
      throw new ProviderError(
        reason === 'timeout' ? 'timeout' : 'unavailable',
        'Gemini could not be reached',
      );
    }
    const text = new TextDecoder().decode(res.body);
    if (res.status !== 200) {
      // An invalid key is answered with 400 and reason API_KEY_INVALID.
      if (res.status === 400 && text.includes('API_KEY_INVALID')) {
        throw new ProviderError('auth_failed', 'Gemini rejected the API key', { providerCode: '400' });
      }
      if (res.status === 401)
        throw new ProviderError('auth_failed', 'Gemini rejected the API key', { providerCode: '401' });
      if (res.status === 403)
        throw new ProviderError('permission_denied', 'the API key is not allowed to list models', {
          providerCode: '403',
        });
      if (res.status === 429) {
        const retry = Number(res.headers['retry-after']);
        throw new ProviderError('rate_limited', 'Gemini quota exceeded', {
          retryAfterMs: retry > 0 ? retry * 1000 : 60_000,
          providerCode: '429',
        });
      }
      if (res.status >= 500)
        throw new ProviderError('unavailable', 'Gemini is unavailable', { providerCode: String(res.status) });
      throw new ProviderError('unknown', 'unexpected Gemini response', { providerCode: String(res.status) });
    }
    const body = JSON.parse(text) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const generative = (body.models ?? []).filter((m) =>
      m.supportedGenerationMethods?.includes('generateContent'),
    );
    const ok = generative.length > 0;
    return {
      identity: `API key (${generative.length} generative models)`,
      scopesDiscovered: generative.slice(0, 20).map((m) => m.name.replace(/^models\//, '')),
      permissionChecks: this.manifest().capabilities.map((capability) =>
        ok ? { capability, ok } : { capability, ok, missing: 'no model supports generateContent' },
      ),
    };
  }
}

import { DocumentParseError, type DocumentParser, type ParsedDocument } from '@qos/ports';

/**
 * DocumentParser over HTTP to the parser sidecar (ADR-0013). The sidecar sits on an internal
 * network; its URL comes from configuration, never from user input. Parse errors (422) are final;
 * timeouts, 5xx and connection failures are retryable (the job queue retries them).
 */
export class HttpDocumentParser implements DocumentParser {
  constructor(private readonly opts: { baseUrl: string; timeoutMs?: number }) {}

  async parse(input: {
    kind: ParsedDocument['kind'];
    fileName: string;
    bytes: Uint8Array;
  }): Promise<ParsedDocument> {
    const form = new FormData();
    form.set('kind', input.kind);
    form.set('file', new Blob([input.bytes]), input.fileName.replace(/[^\w.\- ]/g, '_').slice(0, 120));
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/v1/parse`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
      });
    } catch (e) {
      const timeout = (e as { name?: string }).name === 'TimeoutError';
      throw new DocumentParseError(timeout ? 'parser_timeout' : 'parser_unavailable', true);
    }
    if (res.status === 422 || res.status === 413) {
      const body = (await res.json().catch(() => ({}))) as { detail?: { code?: string } };
      throw new DocumentParseError(
        body.detail?.code ?? (res.status === 413 ? 'too_large' : 'parse_failed'),
        false,
      );
    }
    if (!res.ok) throw new DocumentParseError(`parser_http_${res.status}`, res.status >= 500);
    const doc = (await res.json()) as ParsedDocument;
    if (!doc || !Array.isArray(doc.blocks) || typeof doc.parserVersion !== 'string') {
      throw new DocumentParseError('parser_bad_response', false);
    }
    return doc;
  }

  async renderPage(input: { bytes: Uint8Array; page: number; scale?: number }) {
    const form = new FormData();
    form.set('page', String(input.page));
    form.set('scale', String(input.scale ?? 1.5));
    form.set('file', new Blob([input.bytes]), 'document.pdf');
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/v1/render`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs ?? 300_000, 120_000)),
      });
    } catch (e) {
      const timeout = (e as { name?: string }).name === 'TimeoutError';
      throw new DocumentParseError(timeout ? 'parser_timeout' : 'parser_unavailable', true);
    }
    if (res.status === 422 || res.status === 413) {
      const body = (await res.json().catch(() => ({}))) as { detail?: { code?: string } };
      throw new DocumentParseError(body.detail?.code ?? 'render_failed', false);
    }
    if (!res.ok) throw new DocumentParseError(`parser_http_${res.status}`, res.status >= 500);
    const png = new Uint8Array(await res.arrayBuffer());
    if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50)
      throw new DocumentParseError('parser_bad_response', false);
    return { png, pageCount: Number(res.headers.get('x-page-count') ?? 0) };
  }
}

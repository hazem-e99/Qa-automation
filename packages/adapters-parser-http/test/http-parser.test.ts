import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpDocumentParser } from '../src/index.js';

/** A stand-in sidecar answering like the real one (status codes and body shapes of main.py). */
let server: Server;
let url: string;
let mode: 'ok' | 'reject' | 'crash' | 'slow' | 'garbage' = 'ok';
const seen: { kind?: string; size?: number } = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      seen.kind = /name="kind"\r\n\r\n(\w+)/.exec(body)?.[1];
      seen.size = body.length;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (mode === 'ok')
        send(200, {
          parserVersion: 'qos-parser/0.1.0',
          kind: 'csv',
          pages: null,
          languages: ['en'],
          ocrPages: 0,
          blocks: [
            {
              id: 'b1',
              type: 'table_cell',
              text: 'ID',
              locator: { sheet: 'csv', row: 1, col: 1 },
              language: 'en',
            },
          ],
        });
      else if (mode === 'reject') send(422, { detail: { code: 'pdf_unreadable', detail: 'x' } });
      else if (mode === 'crash') send(503, { detail: 'down' });
      else if (mode === 'garbage') send(200, { hello: 'world' });
      else setTimeout(() => send(200, {}), 500);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('HTTP DocumentParser adapter', () => {
  const parser = () => new HttpDocumentParser({ baseUrl: url, timeoutMs: 200 });
  const input = {
    kind: 'csv' as const,
    fileName: 'specs; rm -rf.csv',
    bytes: new TextEncoder().encode('ID,Title\n1,x\n'),
  };

  it('posts the file and kind, and returns the parsed document', async () => {
    mode = 'ok';
    const doc = await parser().parse(input);
    expect(doc.blocks[0]).toMatchObject({ text: 'ID', locator: { row: 1, col: 1 } });
    expect(seen.kind).toBe('csv');
  });

  it('maps failures: parse errors are final, outages and timeouts retryable', async () => {
    mode = 'reject';
    await expect(parser().parse(input)).rejects.toMatchObject({ code: 'pdf_unreadable', retryable: false });
    mode = 'crash';
    await expect(parser().parse(input)).rejects.toMatchObject({ code: 'parser_http_503', retryable: true });
    mode = 'slow';
    await expect(parser().parse(input)).rejects.toMatchObject({ code: 'parser_timeout', retryable: true });
    mode = 'garbage';
    await expect(parser().parse(input)).rejects.toMatchObject({ code: 'parser_bad_response' });
    await expect(
      new HttpDocumentParser({ baseUrl: 'http://127.0.0.1:9' }).parse(input),
    ).rejects.toMatchObject({ code: 'parser_unavailable', retryable: true });
  });
});

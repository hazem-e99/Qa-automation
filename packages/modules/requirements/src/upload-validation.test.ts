import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateUpload } from './upload-validation.js';

const CORPUS = fileURLToPath(new URL('../../../../spikes/parser/corpus/files', import.meta.url));
const file = (name: string) => new Uint8Array(readFileSync(path.join(CORPUS, name)));

describe('upload pre-validation (T-P3-04, M04-AC-08)', () => {
  it('accepts every valid document of the P0 corpus with its real type', () => {
    const valid = readdirSync(CORPUS).filter((n) => !n.startsWith('m'));
    expect(valid.length).toBe(26);
    for (const name of valid) {
      const v = validateUpload(name, file(name));
      expect(v, name).toMatchObject({ ok: true, kind: name.split('.').pop() });
    }
  });

  it('rejects the hostile files before any parsing', () => {
    expect(validateUpload('m27-truncated-en.pdf', file('m27-truncated-en.pdf'))).toEqual({
      ok: false,
      reason: 'truncated_pdf',
    });
    expect(validateUpload('m28-encrypted-en.pdf', file('m28-encrypted-en.pdf'))).toEqual({
      ok: false,
      reason: 'encrypted_pdf',
    });
    expect(validateUpload('m29-zipbomb.docx', file('m29-zipbomb.docx'))).toEqual({
      ok: false,
      reason: 'zip_bomb_suspected',
    });
    expect(validateUpload('m30-disguised-exe.pdf', file('m30-disguised-exe.pdf'))).toEqual({
      ok: false,
      reason: 'executable',
    });
  });

  it('trusts bytes, not names', () => {
    expect(validateUpload('spec.docx', file('p09-library-en-numbered.pdf'))).toEqual({
      ok: false,
      reason: 'magic_bytes_mismatch',
    });
    expect(validateUpload('sheet.xlsx', file('d01-checkout-en-numbered.docx'))).toEqual({
      ok: false,
      reason: 'not_an_xlsx',
    });
    expect(validateUpload('notes.csv', file('x22-auth-en-sheet.xlsx'))).toEqual({
      ok: false,
      reason: 'magic_bytes_mismatch',
    });
    expect(validateUpload('run.exe', new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(validateUpload('bad.csv', new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toEqual({
      ok: false,
      reason: 'csv_not_utf8',
    });
    expect(validateUpload('empty.pdf', new Uint8Array())).toEqual({ ok: false, reason: 'empty' });
  });

  it('enforces the size cap and the ZIP entry limit', () => {
    const docx = file('d01-checkout-en-numbered.docx');
    expect(
      validateUpload('d.docx', docx, { maxBytes: 100, zipMaxEntries: 10_000, zipMaxExpandedBytes: 2 ** 30 }),
    ).toEqual({ ok: false, reason: 'too_large' });
    expect(
      validateUpload('d.docx', docx, { maxBytes: 2 ** 30, zipMaxEntries: 2, zipMaxExpandedBytes: 2 ** 30 }),
    ).toEqual({ ok: false, reason: 'zip_too_many_entries' });
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedDocument } from '@qos/ports';
import { describe, expect, it } from 'vitest';
import { covers, detectColumns, extractCandidates, measure, type GoldRequirement } from './extraction.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures/parsed', import.meta.url));
const GOLD = fileURLToPath(new URL('../../../../spikes/parser/corpus/gold', import.meta.url));
const load = (name: string) =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as ParsedDocument;
const gold = (name: string) =>
  (
    JSON.parse(readFileSync(path.join(GOLD, `${name.slice(0, 3)}.json`), 'utf8')) as {
      requirements: GoldRequirement[];
    }
  ).requirements;

describe('extraction rules on the P0 corpus (T-P3-06)', () => {
  const files = existsSync(FIXTURES)
    ? readdirSync(FIXTURES)
        .map((f) => f.replace(/\.json$/, ''))
        .sort()
    : [];

  it('meets the P3 floor: structural recall ≥ 0.7 over the corpus, and reports per file', () => {
    expect(files.length).toBeGreaterThanOrEqual(22);
    const rows = files.map((f) => ({ file: f, ...measure(extractCandidates(load(f).blocks), gold(f)) }));
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0);
    const recall = sum('found') / sum('requirements');
    const precision = sum('matchedCandidates') / Math.max(1, sum('candidates'));
    const acRecall = sum('acFound') / sum('acTotal');
    // The report the P3 DoD asks for (printed with --reporter=verbose).
    process.stdout.write(
      rows
        .map(
          (r) =>
            `${r.file}: req ${r.found}/${r.requirements}, cand ${r.candidates}, AC ${r.acFound}/${r.acTotal}\n`,
        )
        .join(''),
    );
    process.stdout.write(
      `TOTAL recall ${recall.toFixed(2)} precision ${precision.toFixed(2)} AC recall ${acRecall.toFixed(2)}\n`,
    );
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  it('extracts tables and sheets with IDs and split criteria', () => {
    const c = extractCandidates(load('x22-auth-en-sheet').blocks);
    const reqs = c.filter((x) => x.kind === 'requirement');
    expect(reqs.length).toBe(gold('x22').length);
    expect(reqs[0]!.externalKey).toMatch(/\S/);
    expect(
      c
        .filter((x) => x.kind === 'ac')
        .every((a) => a.parent !== null && c[a.parent!]!.kind === 'requirement'),
    ).toBe(true);
    expect(reqs.every((r) => r.locator.sheet !== undefined && r.locator.row !== undefined)).toBe(true);
  });

  it('caps confidence for OCR text, so low-quality scans need review (M04-AC-07)', () => {
    const scan = files.find((f) => f.startsWith('s20'));
    if (!scan) return;
    const doc = load(scan);
    expect(doc.ocrPages).toBe(1);
    const c = extractCandidates(doc.blocks);
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.confidence <= Math.max(...doc.blocks.map((b) => b.ocrConfidence ?? 0)))).toBe(
      true,
    );
    expect(c.some((x) => x.confidence < 0.8)).toBe(true);
  });

  it('detects column roles in English and Arabic headers', () => {
    expect(detectColumns(['ID', 'Requirement', 'Acceptance criteria', 'Priority'])).toEqual({
      id: 1,
      text: 2,
      ac: 3,
      priority: 4,
    });
    expect(detectColumns(['المعرف', 'المتطلب', 'معايير القبول'])).toEqual({ id: 1, text: 2, ac: 3 });
    expect(detectColumns(['Module', 'Title', 'Notes'])).toEqual({ module: 1, title: 2, text: 2 });
  });

  it('matches gold text order-insensitively and diacritics-insensitively', () => {
    expect(covers('يجب أن يتمكن المستخدمُ من تسجيل الدخول', 'يجب أن يتمكن المستخدم من تسجيل الدخول')).toBe(
      true,
    );
    expect(covers('Totally different text here', 'The system shall export reports')).toBe(false);
  });
});

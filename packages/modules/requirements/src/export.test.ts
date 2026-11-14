import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { toCsv } from './export.js';
import { validateUpload } from './upload-validation.js';
import { writeXlsx } from './xlsx.js';

/** Reads the entries of a ZIP written by `writeXlsx` (deflate only) from its central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localName = buf.readUInt16LE(offset + 26);
    const data = buf.subarray(offset + 30 + localName, offset + 30 + localName + size);
    out.set(name, inflateRawSync(data).toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
}

describe('XLSX writer (T-P3-16)', () => {
  const bytes = writeXlsx([
    {
      name: 'Requirements',
      rows: [
        ['Key', 'N'],
        ['PRJ-R-1', 3],
        ['تسجيل الدخول', null],
      ],
      rightToLeft: true,
    },
    { name: 'Bad/name:[x]?', rows: [['A'], ['=1+1 & <b>\u0001']] },
  ]);
  const files = unzip(bytes);

  it('is a workbook the upload validator accepts as XLSX', () => {
    expect(validateUpload('export.xlsx', bytes)).toMatchObject({ ok: true, kind: 'xlsx' });
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
  });

  it('writes numbers as numbers, text as inline strings, and escapes markup', () => {
    const s1 = files.get('xl/worksheets/sheet1.xml')!;
    expect(s1).toContain('<c r="B2"><v>3</v></c>');
    expect(s1).toContain('rightToLeft="1"');
    expect(s1).toContain('تسجيل الدخول');
    expect(s1).toContain('<c r="A1" t="inlineStr" s="1">');
    const s2 = files.get('xl/worksheets/sheet2.xml')!;
    // A formula-like value stays text (inline string, never <f>), control characters are dropped.
    expect(s2).toContain('<t xml:space="preserve">=1+1 &amp; &lt;b&gt;</t>');
    expect(s2).not.toContain('<f>');
    expect(files.get('xl/workbook.xml')).toContain('name="Bad name  x"');
  });

  it('is deterministic for the same input', () => {
    expect(Buffer.from(writeXlsx([{ name: 'A', rows: [['x']] }]))).toEqual(
      Buffer.from(writeXlsx([{ name: 'A', rows: [['x']] }])),
    );
  });
});

describe('CSV export', () => {
  it('starts with a byte-order mark, quotes where needed and neutralises formulas', () => {
    const text = Buffer.from(
      toCsv([
        ['Key', 'Title'],
        ['R-1', '=SUM(A1:A2)'],
        ['R-2', 'a "quoted", multi\nline'],
        ['R-3', '-10'],
        ['R-4', 42],
        ['R-5', null],
      ]),
    ).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')).toEqual([
      'Key,Title',
      "R-1,'=SUM(A1:A2)",
      'R-2,"a ""quoted"", multi\nline"',
      "R-3,'-10",
      'R-4,42',
      'R-5,',
      '',
    ]);
  });
});

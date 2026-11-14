/**
 * Upload pre-validation (T-P3-04, doc 21 §8, M04-AC-08). Runs on the raw bytes before anything is
 * stored or sent to the parser: allowed types by magic bytes (never by name alone), size cap,
 * encrypted PDFs, truncated PDFs, executables in disguise, and ZIP bombs in DOCX/XLSX (declared
 * sizes and entry count read from the ZIP central directory, without decompressing anything).
 */
export const UPLOAD_KINDS = ['pdf', 'docx', 'xlsx', 'csv'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export interface UploadLimits {
  readonly maxBytes: number;
  readonly zipMaxEntries: number;
  readonly zipMaxExpandedBytes: number;
}
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: 50 * 2 ** 20,
  zipMaxEntries: 10_000,
  zipMaxExpandedBytes: 500 * 2 ** 20,
};

export type UploadRejection =
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'magic_bytes_mismatch'
  | 'executable'
  | 'encrypted_pdf'
  | 'truncated_pdf'
  | 'corrupt_zip'
  | 'zip_too_many_entries'
  | 'zip_bomb_suspected'
  | 'not_a_docx'
  | 'not_an_xlsx'
  | 'csv_not_utf8';

export type UploadVerdict =
  | { readonly ok: true; readonly kind: UploadKind; readonly mime: string }
  | { readonly ok: false; readonly reason: UploadRejection };

const MIME: Record<UploadKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\3\4
const MZ = [0x4d, 0x5a]; // Windows executable
const ELF = [0x7f, 0x45, 0x4c, 0x46];

/** Entries of a ZIP's central directory: names and declared uncompressed sizes. */
export function zipDirectory(
  b: Uint8Array,
): { names: string[]; totalUncompressed: number; entries: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  const min = Math.max(0, b.length - 65_557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset >= b.length) return null;
  const names: string[] = [];
  let total = 0;
  let p = cdOffset;
  const decoder = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (p + 46 > b.length || view.getUint32(p, true) !== 0x02014b50) return null;
    total += view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    names.push(decoder.decode(b.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { names, totalUncompressed: total, entries };
}

function kindFromName(name: string): UploadKind | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext && (UPLOAD_KINDS as readonly string[]).includes(ext) ? (ext as UploadKind) : null;
}

/** Validates an upload. The declared file name only chooses what the bytes must prove to be. */
export function validateUpload(
  fileName: string,
  bytes: Uint8Array,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): UploadVerdict {
  if (!bytes.length) return { ok: false, reason: 'empty' };
  if (bytes.length > limits.maxBytes) return { ok: false, reason: 'too_large' };
  if (startsWith(bytes, MZ) || startsWith(bytes, ELF)) return { ok: false, reason: 'executable' };
  const kind = kindFromName(fileName);
  if (!kind) return { ok: false, reason: 'unsupported_type' };

  if (kind === 'pdf') {
    if (!startsWith(bytes, PDF)) return { ok: false, reason: 'magic_bytes_mismatch' };
    const text = Buffer.from(bytes).toString('latin1');
    if (text.includes('/Encrypt')) return { ok: false, reason: 'encrypted_pdf' };
    if (!text.slice(-2048).includes('%%EOF')) return { ok: false, reason: 'truncated_pdf' };
  } else if (kind === 'docx' || kind === 'xlsx') {
    if (!startsWith(bytes, ZIP)) return { ok: false, reason: 'magic_bytes_mismatch' };
    const dir = zipDirectory(bytes);
    if (!dir) return { ok: false, reason: 'corrupt_zip' };
    if (dir.entries > limits.zipMaxEntries) return { ok: false, reason: 'zip_too_many_entries' };
    if (dir.totalUncompressed > limits.zipMaxExpandedBytes)
      return { ok: false, reason: 'zip_bomb_suspected' };
    if (kind === 'docx' && !dir.names.includes('word/document.xml'))
      return { ok: false, reason: 'not_a_docx' };
    if (kind === 'xlsx' && !dir.names.includes('xl/workbook.xml'))
      return { ok: false, reason: 'not_an_xlsx' };
  } else {
    if (startsWith(bytes, PDF) || startsWith(bytes, ZIP))
      return { ok: false, reason: 'magic_bytes_mismatch' };
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: 'csv_not_utf8' };
    }
  }
  return { ok: true, kind, mime: MIME[kind] };
}

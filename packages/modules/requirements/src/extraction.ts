import type { BlockLocator, ParsedBlock } from '@qos/ports';
import { normalizeForSearch } from './domain.js';

/**
 * Deterministic extraction (T-P3-06, M04-FR-05, doc 14 §5): candidate requirements and
 * acceptance criteria from parsed blocks, structure first. AI-assisted extraction joins in P5.
 * Confidence is a rule score, capped by OCR confidence; below the review threshold (0.6 by
 * default, BR-M04-7) an item can only be accepted one by one.
 */
export interface Candidate {
  readonly kind: 'requirement' | 'ac';
  readonly text: string;
  readonly externalKey: string | null;
  readonly locator: BlockLocator;
  readonly language: string | null;
  readonly confidence: number;
  /** Index (in the returned list) of the requirement an acceptance criterion belongs to. */
  readonly parent: number | null;
  readonly rule: string;
}

const ID = /^\(?([A-Z]{2,8}-\d{1,5}(?:\.\d+)?)\)?\s*[:.)\-–—]?\s+(.+)$/s;
/** "REQ-1:" printed visually as "-1REQ:" by RTL text layers. */
const MIRRORED_ID = /^-(\d{1,5})([A-Z]{2,8})\s*[:.)\-–]?\s+(.+)$/s;
const ID_ANYWHERE = /\b([A-Z]{2,8}-\d{1,5})\b/;
const MODAL_EN = /\b(shall|must|should|is required to|are required to|will be able to|has to|needs? to)\b/i;
const MODAL_AR = /(يجب|ينبغي|يتعين|يلزم|لا يجوز|يُسمح|يسمح|على النظام|يتمكن|يمكن للمستخدم)/;
const STORY_EN = /^as an? [^,]{2,80},? i (want|need|can)\b/i;
const STORY_AR = /^(بصفتي|بوصفي|كمستخدم|بصفتك)/;
const GHERKIN = /^(given|when|then|and|but)\b/i;
const GHERKIN_AR = /^(بافتراض|عندما|إذا|ثم|عند)\b/;
const AC_LABEL =
  // Longest labels first: "AC" must not eat the start of "Acceptance criteria".
  /^(acceptance criteri(?:on|a)|criteria|ac(?=[\s\d:.\-–]|$)\s*\d*|معايير القبول|معيار القبول|شروط القبول)\s*[:.\-–]?\s*/i;
const AC_SECTION = /(acceptance criteria|معايير القبول|شروط القبول)/i;
const EXAMPLE = /^(for example|e\.g\.|على سبيل المثال|مثال)\b[,:]?\s*/i;
const REQ_SECTION = /(requirement|functional|المتطلبات|متطلبات)/i;
const NUMBERED = /^(\d+(\.\d+)*)[.)]\s+(.+)$/s;
const TERMINAL = /[.!?؟。:;]\s*$/;
const TERMINAL_START = /^[.!?؟:]/;
/** "2." printed visually as ".2" by RTL text layers. */
const MIRRORED_NUMBER = /^\.\d+(\.\d+)*\s/;

const isModal = (t: string) => MODAL_EN.test(t) || MODAL_AR.test(t);
const isStory = (t: string) => STORY_EN.test(t) || STORY_AR.test(t.trim());

// ---------- tables ----------

export type ColumnRole = 'id' | 'text' | 'ac' | 'priority' | 'module' | 'title';
export type ColumnMapping = Partial<Record<ColumnRole, number>>;

const HEADER: [ColumnRole, RegExp][] = [
  ['ac', /(acceptance|criteria|^ac$|معايير|شروط القبول)/i],
  ['id', /^(id|req\.?\s*id|requirement id|ref|#|no\.?|المعرف|الرقم|رقم|المرجع)$/i],
  ['priority', /(priority|الأولوية|الاولوية)/i],
  ['module', /(module|component|area|feature|الوحدة|المكون|الوحده)/i],
  ['title', /^(title|summary|العنوان)$/i],
  ['text', /(requirement|description|story|statement|المتطلب|الوصف|القصة|البيان)/i],
];

/** Guesses column roles from a header row (EN/AR). Used as the suggested spreadsheet mapping. */
export function detectColumns(header: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  header.forEach((h, i) => {
    const text = h.trim();
    for (const [role, re] of HEADER) {
      if (mapping[role] === undefined && re.test(text)) {
        mapping[role] = i + 1;
        break;
      }
    }
  });
  if (mapping.text === undefined && mapping.title !== undefined) mapping.text = mapping.title;
  return mapping;
}

type Grid = { key: string; rows: Map<number, Map<number, ParsedBlock>> };

function grids(blocks: readonly ParsedBlock[]): Grid[] {
  const out = new Map<string, Grid>();
  for (const b of blocks) {
    const { row, col } = b.locator;
    if (b.type !== 'table_cell' || row === undefined || col === undefined) continue;
    const key = b.locator.sheet ?? `t${b.locator.table ?? 0}`;
    const g = out.get(key) ?? { key, rows: new Map() };
    const r = g.rows.get(row) ?? new Map();
    r.set(col, b);
    g.rows.set(row, r);
    out.set(key, g);
  }
  return [...out.values()];
}

/** First row of every table or sheet, with the suggested column roles (the mapping editor's input). */
export function tableHeaders(
  blocks: readonly ParsedBlock[],
): { table: string; rows: number; header: string[]; suggested: ColumnMapping }[] {
  return grids(blocks).map((g) => {
    const first = g.rows.get(Math.min(...g.rows.keys()))!;
    const header = Array.from(
      { length: Math.max(...first.keys()) },
      (_, i) => first.get(i + 1)?.text.trim() ?? '',
    );
    return { table: g.key, rows: g.rows.size, header, suggested: detectColumns(header) };
  });
}

const splitAc = (cell: string) =>
  cell
    .split(/\r?\n|;|•|·|•/)
    .map((s) => s.replace(/^[-*–\d.)\s]+/, '').trim())
    .filter((s) => s.length > 2);

/**
 * Rows of a table or sheet as requirements, by a column mapping (given, or detected from the
 * first row). Returns null when no requirement-text column can be found.
 */
export function extractTable(g: Grid, given?: ColumnMapping): Candidate[] | null {
  const rowNos = [...g.rows.keys()].sort((a, b) => a - b);
  if (rowNos.length < 2) return null;
  const header = g.rows.get(rowNos[0]!)!;
  const maxCol = Math.max(...header.keys());
  const mapping =
    given ?? detectColumns(Array.from({ length: maxCol }, (_, i) => header.get(i + 1)?.text ?? ''));
  if (mapping.text === undefined) return null;
  const out: Candidate[] = [];
  const cell = (r: Map<number, ParsedBlock>, role: ColumnRole) =>
    mapping[role] !== undefined ? r.get(mapping[role]!) : undefined;
  for (const rowNo of rowNos.slice(given ? ((given as { headerRow?: number }).headerRow ?? 1) : 1)) {
    const r = g.rows.get(rowNo)!;
    const text = cell(r, 'text');
    if (!text || text.text.trim().length < 3) continue;
    const id = cell(r, 'id')?.text.trim() || null;
    const parent = out.length;
    out.push({
      kind: 'requirement',
      text: text.text.trim(),
      externalKey: id,
      locator: { ...text.locator },
      language: text.language,
      confidence: given ? 0.95 : 0.9,
      parent: null,
      rule: given ? 'table.mapped' : 'table.detected',
    });
    const ac = cell(r, 'ac');
    if (ac) {
      for (const a of splitAc(ac.text)) {
        out.push({
          kind: 'ac',
          text: a,
          externalKey: null,
          locator: { ...ac.locator },
          language: ac.language,
          confidence: given ? 0.95 : 0.85,
          parent,
          rule: 'table.ac',
        });
      }
    }
  }
  return out;
}

// ---------- text ----------

/** Joins PDF/OCR line blocks that continue the previous line (no terminal punctuation, no marker). */
function joinWrappedLines(blocks: readonly ParsedBlock[]): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const lineBased =
      b.locator.line !== undefined &&
      prev?.locator.line !== undefined &&
      prev.locator.page === b.locator.page;
    const startsNew =
      ID.test(b.text) ||
      NUMBERED.test(b.text) ||
      MIRRORED_NUMBER.test(b.text) ||
      GHERKIN.test(b.text) ||
      GHERKIN_AR.test(b.text) ||
      AC_LABEL.test(b.text) ||
      /^[-*•·–]\s/.test(b.text);
    // RTL text layers put sentence-final punctuation at the start of the line (visual order).
    const prevEnded = prev
      ? TERMINAL.test(prev.text) || (prev.language === 'ar' && TERMINAL_START.test(prev.text))
      : true;
    if (
      prev &&
      lineBased &&
      b.type === 'paragraph' &&
      prev.type === 'paragraph' &&
      !prevEnded &&
      !startsNew
    ) {
      out[out.length - 1] = {
        ...prev,
        text: `${prev.text} ${b.text}`,
        ...(prev.ocrConfidence !== undefined || b.ocrConfidence !== undefined
          ? { ocrConfidence: Math.min(prev.ocrConfidence ?? 1, b.ocrConfidence ?? 1) }
          : {}),
      };
    } else out.push(b);
  }
  return out;
}

/**
 * Splits a block that holds several items (PDF layout analysis sometimes merges a whole page)
 * at inline markers: requirement IDs, "Acceptance criteria:", bullets, Given/When/Then, numbered
 * section titles. Pieces keep the block's locator.
 */
const INLINE_SPLIT =
  /\s+(?=(?:[A-Z]{2,8}-\d{1,5}\s*[:.)\-–])|(?:acceptance criteria|معايير القبول|شروط القبول)\s*:|[·••]\s|(?:Given|When|Then)\s|\d+\.\s+[A-Z؀-ۿ][^.]{2,60}?\s(?=[A-Z]{2,8}-\d))/gi;
export function splitInline(b: ParsedBlock): ParsedBlock[] {
  if (b.text.length < 120 || b.type === 'heading') return [b];
  const parts = b.text
    .split(INLINE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return [b];
  return parts.map((text, i) => ({
    ...b,
    id: `${b.id}.${i + 1}`,
    text: text.replace(/^[·••]\s*/, '- '),
    type: /^[·••]/.test(text) ? 'list_item' : b.type,
  }));
}

const cap = (conf: number, b: ParsedBlock) => Math.round(Math.min(conf, b.ocrConfidence ?? 1) * 1000) / 1000;

export function extractCandidates(
  blocks: readonly ParsedBlock[],
  opts: { mapping?: ColumnMapping } = {},
): Candidate[] {
  const out: Candidate[] = [];
  // Tables and sheets first: rows with a requirement column become requirements.
  const tableIds = new Set<string>();
  for (const g of grids(blocks)) {
    const rows = extractTable(g, opts.mapping);
    if (rows) {
      const offset = out.length;
      out.push(...rows.map((c) => ({ ...c, parent: c.parent === null ? null : c.parent + offset })));
      for (const r of g.rows.values()) for (const b of r.values()) tableIds.add(b.id);
    }
  }
  const text = joinWrappedLines(blocks.filter((b) => !tableIds.has(b.id) && b.type !== 'table_cell')).flatMap(
    splitInline,
  );
  let inReqSection = false;
  let inAcSection = false;
  let current: number | null = null; // index of the last requirement
  for (const b of text) {
    const t = b.text.trim();
    if (b.type === 'heading') {
      inReqSection = REQ_SECTION.test(t);
      inAcSection = AC_SECTION.test(t);
      if (!inAcSection) current = null;
      continue;
    }
    const mirrored = MIRRORED_ID.exec(t);
    const idMatch =
      ID.exec(t) ??
      (mirrored ? ([t, `${mirrored[2]}-${mirrored[1]}`, mirrored[3]!] as unknown as RegExpExecArray) : null);
    const numbered = NUMBERED.exec(t);
    const body = idMatch ? idMatch[2]!.trim() : t;
    const acLabel = AC_LABEL.exec(t);
    // Acceptance criteria of the current requirement.
    if (current !== null && !idMatch) {
      const gherkin = GHERKIN.test(t) || GHERKIN_AR.test(t);
      const example = EXAMPLE.exec(t);
      if (acLabel && t.length > acLabel[0].length + 2) {
        out.push({
          kind: 'ac',
          text: t.slice(acLabel[0].length).trim(),
          externalKey: null,
          locator: { ...b.locator },
          language: b.language,
          confidence: cap(0.85, b),
          parent: current,
          rule: 'ac.label',
        });
        continue;
      }
      if (
        gherkin ||
        (b.type === 'list_item' && !isModal(t) && !isStory(t)) ||
        inAcSection ||
        /^[-*•·–]\s/.test(t)
      ) {
        if (acLabel) {
          inAcSection = true;
          continue;
        }
        out.push({
          kind: 'ac',
          text: t.replace(/^[-*•·–]\s+/, ''),
          externalKey: null,
          locator: { ...b.locator },
          language: b.language,
          confidence: cap(gherkin ? 0.85 : 0.75, b),
          parent: current,
          rule: gherkin ? 'ac.gherkin' : 'ac.list',
        });
        continue;
      }
      if (example) {
        out.push({
          kind: 'ac',
          text: t.slice(example[0].length).trim(),
          externalKey: null,
          locator: { ...b.locator },
          language: b.language,
          confidence: cap(0.7, b),
          parent: current,
          rule: 'ac.example',
        });
        continue;
      }
      if (acLabel) {
        inAcSection = true;
        continue;
      }
    }
    // Requirements.
    let conf = 0;
    let rule = '';
    if (idMatch && (isModal(body) || isStory(body))) [conf, rule] = [0.95, 'req.id+modal'];
    else if (idMatch) [conf, rule] = [0.85, 'req.id'];
    else if (isStory(t)) [conf, rule] = [0.85, 'req.story'];
    else if (isModal(t) && t.length >= 15) [conf, rule] = [0.8, 'req.modal'];
    else if (inReqSection && numbered && numbered[3]!.length >= 15) [conf, rule] = [0.65, 'req.numbered'];
    if (conf > 0) {
      const textOut = (idMatch ? body : numbered && rule === 'req.numbered' ? numbered[3]! : t).trim();
      const key = idMatch?.[1] ?? ID_ANYWHERE.exec(t)?.[1] ?? null;
      inAcSection = false;
      current = out.length;
      out.push({
        kind: 'requirement',
        text: textOut,
        externalKey: key,
        locator: { ...b.locator },
        language: b.language,
        confidence: cap(conf, b),
        parent: null,
        rule,
      });
    }
  }
  return out;
}

// ---------- metrics (doc 14 §7) ----------

const words = (s: string) =>
  new Set(
    normalizeForSearch(s)
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(' ')
      .filter((w) => w.length > 1),
  );
/** True when ≥ `threshold` of the gold text's words appear in the candidate (order-insensitive). */
export function covers(candidate: string, gold: string, threshold = 0.8): boolean {
  const g = words(gold);
  if (!g.size) return false;
  const c = words(candidate);
  let hit = 0;
  for (const w of g) if (c.has(w)) hit++;
  return hit / g.size >= threshold;
}

export interface GoldRequirement {
  readonly text: string;
  readonly ac: readonly string[];
}
export interface ExtractionMetrics {
  readonly requirements: number;
  readonly found: number;
  readonly candidates: number;
  readonly matchedCandidates: number;
  readonly acTotal: number;
  readonly acFound: number;
}

export function measure(
  candidates: readonly Candidate[],
  gold: readonly GoldRequirement[],
): ExtractionMetrics {
  const reqs = candidates.filter((c) => c.kind === 'requirement');
  const acs = candidates.filter((c) => c.kind === 'ac');
  // One-to-one: a candidate that swallowed several requirements counts for one of them only.
  const used = new Set<number>();
  let found = 0;
  for (const g of gold) {
    const i = reqs.findIndex((c, idx) => !used.has(idx) && covers(c.text, g.text));
    if (i >= 0) {
      used.add(i);
      found++;
    }
  }
  const matchedCandidates = used.size;
  const allAc = gold.flatMap((g) => g.ac);
  const acFound = allAc.filter(
    (a) => acs.some((c) => covers(c.text, a)) || reqs.some((c) => covers(c.text, a)),
  ).length;
  return {
    requirements: gold.length,
    found,
    candidates: reqs.length,
    matchedCandidates,
    acTotal: allAc.length,
    acFound,
  };
}

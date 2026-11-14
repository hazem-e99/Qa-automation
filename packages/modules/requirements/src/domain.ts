import { createHash } from 'node:crypto';

/**
 * Requirements domain (M04): pure functions, no I/O.
 */

// ---- Arabic-aware normalization for search (M04-FR-19, M04-AC-06) ----

/** Harakat, tanween, shadda, sukun, superscript alef, Quranic marks, and tatweel. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ARABIC_FOLD: Readonly<Record<string, string>> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ى: 'ي',
  ئ: 'ي',
  ؤ: 'و',
  ة: 'ه',
};
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Folds text for matching: diacritics and tatweel removed, alef/ya/ta-marbuta/hamza-seat
 * variants unified, Arabic-Indic digits to ASCII, Latin accents removed, lower case, single spaces.
 * "الدُّخول" and "الدخول" normalize to the same string.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(ARABIC_MARKS, '')
    .replace(/[أإآٱىئؤة]/g, (c) => ARABIC_FOLD[c] ?? c)
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dominant script of a text, for direction and language hints. */
export function detectLanguage(text: string): 'ar' | 'en' | 'mixed' | null {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!ar && !latin) return null;
  if (ar && latin)
    return Math.min(ar, latin) / Math.max(ar, latin) > 0.2 ? 'mixed' : ar > latin ? 'ar' : 'en';
  return ar ? 'ar' : 'en';
}

// ---- content of a version ----

export interface AcceptanceCriterionInput {
  readonly text: string;
  readonly origin: 'source' | 'inferred';
}
export interface RequirementContent {
  readonly title: string;
  readonly bodyMd: string;
  readonly priority: string | null;
  readonly tags: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionInput[];
}

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Cleans and validates content; throws a message key on invalid input. */
export function cleanContent(input: RequirementContent): RequirementContent {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length < 3 || title.length > 300) throw new Error('requirement.title_invalid');
  const bodyMd = input.bodyMd.replace(/\r\n/g, '\n').trim();
  if (bodyMd.length > 100_000) throw new Error('requirement.body_too_long');
  if (input.priority !== null && !(PRIORITIES as readonly string[]).includes(input.priority)) {
    throw new Error('requirement.priority_invalid');
  }
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  if (input.acceptanceCriteria.length > 100) throw new Error('requirement.too_many_ac');
  const acceptanceCriteria = input.acceptanceCriteria
    .map((a) => ({ text: a.text.trim(), origin: a.origin }))
    .filter((a) => a.text.length > 0);
  for (const a of acceptanceCriteria) if (a.text.length > 5000) throw new Error('requirement.ac_too_long');
  return { title, bodyMd, priority: input.priority, tags, acceptanceCriteria };
}

/** Hash of everything an approver vouches for; binds approvals to content (M14-AC-04). */
export function contentHash(c: RequirementContent): string {
  const canonical = JSON.stringify([
    c.title,
    c.bodyMd,
    c.priority,
    [...c.tags].sort(),
    c.acceptanceCriteria.map((a) => [a.text, a.origin]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export const searchTextOf = (c: RequirementContent): string =>
  normalizeForSearch([c.title, c.bodyMd, ...c.acceptanceCriteria.map((a) => a.text), ...c.tags].join(' '));

export const originOf = (base: 'source' | 'manual', c: RequirementContent): 'source' | 'manual' | 'mixed' =>
  c.acceptanceCriteria.some((a) => a.origin === 'inferred') ? 'mixed' : base;

// ---- version workflow (M04-FR-10/11) ----

export type VersionState = 'draft' | 'in_review' | 'approved' | 'superseded' | 'obsolete' | 'rejected';
const TRANSITIONS: Readonly<Record<VersionState, readonly VersionState[]>> = {
  draft: ['in_review', 'superseded', 'obsolete'],
  in_review: ['approved', 'rejected', 'draft'],
  approved: ['superseded', 'obsolete'],
  rejected: ['superseded'],
  superseded: [],
  obsolete: [],
};
export const canTransition = (from: VersionState, to: VersionState): boolean =>
  TRANSITIONS[from].includes(to);

// ---- snapshot diffing (M04-FR-15, T-P3-11) ----

export interface DiffItem {
  /** Stable id from the source when there is one (work item id, numbered requirement "REQ-12"). */
  readonly externalKey?: string | null;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
}
export interface ItemChange<T extends DiffItem> {
  readonly before: T;
  readonly after: T;
  readonly fields: ('title' | 'body' | 'acceptanceCriteria')[];
  readonly ac: { added: string[]; removed: string[] };
}
export interface SnapshotDiff<T extends DiffItem> {
  readonly added: T[];
  readonly removed: T[];
  readonly changed: ItemChange<T>[];
  readonly unchanged: T[];
}

/** Word-trigram-free similarity: Jaccard on normalized words (fast, language-neutral). */
export function similarity(a: string, b: string): number {
  const wa = new Set(normalizeForSearch(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeForSearch(b).split(' ').filter(Boolean));
  if (!wa.size && !wb.size) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

/**
 * Matches two snapshots' items: first by external key, then by best title similarity
 * (≥ `threshold`, one-to-one, greedy by score). Matched pairs are changed or unchanged at
 * requirement and acceptance-criterion level; the rest are added or removed.
 */
export function diffSnapshots<T extends DiffItem>(
  prev: readonly T[],
  next: readonly T[],
  threshold = 0.6,
): SnapshotDiff<T> {
  const pairs: [T, T][] = [];
  const leftPrev = new Set(prev);
  const leftNext = new Set(next);
  const byKey = new Map(prev.filter((p) => p.externalKey).map((p) => [p.externalKey!, p]));
  for (const n of next) {
    const p = n.externalKey ? byKey.get(n.externalKey) : undefined;
    if (p && leftPrev.has(p)) {
      pairs.push([p, n]);
      leftPrev.delete(p);
      leftNext.delete(n);
    }
  }
  const candidates: { p: T; n: T; s: number }[] = [];
  for (const p of leftPrev) {
    for (const n of leftNext) {
      if (p.externalKey && n.externalKey) continue; // both keyed and different: not the same item
      const s = similarity(p.title, n.title);
      if (s >= threshold) candidates.push({ p, n, s });
    }
  }
  candidates.sort((a, b) => b.s - a.s);
  for (const c of candidates) {
    if (leftPrev.has(c.p) && leftNext.has(c.n)) {
      pairs.push([c.p, c.n]);
      leftPrev.delete(c.p);
      leftNext.delete(c.n);
    }
  }
  const changed: ItemChange<T>[] = [];
  const unchanged: T[] = [];
  for (const [before, after] of pairs) {
    const norm = (s: string) => normalizeForSearch(s);
    const fields: ItemChange<T>['fields'] = [];
    if (norm(before.title) !== norm(after.title)) fields.push('title');
    if (norm(before.body) !== norm(after.body)) fields.push('body');
    const prevAc = new Set(before.acceptanceCriteria.map(norm));
    const nextAc = new Set(after.acceptanceCriteria.map(norm));
    const ac = {
      added: after.acceptanceCriteria.filter((a) => !prevAc.has(norm(a))),
      removed: before.acceptanceCriteria.filter((a) => !nextAc.has(norm(a))),
    };
    if (ac.added.length || ac.removed.length) fields.push('acceptanceCriteria');
    if (fields.length) changed.push({ before, after, fields, ac });
    else unchanged.push(after);
  }
  return { added: [...leftNext], removed: [...leftPrev], changed, unchanged };
}

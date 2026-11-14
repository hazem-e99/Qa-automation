/** Shapes of the requirements API (M04 §7) as the web app reads them. */
export type VersionState = 'draft' | 'in_review' | 'approved' | 'superseded' | 'obsolete' | 'rejected';

export interface RequirementSummary {
  id: string;
  key: string;
  title: string;
  state: VersionState;
  effectiveVersion: number | null;
  latestVersion: number;
  priority: string | null;
  tags: string[];
  origin: string;
  sourceKinds: string[];
  sourceRemoved: boolean;
  divergedFromSource: boolean;
  openFindings: number;
  updatedAt: string;
}
export interface VersionView {
  id: string;
  number: number;
  title: string;
  bodyMd: string;
  priority: string | null;
  tags: string[];
  origin: string;
  state: VersionState;
  acceptanceCriteria: { ordinal: number; text: string; origin: string }[];
  createdAt: string;
}
export interface ProvenanceView {
  sourceId: string;
  sourceKind: string;
  sourceName: string;
  snapshotId: string;
  itemId: string;
  method: string;
  locator: Locator;
  capturedAt: string;
}
export interface FindingView {
  id: string;
  type: string;
  status: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
export interface RequirementDetail extends RequirementSummary {
  versions: VersionView[];
  provenance: ProvenanceView[];
  findings: FindingView[];
}
export interface RequirementRef {
  linkId: string;
  requirementId: string;
  key: string;
  title: string;
}
export interface RequirementTrace {
  key: string;
  coverage: string;
  parents: RequirementRef[];
  children: RequirementRef[];
  related: RequirementRef[];
  verifiedBy: {
    linkId: string;
    testCaseId: string;
    requirementVersion: number | null;
    needsReview: boolean;
    reviewReason: { kind?: string } | null;
  }[];
  needsReview: number;
}
export interface SourceView {
  id: string;
  kind: 'external' | 'document_set' | 'spreadsheet' | 'manual';
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}
export interface SnapshotView {
  id: string;
  sourceId: string;
  documentId: string | null;
  version: number;
  fileName: string | null;
  fileKind: string | null;
  sizeBytes: number | null;
  parseStatus: string;
  extractionQuality: Record<string, unknown> | null;
  capturedAt: string;
  counts: { candidate: number; accepted: number; rejected: number };
}
export interface DocumentView {
  id: string;
  title: string;
  versions: SnapshotView[];
}
export interface Locator {
  page?: number;
  line?: number;
  sectionPath?: string[];
  paragraph?: number;
  sheet?: string;
  table?: number;
  row?: number;
  col?: number;
  manual?: string;
}
export interface Candidate {
  id: string;
  text: string;
  externalKey: string | null;
  locator: Locator;
  language: string | null;
  confidence: number;
  rule: string | null;
  status: string;
  bulkAcceptable: boolean;
  acceptanceCriteria: { id: string; text: string; confidence: number; status: string }[];
  duplicates: { requirementId: string; key: string; title: string; similarity: number }[];
}
export interface ParsedBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'list_item' | 'table_cell';
  text: string;
  level?: number;
  locator: Locator;
  language: 'ar' | 'en' | 'mixed' | null;
  ocrConfidence?: number;
}
export interface ParsedDocument {
  kind: 'pdf' | 'docx' | 'xlsx' | 'csv';
  pages: number | null;
  languages: string[];
  ocrPages: number;
  blocks: ParsedBlock[];
}
export interface ChangeItem {
  itemId: string;
  externalKey?: string | null;
  title: string;
  requirement: { id: string; key: string; state: string } | null;
}
export interface SnapshotChanges {
  previousSnapshotId: string;
  added: ChangeItem[];
  removed: ChangeItem[];
  changed: { before: ChangeItem; after: ChangeItem; fields: string[] }[];
  unchanged: { before: ChangeItem; after: ChangeItem }[];
  impact: {
    requirements: { key: string; state: string; change: 'changed' | 'removed' }[];
    testCases: { linkId: string; testCaseId: string; requirementKey: string; needsReview: boolean }[];
  };
}
export interface MappingPreview {
  tables: { table: string; rows: number; header: string[]; suggested: Record<string, number> }[];
  mapping: Record<string, number> | null;
  requirements: number;
  acceptanceCriteria: number;
  sample: { text: string; externalKey: string | null; acceptanceCriteria: string[] }[];
}

export const COLUMN_ROLES = ['id', 'text', 'ac', 'priority', 'module', 'title'] as const;

/** Keys a block and a candidate share when the candidate came from that block. */
const LOCATOR_KEYS = ['page', 'line', 'paragraph', 'sheet', 'table', 'row'] as const;
export function sameLocation(a: Locator, b: Locator): boolean {
  let shared = 0;
  for (const k of LOCATOR_KEYS) {
    if (a[k] === undefined && b[k] === undefined) continue;
    if (a[k] !== b[k]) return false;
    shared++;
  }
  return shared > 0;
}

export const stateTone = (s: string): 'neutral' | 'success' | 'warning' | 'danger' | 'accent' =>
  s === 'approved'
    ? 'success'
    : s === 'in_review'
      ? 'accent'
      : s === 'rejected' || s === 'obsolete'
        ? 'danger'
        : s === 'draft'
          ? 'warning'
          : 'neutral';

import { sql, type Db } from '@qos/db';
import { DomainError } from '@qos/kernel-domain';
import type { Project } from '@qos/projects';
import { coverageOf, linksOf, type LinkView } from '@qos/traceability';
import { detectLanguage } from './domain.js';
import { writeXlsx, type Cell } from './xlsx.js';

/**
 * Requirements and traceability export (M04-FR-20, T-P3-16). CSV is UTF-8 with a byte-order mark
 * (so spreadsheet programs read Arabic correctly) and guards against formula injection; XLSX holds
 * both views as two sheets.
 */
export type ExportFormat = 'csv' | 'xlsx';
export type ExportView = 'requirements' | 'trace';
export interface ExportFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly rows: number;
}

export const EXPORT_MAX_REQUIREMENTS = 20_000;

const REQUIREMENT_HEADER = [
  'Key',
  'Title',
  'State',
  'Effective version',
  'Latest version',
  'Priority',
  'Tags',
  'Origin',
  'Sources',
  'Source kinds',
  'Acceptance criteria',
  'Linked tests',
  'Tests needing review',
  'Coverage',
  'Source removed',
  'Diverged from source',
  'Updated at',
];
const TRACE_HEADER = [
  'Requirement',
  'Link type',
  'Direction',
  'Other type',
  'Other',
  'Other version',
  'Status',
  'Needs review',
  'Review reason',
  'Created at',
];

type Row = {
  id: string;
  key: string;
  title: string;
  state: string;
  effective: number | null;
  latest: number;
  priority: string | null;
  tags: string[];
  origin: string;
  source_removed: boolean;
  diverged: boolean;
  updated_at: Date;
  acs: string | null;
  sources: string | null;
  kinds: string | null;
};

async function rowsOf(db: Db, project: Project): Promise<Row[]> {
  const res = await db.execute<Row>(sql`
    select r.id, r.key, v.title, v.state, ev.number as effective, v.number as latest, v.priority, v.tags,
           v.origin, r.source_removed, r.diverged_from_source as diverged, r.updated_at,
           (select string_agg(a.text, E'\n' order by a.ordinal) from requirements.acceptance_criteria a
             where a.requirement_version_id = v.id) as acs,
           (select string_agg(distinct s.name, '; ') from requirements.requirement_provenance rp
             join requirements.extracted_items ei on ei.id = rp.extracted_item_id
             join requirements.source_snapshots ss on ss.id = ei.snapshot_id
             join requirements.requirement_sources s on s.id = ss.source_id
             where rp.requirement_version_id = v.id) as sources,
           (select string_agg(distinct s.kind, '; ') from requirements.requirement_provenance rp
             join requirements.extracted_items ei on ei.id = rp.extracted_item_id
             join requirements.source_snapshots ss on ss.id = ei.snapshot_id
             join requirements.requirement_sources s on s.id = ss.source_id
             where rp.requirement_version_id = v.id) as kinds
    from requirements.requirements r
    join requirements.requirement_versions v on v.id = r.latest_version_id
    left join requirements.requirement_versions ev on ev.id = r.effective_version_id
    where r.project_id = ${project.id}
    order by (substring(r.key from '-R-([0-9]+)$'))::int, r.key
    limit ${EXPORT_MAX_REQUIREMENTS + 1}`);
  if (res.rows.length > EXPORT_MAX_REQUIREMENTS) throw new DomainError('export.too_large');
  return res.rows;
}

function tables(
  rows: readonly Row[],
  links: readonly LinkView[],
): { requirements: Cell[][]; trace: Cell[][] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const requirementRows: Cell[][] = [REQUIREMENT_HEADER];
  for (const r of rows) {
    const verifies = links.filter((l) => l.type === 'verifies' && l.to.id === r.id);
    requirementRows.push([
      r.key,
      r.title,
      r.state,
      r.effective,
      r.latest,
      r.priority,
      r.tags.join(', '),
      r.origin,
      r.sources,
      r.kinds,
      r.acs,
      verifies.length,
      verifies.filter((l) => l.needsReview).length,
      coverageOf(verifies),
      r.source_removed,
      r.diverged,
      new Date(r.updated_at).toISOString(),
    ]);
  }
  const traceRows: Cell[][] = [TRACE_HEADER];
  for (const r of rows) {
    for (const l of links) {
      const outgoing = l.from.type === 'requirement' && l.from.id === r.id;
      const incoming = l.to.type === 'requirement' && l.to.id === r.id;
      if (!outgoing && !incoming) continue;
      const other = outgoing ? l.to : l.from;
      const otherReq = other.type === 'requirement' ? byId.get(other.id) : undefined;
      traceRows.push([
        r.key,
        l.type,
        outgoing ? 'outgoing' : 'incoming',
        other.type,
        otherReq?.key ?? other.id,
        other.versionId,
        l.status,
        l.needsReview,
        l.reviewReason ? String(l.reviewReason.kind ?? '') : null,
        l.createdAt,
      ]);
    }
  }
  return { requirements: requirementRows, trace: traceRows };
}

/** A cell that a spreadsheet would run as a formula is prefixed with an apostrophe (CSV injection). */
function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const BOM = String.fromCharCode(0xfeff);

export function toCsv(rows: readonly (readonly Cell[])[]): Uint8Array {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return new Uint8Array(Buffer.from(`${BOM}${text}`, 'utf8'));
}

export async function exportRequirements(
  db: Db,
  project: Project,
  opts: { format: ExportFormat; view?: ExportView },
): Promise<ExportFile> {
  const rows = await rowsOf(db, project);
  const links = await linksOf(
    db,
    project,
    'requirement',
    rows.map((r) => r.id),
  );
  const t = tables(rows, links);
  const stamp = new Date().toISOString().slice(0, 10);
  if (opts.format === 'xlsx') {
    const rtl =
      rows.length > 0 && rows.filter((r) => detectLanguage(r.title) === 'ar').length > rows.length / 2;
    return {
      fileName: `${project.key}-requirements-${stamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: writeXlsx([
        { name: 'Requirements', rows: t.requirements, rightToLeft: rtl },
        { name: 'Traceability', rows: t.trace },
      ]),
      rows: rows.length,
    };
  }
  const view = opts.view ?? 'requirements';
  return {
    fileName: `${project.key}-${view === 'trace' ? 'traceability' : 'requirements'}-${stamp}.csv`,
    contentType: 'text/csv; charset=utf-8',
    bytes: toCsv(view === 'trace' ? t.trace : t.requirements),
    rows: (view === 'trace' ? t.trace : t.requirements).length - 1,
  };
}

'use client';

import type { ProjectResponse } from '@qos/contracts';
import { cn } from '@qos/ui';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, EmptyState, Ltr, Notice, Select } from '@/components/ui';
import {
  COLUMN_ROLES,
  sameLocation,
  type Candidate,
  type MappingPreview,
  type ParsedDocument,
  type SnapshotChanges,
  type SnapshotView,
  type SourceView,
} from '@/lib/requirements';
import { locatorText } from '../../[reqKey]/requirement-detail';

type Msg = { tone: 'success' | 'danger' | 'warning'; text: string } | null;
const FILTERS = ['candidate', 'accepted', 'merged', 'rejected', 'all'] as const;
const BULK_MIN = 0.6;

/**
 * Side-by-side review: the parsed source on one side with the selected candidate's location
 * highlighted, the candidates on the other. Keyboard: J/K move, A accept, X reject, M merge into
 * the suggested duplicate. Candidates below the confidence floor can only be accepted one at a
 * time (M04-AC-07).
 */
export function ReviewWorkspace({
  project,
  permissions,
  snapshotId,
  focusItem,
}: {
  project: ProjectResponse;
  permissions: string[];
  snapshotId: string;
  focusItem: string | null;
}) {
  const t = useTranslations('requirements');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [doc, setDoc] = useState<ParsedDocument | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(focusItem ? 'all' : 'candidate');
  const [selected, setSelected] = useState<string | null>(focusItem);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<SnapshotChanges | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState<'text' | 'pages' | 'layout'>('text');
  const [layout, setLayout] = useState<string | null>(null);
  const P = `/projects/${project.key}`;
  const base = `/${locale}/projects/${project.key}/requirements`;
  const canAccept = permissions.includes('requirement.create');
  const canEdit = permissions.includes('requirement.edit');
  const canManage = permissions.includes('requirement_source.manage');

  const loadItems = useCallback(async () => {
    const q = filter === 'all' ? '' : `?status=${filter}`;
    const list = await api<Candidate[]>(`${P}/snapshots/${snapshotId}/candidates${q}`);
    setItems(list);
    setChecked(
      (c) => new Set([...c].filter((id) => list.some((i) => i.id === id && i.status === 'candidate'))),
    );
    setSelected((s) => (s && list.some((i) => i.id === s) ? s : (list[0]?.id ?? null)));
  }, [api, P, snapshotId, filter]);

  const load = useCallback(async () => {
    try {
      const snap = await api<SnapshotView>(`${P}/snapshots/${snapshotId}`);
      setSnapshot(snap);
      const sources = await api<SourceView[]>(`${P}/requirement-sources`);
      setSource(sources.find((s) => s.id === snap.sourceId) ?? null);
      if (snap.parseStatus !== 'parsed') return;
      setDoc(await api<ParsedDocument>(`${P}/snapshots/${snapshotId}/parsed`));
      if (snap.fileKind === 'docx') {
        try {
          setLayout((await api<{ html: string }>(`${P}/snapshots/${snapshotId}/layout`)).html);
        } catch (e) {
          if (!(e instanceof ApiFailure && e.status === 404)) throw e;
        }
      }
      try {
        setChanges(await api<SnapshotChanges>(`${P}/snapshots/${snapshotId}/changes`));
      } catch (e) {
        if (!(e instanceof ApiFailure && e.code === 'snapshot.no_previous')) throw e;
        setChanges(null);
      }
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setMissing(true);
      else setMsg({ tone: 'danger', text: errorText(e) });
    }
  }, [api, P, snapshotId, errorText]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (snapshot?.parseStatus === 'parsed')
      void loadItems().catch((e) => setMsg({ tone: 'danger', text: errorText(e) }));
  }, [snapshot, loadItems, errorText]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok: (r: unknown) => Msg) => {
      setMsg(null);
      try {
        const r = await fn();
        setMsg(ok(r));
        await Promise.all([loadItems(), load()]);
      } catch (e) {
        setMsg({ tone: 'danger', text: errorText(e) });
      }
    },
    [loadItems, load, errorText],
  );

  type AcceptResult = { created: { key: string }[]; skipped: { reason: string }[] };
  const accept = useCallback(
    (ids: string[]) =>
      act(
        () => api<AcceptResult>(`${P}/candidates/accept`, { method: 'POST', body: { itemIds: ids } }),
        (r) => {
          const res = r as AcceptResult;
          const low = res.skipped.filter((s) => s.reason === 'low_confidence').length;
          return {
            tone: low ? 'warning' : 'success',
            text: `${t('acceptedN', { count: res.created.length })}${low ? ` ${t('skippedLow', { count: low })}` : ''}`,
          };
        },
      ),
    [act, api, P, t],
  );
  const reject = useCallback(
    (ids: string[]) =>
      act(
        () => api(`${P}/candidates/reject`, { method: 'POST', body: { itemIds: ids, reason: '' } }),
        () => ({ tone: 'success', text: t('rejectedN', { count: ids.length }) }),
      ),
    [act, api, P, t],
  );
  const merge = useCallback(
    (id: string, key: string) =>
      act(
        () => api(`${P}/candidates/merge`, { method: 'POST', body: { itemId: id, requirementKey: key } }),
        () => ({ tone: 'success', text: t('mergedInto', { key }) }),
      ),
    [act, api, P, t],
  );

  const split = useCallback(
    (id: string, parts: string[]) =>
      act(
        () => api(`${P}/candidates/split`, { method: 'POST', body: { itemId: id, parts } }),
        () => ({ tone: 'success', text: t('splitDone', { count: parts.length }) }),
      ),
    [act, api, P, t],
  );

  const current = items.find((i) => i.id === selected) ?? null;

  // Keyboard flow (S-REQ-03).
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = items.findIndex((i) => i.id === selected);
    const key = e.key.toLowerCase();
    if (key === 'j' && items.length) setSelected(items[Math.min(items.length - 1, idx + 1)]!.id);
    else if (key === 'k' && items.length) setSelected(items[Math.max(0, idx - 1)]!.id);
    else if (key === 'a' && current?.status === 'candidate' && canAccept) void accept([current.id]);
    else if (key === 'x' && current?.status === 'candidate' && canAccept) void reject([current.id]);
    else if (key === 'm' && current?.status === 'candidate' && canEdit && current.duplicates[0])
      void merge(current.id, current.duplicates[0].key);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (missing) return <EmptyState title={t('snapshotNotFound')} />;
  if (!snapshot)
    return msg ? (
      <Notice tone="danger">{msg.text}</Notice>
    ) : (
      <p className="text-sm text-muted">{t('loading')}</p>
    );
  const isSheet = snapshot.fileKind === 'xlsx' || snapshot.fileKind === 'csv';
  const open = items.filter((i) => i.status === 'candidate');
  const bulkIds = [...checked];

  return (
    <div className="flex flex-col gap-4" data-testid="review-workspace">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`${base}/sources`} className="text-sm text-accent hover:underline">
          {t('backToSources')}
        </Link>
        <h2 className="text-lg font-semibold">
          <Ltr>{snapshot.fileName ?? ''}</Ltr>
        </h2>
        <Badge>{t('versionN', { n: snapshot.version })}</Badge>
        {source ? <Badge>{source.name}</Badge> : null}
        {snapshot.extractionQuality ? <QualityLine q={snapshot.extractionQuality} /> : null}
      </div>
      {msg ? (
        <Notice tone={msg.tone} testId="review-message">
          {msg.text}
        </Notice>
      ) : null}
      {snapshot.parseStatus !== 'parsed' ? (
        <EmptyState title={t(`parse_${snapshot.parseStatus}`)}>{t('notParsedHint')}</EmptyState>
      ) : (
        <>
          {changes ? (
            <ChangesPanel
              changes={changes}
              base={base}
              canApply={canEdit}
              onApply={() =>
                act(
                  () => api(`${P}/snapshots/${snapshotId}/apply-changes`, { method: 'POST' }),
                  (r) => {
                    const o = r as {
                      carried: number;
                      newVersions: unknown[];
                      markedRemoved: unknown[];
                      skipped: unknown[];
                    };
                    return {
                      tone: o.skipped.length ? 'warning' : 'success',
                      text: t('changesApplied', {
                        versions: o.newVersions.length,
                        removed: o.markedRemoved.length,
                        carried: o.carried,
                        skipped: o.skipped.length,
                      }),
                    };
                  },
                )
              }
            />
          ) : null}
          {isSheet && source && doc ? (
            <MappingPanel
              project={project.key}
              snapshotId={snapshotId}
              source={source}
              canManage={canManage}
              onSaved={() =>
                act(
                  () => api(`${P}/snapshots/${snapshotId}/re-extract`, { method: 'POST' }),
                  (r) => ({
                    tone: 'success',
                    text: t('reextracted', { count: (r as { candidates: number }).candidates }),
                  }),
                )
              }
            />
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title={t('sourceViewer')}
              testId="source-viewer"
              actions={
                snapshot.renderedPages > 0 || layout ? (
                  <div className="flex gap-1" role="group" aria-label={t('viewMode')}>
                    {(
                      [
                        'text',
                        ...(snapshot.renderedPages > 0 ? ['pages' as const] : []),
                        ...(layout ? ['layout' as const] : []),
                      ] as const
                    ).map((m) => (
                      <Button
                        key={m}
                        tone={view === m ? 'primary' : 'secondary'}
                        aria-pressed={view === m}
                        onClick={() => setView(m)}
                        data-testid={`view-${m}`}
                      >
                        {t(`view_${m}`)}
                      </Button>
                    ))}
                  </div>
                ) : null
              }
            >
              {!doc ? (
                <p className="text-sm text-muted">{t('loading')}</p>
              ) : view === 'layout' && layout ? (
                <LayoutViewer html={layout} title={snapshot.fileName ?? ''} />
              ) : view === 'pages' && snapshot.renderedPages > 0 ? (
                <PageViewer
                  src={(page) => `/api/v1${P}/snapshots/${snapshotId}/pages/${page}`}
                  rendered={snapshot.renderedPages}
                  total={doc.pages ?? snapshot.renderedPages}
                  focus={current?.locator.page ?? null}
                />
              ) : (
                <SourceViewer doc={doc} highlight={current} />
              )}
            </Card>
            <Card
              title={t('candidates')}
              testId="candidates"
              actions={
                <Select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as typeof filter)}
                  data-testid="candidate-filter"
                >
                  {FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {t(`filter_${f}`)}
                    </option>
                  ))}
                </Select>
              }
            >
              {canAccept && open.length ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                  <Button
                    onClick={() =>
                      setChecked(new Set(open.filter((i) => i.confidence >= BULK_MIN).map((i) => i.id)))
                    }
                    data-testid="select-bulk"
                  >
                    {t('selectConfident')}
                  </Button>
                  <Button
                    tone="primary"
                    disabled={!bulkIds.length}
                    onClick={() => accept(bulkIds)}
                    data-testid="accept-selected"
                  >
                    {t('acceptSelected', { count: bulkIds.length })}
                  </Button>
                  <Button
                    tone="danger"
                    disabled={!bulkIds.length}
                    onClick={() => reject(bulkIds)}
                    data-testid="reject-selected"
                  >
                    {t('rejectSelected', { count: bulkIds.length })}
                  </Button>
                  <span className="text-xs text-muted">{t('keyboardHint')}</span>
                </div>
              ) : null}
              {items.length === 0 ? (
                <p className="text-sm text-muted">{t('noCandidates')}</p>
              ) : (
                <ul className="flex flex-col gap-2" role="listbox" aria-label={t('candidates')}>
                  {items.map((c) => (
                    <CandidateCard
                      key={c.id}
                      c={c}
                      active={c.id === selected}
                      checked={checked.has(c.id)}
                      canAccept={canAccept}
                      canMerge={canEdit}
                      onSelect={() => setSelected(c.id)}
                      onCheck={(on) =>
                        setChecked((s) => {
                          const n = new Set(s);
                          if (on) n.add(c.id);
                          else n.delete(c.id);
                          return n;
                        })
                      }
                      onAccept={() => accept([c.id])}
                      onReject={() => reject([c.id])}
                      onMerge={(key) => merge(c.id, key)}
                      onSplit={(parts) => split(c.id, parts)}
                    />
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function QualityLine({ q }: { q: Record<string, unknown> }) {
  const t = useTranslations('requirements');
  if (q.error) return <Badge tone="danger">{t('parseError', { code: String(q.error) })}</Badge>;
  return (
    <span className="text-xs text-muted" data-testid="quality">
      {t('quality', {
        requirements: Number(q.requirements ?? 0),
        criteria: Number(q.acceptanceCriteria ?? 0),
        review: Number(q.needsReview ?? 0),
        ocr: Number(q.ocrPages ?? 0),
      })}
    </span>
  );
}

function CandidateCard({
  c,
  active,
  checked,
  canAccept,
  canMerge,
  onSelect,
  onCheck,
  onAccept,
  onReject,
  onMerge,
  onSplit,
}: {
  c: Candidate;
  active: boolean;
  checked: boolean;
  canAccept: boolean;
  canMerge: boolean;
  onSelect: () => void;
  onCheck: (on: boolean) => void;
  onAccept: () => void;
  onReject: () => void;
  onMerge: (key: string) => void;
  onSplit: (parts: string[]) => void;
}) {
  const t = useTranslations('requirements');
  const ref = useRef<HTMLLIElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const low = c.confidence < BULK_MIN;
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={active}
      data-candidate={c.externalKey ?? c.id}
      data-status={c.status}
      onClick={onSelect}
      className={cn('rounded-md border p-3 text-sm', active ? 'border-accent bg-raised' : 'border-line')}
    >
      <div className="flex items-start gap-2">
        {canAccept && c.status === 'candidate' ? (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('select')}
            className="mt-1"
          />
        ) : null}
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {c.externalKey ? <Ltr>{c.externalKey}</Ltr> : null}
            <Badge tone={low ? 'warning' : 'success'}>
              {t('confidence', { value: Math.round(c.confidence * 100) })}
            </Badge>
            {low ? <span className="text-xs text-warning">{t('lowConfidence')}</span> : null}
            {c.status !== 'candidate' ? <Badge>{t(`item_${c.status}`)}</Badge> : null}
          </div>
          {editing === null ? (
            <p className="mt-1" dir="auto">
              {c.text}
            </p>
          ) : (
            <div className="mt-1 flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
              <textarea
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                rows={Math.min(12, Math.max(3, editing.split('\n').length + 1))}
                dir="auto"
                className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                aria-label={t('splitHint')}
                data-testid="split-text"
              />
              <span className="text-xs text-muted">{t('splitHint')}</span>
              <div className="flex gap-2">
                <Button
                  tone="primary"
                  data-testid="split-save"
                  onClick={() => {
                    const parts = editing
                      .split(/\n\s*\n/)
                      .map((p) => p.trim())
                      .filter(Boolean);
                    if (parts.length) onSplit(parts);
                    setEditing(null);
                  }}
                >
                  {t('splitSave')}
                </Button>
                <Button onClick={() => setEditing(null)}>{t('cancel')}</Button>
              </div>
            </div>
          )}
          {c.acceptanceCriteria.length ? (
            <ul className="mt-1 list-disc ps-5 text-muted">
              {c.acceptanceCriteria.map((a) => (
                <li key={a.id} dir="auto">
                  {a.text}
                </li>
              ))}
            </ul>
          ) : null}
          {c.duplicates.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="duplicates">
              <span className="text-xs text-muted">{t('possibleDuplicate')}</span>
              {c.duplicates.map((d) => (
                <span key={d.requirementId} className="flex items-center gap-1">
                  <Ltr>{d.key}</Ltr>
                  <span className="text-xs text-muted">{Math.round(d.similarity * 100)}%</span>
                  {canMerge && c.status === 'candidate' ? (
                    <Button
                      tone="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMerge(d.key);
                      }}
                      data-testid="merge"
                    >
                      {t('mergeInto')}
                    </Button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {canAccept && c.status === 'candidate' ? (
          <div className="flex flex-col gap-1">
            <Button
              tone="primary"
              onClick={(e) => {
                e.stopPropagation();
                onAccept();
              }}
              data-testid="accept"
            >
              {t('accept')}
            </Button>
            <Button
              tone="danger"
              onClick={(e) => {
                e.stopPropagation();
                onReject();
              }}
              data-testid="reject"
            >
              {t('rejectItem')}
            </Button>
            <Button
              tone="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(c.text);
              }}
              data-testid="split"
            >
              {t('split')}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A DOCX as laid out. The HTML is sanitized by the parser (structure only); it is shown in a
 * frame without scripts, same-origin access, forms or network (sandbox + CSP), as defense in depth.
 */
function LayoutViewer({ html, title }: { html: string; title: string }) {
  const t = useTranslations('requirements');
  const srcDoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<style>body{font:14px/1.6 system-ui,sans-serif;margin:16px;color:#111;background:#fff}' +
    'table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;white-space:pre-wrap}' +
    'th{background:#f3f3f3}</style></head><body dir="auto">' +
    html +
    '</body></html>';
  return (
    <iframe
      sandbox=""
      srcDoc={srcDoc}
      title={t('layoutOf', { name: title })}
      className="h-[70vh] w-full rounded border border-line bg-white"
      data-testid="layout-frame"
    />
  );
}

/** PDF pages as images (rendered at parse time); follows the selected candidate's page. */
function PageViewer({
  src,
  rendered,
  total,
  focus,
}: {
  src: (page: number) => string;
  rendered: number;
  total: number;
  focus: number | null;
}) {
  const t = useTranslations('requirements');
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (focus !== null && focus >= 1 && focus <= rendered) setPage(focus);
  }, [focus, rendered]);
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="page-viewer">
      <div className="flex items-center gap-2">
        <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('previousPage')}>
          ‹
        </Button>
        <span data-testid="page-number">{t('pageOf', { page, total })}</span>
        <Button disabled={page >= rendered} onClick={() => setPage((p) => p + 1)} aria-label={t('nextPage')}>
          ›
        </Button>
      </div>
      {total > rendered ? (
        <p className="text-xs text-muted">{t('pagesLimited', { count: rendered })}</p>
      ) : null}
      <img
        src={src(page)}
        alt={t('pageImage', { page })}
        className="max-h-[70vh] w-full rounded border border-line bg-white object-contain"
        data-testid="page-image"
      />
    </div>
  );
}

/**
 * Parsed source: headings, paragraphs and list items in order; sheets and tables as a grid.
 * Every text renders as plain text (never HTML) with its own direction.
 */
function SourceViewer({ doc, highlight }: { doc: ParsedDocument; highlight: Candidate | null }) {
  const t = useTranslations('requirements');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('[data-hit="true"]')?.scrollIntoView({ block: 'center' });
  }, [highlight]);
  const groups = useMemo(() => {
    const out: { key: string; table: boolean; blocks: ParsedDocument['blocks'] }[] = [];
    for (const b of doc.blocks) {
      const table = b.type === 'table_cell';
      const key = table ? `t:${b.locator.sheet ?? ''}:${b.locator.table ?? ''}` : `p:${b.id}`;
      const last = out[out.length - 1];
      if (table && last?.key === key) last.blocks.push(b);
      else out.push({ key, table, blocks: [b] });
    }
    return out;
  }, [doc]);
  const hit = (l: ParsedDocument['blocks'][number]['locator']) =>
    highlight ? sameLocation(l, highlight.locator) : false;

  return (
    <div ref={box} className="max-h-[70vh] overflow-auto text-sm" data-testid="source-blocks">
      {highlight ? <p className="mb-2 text-xs text-muted">{locatorText(t, highlight.locator)}</p> : null}
      {groups.map((g) =>
        g.table ? (
          <SheetGrid key={g.key} title={g.blocks[0]!.locator.sheet} blocks={g.blocks} hit={hit} />
        ) : (
          g.blocks.map((b) => {
            const Tag = b.type === 'heading' ? 'h3' : 'p';
            return (
              <Tag
                key={b.id}
                dir="auto"
                data-hit={hit(b.locator) ? 'true' : undefined}
                className={cn(
                  'rounded px-1 py-0.5',
                  b.type === 'heading' ? 'mt-3 font-semibold' : '',
                  b.type === 'list_item' ? 'ps-4' : '',
                  hit(b.locator) ? 'bg-accent/15 outline outline-1 outline-accent' : '',
                )}
              >
                {b.locator.page !== undefined && b.type === 'heading' ? (
                  <span className="me-2 text-xs text-muted">{t('loc_page', { page: b.locator.page })}</span>
                ) : null}
                {b.text}
                {b.ocrConfidence !== undefined ? (
                  <span className="ms-2 text-xs text-warning">
                    {t('ocr', { value: Math.round(b.ocrConfidence * 100) })}
                  </span>
                ) : null}
              </Tag>
            );
          })
        ),
      )}
    </div>
  );
}

function SheetGrid({
  title,
  blocks,
  hit,
}: {
  title?: string;
  blocks: ParsedDocument['blocks'];
  hit: (l: ParsedDocument['blocks'][number]['locator']) => boolean;
}) {
  const rows = new Map<number, Map<number, ParsedDocument['blocks'][number]>>();
  for (const b of blocks) {
    const r = b.locator.row ?? 0;
    if (!rows.has(r)) rows.set(r, new Map());
    rows.get(r)!.set(b.locator.col ?? 0, b);
  }
  const cols = Math.max(0, ...blocks.map((b) => b.locator.col ?? 0));
  return (
    <div className="my-2 overflow-x-auto">
      {title ? <p className="text-xs font-medium text-muted">{title}</p> : null}
      <table className="w-full border-collapse text-xs">
        <tbody>
          {[...rows.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([r, cells]) => {
              const on = [...cells.values()].some((c) => hit(c.locator));
              return (
                <tr key={r} data-hit={on ? 'true' : undefined} className={on ? 'bg-accent/15' : ''}>
                  <th scope="row" className="border border-line px-1 text-muted">
                    {r}
                  </th>
                  {Array.from({ length: cols }, (_, i) => i + 1).map((c) => (
                    <td key={c} dir="auto" className="border border-line px-1 align-top">
                      {cells.get(c)?.text ?? ''}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

function ChangesPanel({
  changes,
  base,
  canApply,
  onApply,
}: {
  changes: SnapshotChanges;
  base: string;
  canApply: boolean;
  onApply: () => void;
}) {
  const t = useTranslations('requirements');
  const pendingApply =
    changes.changed.some((c) => c.before.requirement) || changes.removed.some((r) => r.requirement);
  return (
    <Card
      title={t('changesTitle')}
      testId="changes"
      actions={
        canApply && pendingApply ? (
          <Button tone="primary" onClick={onApply} data-testid="apply-changes">
            {t('applyChanges')}
          </Button>
        ) : null
      }
    >
      <div className="grid gap-4 text-sm md:grid-cols-4">
        <ChangeList
          title={t('changeAdded', { count: changes.added.length })}
          items={changes.added.map((a) => ({ id: a.itemId, label: a.externalKey ?? a.title }))}
          testId="change-added"
        />
        <ChangeList
          title={t('changeChanged', { count: changes.changed.length })}
          items={changes.changed.map((c) => ({
            id: c.after.itemId,
            label: c.after.externalKey ?? c.after.title,
            key: c.before.requirement?.key,
          }))}
          base={base}
          testId="change-changed"
        />
        <ChangeList
          title={t('changeRemoved', { count: changes.removed.length })}
          items={changes.removed.map((r) => ({
            id: r.itemId,
            label: r.externalKey ?? r.title,
            key: r.requirement?.key,
          }))}
          base={base}
          testId="change-removed"
        />
        <div data-testid="impact">
          <h3 className="font-medium">{t('impactedTests', { count: changes.impact.testCases.length })}</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {changes.impact.testCases.map((tc) => (
              <li key={tc.linkId} className="flex items-center gap-2">
                <Ltr>{tc.testCaseId.slice(0, 8)}</Ltr>
                <span className="text-muted">→</span>
                <Ltr>{tc.requirementKey}</Ltr>
                {tc.needsReview ? <Badge tone="warning">{t('needsReview')}</Badge> : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{t('unchangedN', { count: changes.unchanged.length })}</p>
        </div>
      </div>
    </Card>
  );
}

function ChangeList({
  title,
  items,
  base,
  testId,
}: {
  title: string;
  items: { id: string; label: string; key?: string }[];
  base?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h3 className="font-medium">{title}</h3>
      <ul className="mt-1 flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2">
            <bdi className="line-clamp-2">{i.label}</bdi>
            {i.key && base ? (
              <Link href={`${base}/${i.key}`} className="text-accent hover:underline">
                <Ltr>{i.key}</Ltr>
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Spreadsheet column mapping (T-P3-07, S-REQ-07): suggested roles, preview, save and re-extract. */
function MappingPanel({
  project,
  snapshotId,
  source,
  canManage,
  onSaved,
}: {
  project: string;
  snapshotId: string;
  source: SourceView;
  canManage: boolean;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('requirements');
  const api = useApi();
  const errorText = useErrorText();
  const saved = (source.config.mapping as Record<string, number> | undefined) ?? null;
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>(saved ?? {});
  const [error, setError] = useState<string | null>(null);
  const P = `/projects/${project}`;

  const run = useCallback(
    async (m: Record<string, number> | null) => {
      try {
        setPreview(
          await api<MappingPreview>(`${P}/snapshots/${snapshotId}/mapping-preview`, {
            method: 'POST',
            body: { mapping: m },
          }),
        );
        setError(null);
      } catch (e) {
        setError(errorText(e));
      }
    },
    [api, P, snapshotId, errorText],
  );
  useEffect(() => void run(saved), [run, saved]);
  useEffect(() => {
    if (!saved && preview?.tables[0] && !Object.keys(mapping).length) setMapping(preview.tables[0].suggested);
  }, [preview, saved, mapping]);

  const header = preview?.tables[0]?.header ?? [];
  const roleOf = (col: number) => COLUMN_ROLES.find((r) => mapping[r] === col) ?? '';
  const setRole = (col: number, role: string) =>
    setMapping((m) => {
      const n = Object.fromEntries(Object.entries(m).filter(([r, c]) => c !== col && r !== role));
      return role ? { ...n, [role]: col } : n;
    });

  return (
    <Card title={t('mappingTitle')} testId="mapping-panel">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {header.length ? (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap gap-3">
            {header.map((h, i) => (
              <label key={i} className="flex flex-col gap-1">
                <span className="text-xs text-muted" dir="auto">
                  {h || t('column', { n: i + 1 })}
                </span>
                <Select
                  value={roleOf(i + 1)}
                  onChange={(e) => setRole(i + 1, e.target.value)}
                  disabled={!canManage}
                  data-testid={`role-${i + 1}`}
                >
                  <option value="">{t('role_none')}</option>
                  {COLUMN_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`role_${r}`)}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          {preview ? (
            <p className="text-xs text-muted" data-testid="mapping-result">
              {t('mappingResult', {
                requirements: preview.requirements,
                criteria: preview.acceptanceCriteria,
              })}
            </p>
          ) : null}
          {canManage ? (
            <div className="flex gap-2">
              <Button onClick={() => run(mapping)} data-testid="preview-mapping">
                {t('previewMapping')}
              </Button>
              <Button
                tone="primary"
                disabled={mapping.text === undefined}
                data-testid="save-mapping"
                onClick={async () => {
                  try {
                    await api(`${P}/requirement-sources/${source.id}`, {
                      method: 'PATCH',
                      body: { config: { ...source.config, mapping } },
                    });
                    await onSaved();
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                {t('saveMapping')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">{t('noTables')}</p>
      )}
    </Card>
  );
}

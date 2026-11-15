'use client';

import type { ProjectResponse } from '@qos/contracts';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiFailure, useApi, useErrorText } from '@/components/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Ltr,
  Notice,
  Select,
  Textarea,
} from '@/components/ui';
import {
  stateTone,
  type Locator,
  type RequirementDetail,
  type RequirementRef,
  type RequirementTrace,
} from '@/lib/requirements';

type Msg = { tone: 'success' | 'danger'; text: string } | null;

export function locatorText(
  t: (k: string, v?: Record<string, string | number>) => string,
  l: Locator,
): string {
  const parts: string[] = [];
  if (l.sheet) parts.push(t('loc_sheet', { sheet: l.sheet }));
  if (l.page !== undefined) parts.push(t('loc_page', { page: l.page }));
  if (l.table !== undefined) parts.push(t('loc_table', { table: l.table }));
  if (l.row !== undefined) parts.push(t('loc_row', { row: l.row }));
  if (l.paragraph !== undefined) parts.push(t('loc_paragraph', { paragraph: l.paragraph }));
  if (l.line !== undefined) parts.push(t('loc_line', { line: l.line }));
  if (l.sectionPath?.length) parts.push(l.sectionPath.join(' › '));
  if (l.manual) parts.push(t(l.manual === 'edit' ? 'loc_manualEdit' : 'loc_manualEntry'));
  if (l.workItem) parts.push(t('loc_workItem', { id: l.workItem, revision: l.revision ?? '?' }));
  return parts.join(' · ');
}

export function RequirementDetailView({
  project,
  permissions,
  reqKey,
}: {
  project: ProjectResponse;
  permissions: string[];
  reqKey: string;
}) {
  const t = useTranslations('requirements');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [req, setReq] = useState<RequirementDetail | null>(null);
  const [trace, setTrace] = useState<RequirementTrace | null>(null);
  const [missing, setMissing] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState(false);
  const P = `/projects/${project.key}/requirements/${encodeURIComponent(reqKey)}`;
  const base = `/${locale}/projects/${project.key}/requirements`;
  const can = (p: string) => permissions.includes(p);

  const load = useCallback(async () => {
    try {
      const [r, tr] = await Promise.all([api<RequirementDetail>(P), api<RequirementTrace>(`${P}/trace`)]);
      setReq(r);
      setTrace(tr);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setMissing(true);
      else setMsg({ tone: 'danger', text: errorText(e) });
    }
  }, [api, P, errorText]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      await load();
      return true;
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
      return false;
    }
  };

  if (missing) return <EmptyState title={t('notFound')} />;
  if (!req)
    return msg ? (
      <Notice tone="danger">{msg.text}</Notice>
    ) : (
      <p className="text-sm text-muted">{t('loading')}</p>
    );
  const latest = req.versions.find((v) => v.number === req.latestVersion)!;
  const post = (path: string, body?: unknown) => () => api(`${P}${path}`, { method: 'POST', body });

  return (
    <div className="flex flex-col gap-4" data-testid="requirement-detail">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={base} className="text-sm text-accent hover:underline">
          {t('backToList')}
        </Link>
        <Ltr>{req.key}</Ltr>
        <h2 className="text-lg font-semibold" data-testid="requirement-title">
          <bdi>{req.title}</bdi>
        </h2>
        <Badge tone={stateTone(req.state)}>
          <span data-testid="requirement-state">{t(`state_${req.state}`)}</span>
        </Badge>
        <span className="text-sm text-muted" data-testid="requirement-versions">
          {t('versionOf', { latest: req.latestVersion, effective: req.effectiveVersion ?? '—' })}
        </span>
        {req.sourceRemoved ? <Badge tone="warning">{t('sourceRemoved')}</Badge> : null}
        {req.divergedFromSource ? <Badge tone="warning">{t('diverged')}</Badge> : null}
      </div>
      {msg ? (
        <Notice tone={msg.tone} testId="requirement-message">
          {msg.text}
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {can('requirement.edit') && !['in_review', 'obsolete'].includes(req.state) ? (
          <Button onClick={() => setEditing((e) => !e)} data-testid="edit">
            {t('edit')}
          </Button>
        ) : null}
        {can('requirement.edit') && req.state === 'draft' ? (
          <Button tone="primary" onClick={() => act(post('/submit'), t('submitted'))} data-testid="submit">
            {t('submit')}
          </Button>
        ) : null}
        {can('requirement.edit') && req.state === 'in_review' ? (
          <Button onClick={() => act(post('/withdraw'), t('withdrawn'))} data-testid="withdraw">
            {t('withdraw')}
          </Button>
        ) : null}
        {can('requirement.approve') && req.state === 'in_review' ? (
          <>
            <Button
              tone="primary"
              onClick={() => act(post('/decision', { decision: 'approve' }), t('approved'))}
              data-testid="approve"
            >
              {t('approve')}
            </Button>
            <Button
              tone="danger"
              onClick={() => act(post('/decision', { decision: 'reject' }), t('rejected'))}
              data-testid="reject"
            >
              {t('reject')}
            </Button>
          </>
        ) : null}
        {can('requirement.approve') && !['obsolete', 'superseded'].includes(req.state) ? (
          <Button
            tone="danger"
            data-testid="obsolete"
            onClick={() => {
              const reason = window.prompt(t('obsoleteReason'));
              if (reason && reason.trim().length >= 3)
                void act(post('/obsolete', { reason: reason.trim() }), t('obsoleted'));
            }}
          >
            {t('markObsolete')}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <EditForm
          path={P}
          version={latest}
          onDone={async (ok) => {
            if (ok) {
              setEditing(false);
              setMsg({ tone: 'success', text: t('saved') });
              await load();
            }
          }}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {req.versions.map((v) => (
            <Card
              key={v.id}
              testId={`version-${v.number}`}
              title={
                <span className="flex items-center gap-2">
                  {t('versionN', { n: v.number })}
                  <Badge tone={stateTone(v.state)}>{t(`state_${v.state}`)}</Badge>
                  {v.origin === 'inferred' || v.origin === 'mixed' ? (
                    <Badge tone="accent">{t(`origin_${v.origin}`)}</Badge>
                  ) : null}
                </span>
              }
            >
              <h3 className="font-medium" dir="auto">
                {v.title}
              </h3>
              {v.bodyMd && v.bodyMd.trim() !== v.title.trim() ? (
                <p className="mt-2 whitespace-pre-wrap text-sm" dir="auto">
                  {v.bodyMd}
                </p>
              ) : null}
              {v.acceptanceCriteria.length ? (
                <>
                  <h4 className="mt-3 text-sm font-medium">{t('acceptanceCriteria')}</h4>
                  <ol className="mt-1 list-decimal ps-5 text-sm">
                    {v.acceptanceCriteria.map((a) => (
                      <li key={a.ordinal} dir="auto">
                        {a.text}{' '}
                        {a.origin === 'inferred' ? <Badge tone="accent">{t('inferred')}</Badge> : null}
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
              <p className="mt-3 text-xs text-muted">{new Date(v.createdAt).toLocaleString(locale)}</p>
            </Card>
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <Card title={t('provenance')} testId="provenance">
            <ul className="flex flex-col gap-2 text-sm">
              {req.provenance
                .filter((p, i, all) => all.findIndex((x) => x.snapshotId === p.snapshotId) === i)
                .map((p) => (
                  <li key={p.itemId} className="flex flex-col">
                    <span className="flex items-center gap-2">
                      <Badge>{t(`kind_${p.sourceKind}`)}</Badge>
                      <bdi>{p.sourceName}</bdi>
                    </span>
                    <span className="text-xs text-muted">{locatorText(t, p.locator)}</span>
                    {p.sourceKind === 'document_set' || p.sourceKind === 'spreadsheet' ? (
                      <Link
                        href={`${base}/review/${p.snapshotId}?item=${p.itemId}`}
                        className="text-xs text-accent hover:underline"
                        data-testid="open-source"
                      >
                        {t('openInSource')}
                      </Link>
                    ) : null}
                    {p.locator.url && /^https:\/\//.test(p.locator.url) ? (
                      <a
                        href={p.locator.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent hover:underline"
                        data-testid="open-tracker"
                      >
                        {t('openInTracker')}
                      </a>
                    ) : null}
                  </li>
                ))}
            </ul>
          </Card>
          {trace ? (
            <TracePanel trace={trace} path={P} base={base} canEdit={can('requirement.edit')} act={act} />
          ) : null}
          <Card title={t('findings')}>
            {req.findings.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {req.findings.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <Badge tone={f.status === 'open' ? 'danger' : 'neutral'}>{t(`finding_${f.type}`)}</Badge>
                    <span className="text-muted">{t(`findingStatus_${f.status}`)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t('noFindings')}</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function EditForm({
  path,
  version,
  onDone,
}: {
  path: string;
  version: RequirementDetail['versions'][number];
  onDone: (ok: boolean) => void;
}) {
  const t = useTranslations('requirements');
  const api = useApi();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const inferred = version.acceptanceCriteria.filter((a) => a.origin === 'inferred').map((a) => a.text);
    try {
      await api(path, {
        method: 'PUT',
        body: {
          title: String(f.get('title') ?? ''),
          bodyMd: String(f.get('body') ?? ''),
          priority: f.get('priority') ? String(f.get('priority')) : null,
          tags: version.tags,
          expectedLatestVersion: version.number,
          acceptanceCriteria: String(f.get('ac') ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((text) => ({ text, origin: inferred.includes(text) ? 'inferred' : 'source' })),
        },
      });
      onDone(true);
    } catch (err) {
      setError(errorText(err));
      onDone(false);
    }
  };
  return (
    <Card title={t('editTitle')} testId="edit-form">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('title')}>
          <Input
            name="title"
            defaultValue={version.title}
            required
            maxLength={300}
            dir="auto"
            data-testid="edit-title"
          />
        </Field>
        <Field label={t('body')} hint={t('bodyHint')}>
          <Textarea name="body" defaultValue={version.bodyMd} rows={6} dir="auto" data-testid="edit-body" />
        </Field>
        <Field label={t('acceptanceCriteria')} hint={t('acHint')}>
          <Textarea
            name="ac"
            rows={4}
            dir="auto"
            defaultValue={version.acceptanceCriteria.map((a) => a.text).join('\n')}
            data-testid="edit-ac"
          />
        </Field>
        <Field label={t('priority')}>
          <Select name="priority" defaultValue={version.priority ?? ''}>
            <option value="">{t('noPriority')}</option>
            {(['critical', 'high', 'medium', 'low'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`priority_${p}`)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-muted">{t('editHint')}</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div>
          <Button type="submit" tone="primary" data-testid="edit-save">
            {t('saveVersion')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TracePanel({
  trace,
  path,
  base,
  canEdit,
  act,
}: {
  trace: RequirementTrace;
  path: string;
  base: string;
  canEdit: boolean;
  act: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;
}) {
  const t = useTranslations('requirements');
  const api = useApi();
  const [type, setType] = useState<'child_of' | 'relates_to'>('relates_to');
  const [target, setTarget] = useState('');
  const refList = (label: string, refs: RequirementRef[], testId: string) =>
    refs.length ? (
      <div data-testid={testId}>
        <h4 className="text-xs font-medium text-muted">{label}</h4>
        <ul className="mt-1 flex flex-col gap-1 text-sm">
          {refs.map((r) => (
            <li key={r.linkId} className="flex items-center justify-between gap-2">
              <Link href={`${base}/${r.key}`} className="text-accent hover:underline">
                <Ltr>{r.key}</Ltr> <bdi>{r.title}</bdi>
              </Link>
              {canEdit ? (
                <Button
                  tone="ghost"
                  onClick={() =>
                    act(() => api(`${path}/links/${r.linkId}`, { method: 'DELETE' }), t('linkRemoved'))
                  }
                  aria-label={t('removeLink')}
                >
                  ×
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {t('trace')}
          <Badge
            tone={
              trace.coverage === 'uncovered' ? 'warning' : trace.coverage === 'failing' ? 'danger' : 'success'
            }
          >
            <span data-testid="coverage">{t(`coverage_${trace.coverage}`)}</span>
          </Badge>
        </span>
      }
      testId="trace"
    >
      <div className="flex flex-col gap-3">
        {refList(t('parents'), trace.parents, 'trace-parents')}
        {refList(t('children'), trace.children, 'trace-children')}
        {refList(t('related'), trace.related, 'trace-related')}
        <div>
          <h4 className="text-xs font-medium text-muted">{t('verifiedBy')}</h4>
          {trace.verifiedBy.length ? (
            <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="trace-tests">
              {trace.verifiedBy.map((v) => (
                <li key={v.linkId} className="flex flex-wrap items-center justify-between gap-2">
                  <Ltr>{v.testCaseId.slice(0, 8)}</Ltr>
                  {v.needsReview ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="warning">{t(`review_${v.reviewReason?.kind ?? 'other'}`)}</Badge>
                      {canEdit ? (
                        <Button
                          tone="ghost"
                          onClick={() =>
                            act(
                              () => api(`${path}/links/${v.linkId}/reviewed`, { method: 'POST' }),
                              t('linkReviewed'),
                            )
                          }
                          data-testid="confirm-link"
                        >
                          {t('confirmLink')}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted">{t('noTests')}</p>
          )}
        </div>
        {canEdit ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await act(
                () =>
                  api(`${path}/links`, {
                    method: 'POST',
                    body: { type, targetKey: target.trim().toUpperCase() },
                  }),
                t('linked'),
              );
              if (ok) setTarget('');
            }}
          >
            <Field label={t('linkType')}>
              <Select
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                data-testid="link-type"
              >
                <option value="relates_to">{t('link_relates_to')}</option>
                <option value="child_of">{t('link_child_of')}</option>
              </Select>
            </Field>
            <Field label={t('linkTarget')}>
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="PRJ-R-1"
                dir="ltr"
                required
                className="w-32"
                data-testid="link-target"
              />
            </Field>
            <Button type="submit" data-testid="add-link">
              {t('addLink')}
            </Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

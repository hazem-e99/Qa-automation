'use client';

import type { ProjectResponse } from '@qos/contracts';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi, useErrorText } from '@/components/session';
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
  Table,
  Td,
  Textarea,
} from '@/components/ui';
import { stateTone, type RequirementDetail, type RequirementSummary } from '@/lib/requirements';

const STATES = ['draft', 'in_review', 'approved', 'superseded', 'obsolete', 'rejected'] as const;

/**
 * Unified requirement list (M04-AC-01): every source in one list, with the source kinds, state
 * and warnings of each requirement. Search is diacritics-insensitive (M04-AC-06).
 */
export function RequirementsList({
  project,
  permissions,
}: {
  project: ProjectResponse;
  permissions: string[];
}) {
  const t = useTranslations('requirements');
  const locale = useLocale();
  const router = useRouter();
  const api = useApi();
  const errorText = useErrorText();
  const [items, setItems] = useState<RequirementSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const P = `/projects/${project.key}`;
  const base = `/${locale}/projects/${project.key}/requirements`;
  const canCreate = permissions.includes('requirement.create');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (state) params.set('state', state);
    try {
      setItems(await api<RequirementSummary[]>(`${P}/requirements?${params.toString()}`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, P, q, state, errorText]);
  useEffect(() => {
    const id = setTimeout(() => void load(), 250);
    return () => clearTimeout(id);
  }, [load]);

  return (
    <div className="flex flex-col gap-4" data-testid="requirements-list">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('search')} className="min-w-64 flex-1">
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchHint')}
            data-testid="requirement-search"
          />
        </Field>
        <Field label={t('state')}>
          <Select value={state} onChange={(e) => setState(e.target.value)} data-testid="state-filter">
            <option value="">{t('allStates')}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {t(`state_${s}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`${base}/sources`}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised"
            data-testid="open-sources"
          >
            {t('sources')}
          </Link>
          <a
            href={`/api/v1${P}/requirements-export?format=xlsx`}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised"
            data-testid="export-xlsx"
          >
            {t('exportXlsx')}
          </a>
          <a
            href={`/api/v1${P}/requirements-export?format=csv`}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised"
            data-testid="export-csv"
          >
            {t('exportCsv')}
          </a>
          {canCreate ? (
            <Button tone="primary" onClick={() => setCreating((c) => !c)} data-testid="new-requirement">
              {t('new')}
            </Button>
          ) : null}
        </div>
      </div>
      {creating ? (
        <NewRequirement
          projectKey={project.key}
          onCancel={() => setCreating(false)}
          onCreated={(key) => router.push(`${base}/${key}`)}
        />
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <p className="text-sm text-muted">{t('loading')}</p>
      ) : items.length === 0 ? (
        <EmptyState title={q || state ? t('noMatch') : t('empty')}>
          {q || state ? null : t('emptyHint')}
        </EmptyState>
      ) : (
        <Card>
          <Table
            head={[t('key'), t('title'), t('state'), t('version'), t('sourcesCol'), t('flags')]}
            testId="requirements-table"
          >
            {items.map((r) => (
              <tr key={r.id} data-requirement={r.key}>
                <Td>
                  <Link href={`${base}/${r.key}`} className="text-accent hover:underline">
                    <Ltr>{r.key}</Ltr>
                  </Link>
                </Td>
                <Td>
                  <bdi>{r.title}</bdi>
                </Td>
                <Td>
                  <Badge tone={stateTone(r.state)}>{t(`state_${r.state}`)}</Badge>
                </Td>
                <Td className="whitespace-nowrap">
                  {t('versionOf', { latest: r.latestVersion, effective: r.effectiveVersion ?? '—' })}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.sourceKinds.map((k) => (
                      <Badge key={k}>{t(`kind_${k}`)}</Badge>
                    ))}
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.sourceRemoved ? <Badge tone="warning">{t('sourceRemoved')}</Badge> : null}
                    {r.divergedFromSource ? <Badge tone="warning">{t('diverged')}</Badge> : null}
                    {r.openFindings ? (
                      <Badge tone="danger">{t('openFindings', { count: r.openFindings })}</Badge>
                    ) : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

/** Manual entry (T-P3-03): a plain Markdown body until the rich editor is decided. */
export function NewRequirement({
  projectKey,
  onCancel,
  onCreated,
}: {
  projectKey: string;
  onCancel: () => void;
  onCreated: (key: string) => void;
}) {
  const t = useTranslations('requirements');
  const api = useApi();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<RequirementDetail>(`/projects/${projectKey}/requirements`, {
        method: 'POST',
        body: {
          title: String(f.get('title') ?? ''),
          bodyMd: String(f.get('body') ?? ''),
          priority: f.get('priority') ? String(f.get('priority')) : null,
          acceptanceCriteria: String(f.get('ac') ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((text) => ({ text, origin: 'source' })),
        },
      });
      onCreated(r.key);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Card title={t('newTitle')} testId="new-requirement-form">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('title')}>
          <Input name="title" required maxLength={300} dir="auto" data-testid="req-title" />
        </Field>
        <Field label={t('body')} hint={t('bodyHint')}>
          <Textarea name="body" rows={5} maxLength={100_000} dir="auto" data-testid="req-body" />
        </Field>
        <Field label={t('acceptanceCriteria')} hint={t('acHint')}>
          <Textarea name="ac" rows={4} dir="auto" data-testid="req-ac" />
        </Field>
        <Field label={t('priority')}>
          <Select name="priority" defaultValue="" data-testid="req-priority">
            <option value="">{t('noPriority')}</option>
            {(['critical', 'high', 'medium', 'low'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`priority_${p}`)}
              </option>
            ))}
          </Select>
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex gap-2">
          <Button type="submit" tone="primary" disabled={busy} data-testid="req-save">
            {t('create')}
          </Button>
          <Button onClick={onCancel}>{t('cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

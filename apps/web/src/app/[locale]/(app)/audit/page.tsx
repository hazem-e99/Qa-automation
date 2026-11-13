'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Button, Card, EmptyState, Field, Input, Ltr, Notice, PageHeader, Table, Td } from '@/components/ui';

type Event = {
  id: string;
  projectId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: Record<string, unknown>;
  source: string;
  correlationId: string | null;
  createdAt: string;
};
type Page = { items: Event[]; nextCursor: string | null };
const FILTERS = ['projectKey', 'action', 'actor', 'targetType', 'target'] as const;

/**
 * Audit explorer (T-P2-56, S-SEC-01). Org administrators search the whole organization; project
 * audit readers search their project (projectKey). Summaries are already redacted server-side.
 */
export default function AuditPage() {
  const t = useTranslations('audit');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const search = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>(() =>
    Object.fromEntries(FILTERS.map((f) => [f, search.get(f) ?? ''])),
  );
  // Inputs change freely; a search runs only for the applied filters.
  const [applied, setApplied] = useState<Record<string, string>>(filters);
  const [items, setItems] = useState<Event[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    (after?: string | null) => {
      const q = new URLSearchParams({ limit: '50' });
      for (const [k, v] of Object.entries(applied)) if (v.trim()) q.set(k, v.trim());
      if (after) q.set('cursor', after);
      return api<Page>(`/audit?${q.toString()}`);
    },
    [api, applied],
  );
  const run = useCallback(async () => {
    setError(null);
    try {
      const page = await query();
      setItems(page.items);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
      setItems([]);
      setCursor(null);
    }
  }, [errorText, query]);
  useEffect(() => void run(), [run]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ ...filters });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card title={t('filters')}>
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-5" data-testid="audit-filters">
          {FILTERS.map((f) => (
            <Field key={f} label={t(`filter_${f}`)}>
              <Input
                value={filters[f]}
                dir="ltr"
                onChange={(e) => setFilters((x) => ({ ...x, [f]: e.target.value }))}
                placeholder={f === 'action' ? 'identity.*' : ''}
              />
            </Field>
          ))}
          <div className="md:col-span-5">
            <Button tone="primary" type="submit" data-testid="audit-search">
              {t('search')}
            </Button>
          </div>
        </form>
      </Card>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Card title={t('events')}>
        {items.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          <>
            <Table head={[t('when'), t('action'), t('actor'), t('target'), t('source')]} testId="audit-table">
              {items.map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer hover:bg-raised"
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                  data-action={e.action}
                >
                  <Td className="whitespace-nowrap text-muted">
                    {new Date(e.createdAt).toLocaleString(locale)}
                  </Td>
                  <Td>
                    <Ltr>{e.action}</Ltr>
                    {open === e.id ? (
                      <pre
                        className="mt-2 max-w-xl overflow-x-auto whitespace-pre-wrap rounded border border-line bg-bg p-2 text-xs"
                        dir="ltr"
                      >
                        {JSON.stringify(
                          { summary: e.summary, correlationId: e.correlationId, projectId: e.projectId },
                          null,
                          2,
                        )}
                      </pre>
                    ) : null}
                  </Td>
                  <Td>
                    <Ltr>{`${e.actorType}:${e.actorId.slice(0, 12)}`}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{`${e.targetType}:${e.targetId.slice(0, 24)}`}</Ltr>
                  </Td>
                  <Td className="text-muted">{e.source}</Td>
                </tr>
              ))}
            </Table>
            {cursor ? (
              <div className="mt-3">
                <Button
                  onClick={async () => {
                    try {
                      const page = await query(cursor);
                      setItems((x) => [...x, ...page.items]);
                      setCursor(page.nextCursor);
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                  data-testid="audit-more"
                >
                  {t('more')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, EmptyState, Ltr, Notice, PageHeader, Textarea } from '@/components/ui';

type Request = {
  id: string;
  projectId: string;
  action: string;
  targetType: string;
  targetId: string;
  contentHash: string;
  requestedBy: string;
  approvalsRequired: number;
  approvals: number;
  expiresAt: string;
  createdAt: string;
};

/** "My approvals" inbox (T-P2-53, M14-FR-05): pending requests the caller may decide. */
export default function ApprovalsPage() {
  const t = useTranslations('approvals');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [rows, setRows] = useState<Request[] | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(
    () =>
      api<Request[]>('/me/approvals')
        .then(setRows)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, errorText],
  );
  useEffect(() => void load(), [load]);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setMsg(null);
    try {
      await api(`/approvals/${id}/${decision}`, { method: 'POST', body: { comment: comments[id] || null } });
      setMsg({ tone: 'success', text: decision === 'approve' ? t('approved') : t('rejected') });
      await load();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {rows === null ? (
        <p className="text-sm text-muted">{t('loading')}</p>
      ) : rows.length === 0 ? (
        <EmptyState title={t('none')}>{t('noneHint')}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="approval-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Card
                title={<Ltr>{r.action}</Ltr>}
                actions={
                  <Badge tone="accent">
                    {t('progress', { done: r.approvals, needed: r.approvalsRequired })}
                  </Badge>
                }
              >
                <dl className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
                  <dt className="text-muted">{t('target')}</dt>
                  <dd>
                    <Ltr>{`${r.targetType} ${r.targetId}`}</Ltr>
                  </dd>
                  <dt className="text-muted">{t('content')}</dt>
                  <dd>
                    <Ltr>{r.contentHash.slice(0, 16)}…</Ltr>
                  </dd>
                  <dt className="text-muted">{t('requested')}</dt>
                  <dd>{new Date(r.createdAt).toLocaleString(locale)}</dd>
                  <dt className="text-muted">{t('expires')}</dt>
                  <dd>{new Date(r.expiresAt).toLocaleString(locale)}</dd>
                </dl>
                <Textarea
                  className="mt-3 w-full"
                  rows={2}
                  placeholder={t('comment')}
                  aria-label={t('comment')}
                  value={comments[r.id] ?? ''}
                  onChange={(e) => setComments((c) => ({ ...c, [r.id]: e.target.value }))}
                />
                <div className="mt-3 flex gap-2">
                  <Button tone="primary" onClick={() => decide(r.id, 'approve')}>
                    {t('approve')}
                  </Button>
                  <Button tone="danger" onClick={() => decide(r.id, 'reject')}>
                    {t('reject')}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

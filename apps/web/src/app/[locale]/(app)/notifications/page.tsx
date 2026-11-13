'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from '@/components/ui';

type Item = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

/** In-app notifications (T-P2-54 UI). Unknown types are shown with their raw type name. */
export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<{ items: Item[] }>('/me/notifications')
        .then((r) => setItems(r.items))
        .catch((e) => setError(errorText(e))),
    [api, errorText],
  );
  useEffect(() => void load(), [load]);

  const text = (n: Item) => {
    const key = `type_${n.type.replace(/\./g, '_')}`;
    const params = Object.fromEntries(Object.entries(n.payload).map(([k, v]) => [k, String(v)]));
    return t.has(key) ? t(key, params) : n.type;
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={t('title')}
        actions={
          items?.some((n) => !n.readAt) ? (
            <Button
              onClick={() =>
                api('/me/notifications/mark-read', { method: 'POST', body: {} })
                  .then(load)
                  .catch((e) => setError(errorText(e)))
              }
            >
              {t('markAll')}
            </Button>
          ) : null
        }
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? null : items.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <Card>
          <ul className="flex flex-col divide-y divide-line" data-testid="notification-list">
            {items.map((n) => (
              <li
                key={n.id}
                className="flex items-start justify-between gap-3 py-3 text-sm"
                data-type={n.type}
              >
                <span>
                  {!n.readAt ? <Badge tone="accent">{t('new')}</Badge> : null} {text(n)}
                </span>
                <span className="whitespace-nowrap text-xs text-muted">
                  {new Date(n.createdAt).toLocaleString(locale)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApi, useErrorText } from './session';
import { Button, Notice } from './ui';

/** "Load demo data" (doc 20 §5): runs the idempotent demo seed, then refreshes the page. */
export function DemoSeedButton() {
  const t = useTranslations('home');
  const api = useApi();
  const errorText = useErrorText();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-accent bg-surface p-4"
      data-testid="demo-offer"
    >
      <p className="flex-1 text-sm">{t('demoOffer')}</p>
      <Button
        tone="primary"
        disabled={busy}
        data-testid="load-demo"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api('/demo/seed', { method: 'POST' });
            router.refresh();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t('loadingDemo') : t('loadDemo')}
      </Button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

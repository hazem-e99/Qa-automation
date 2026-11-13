'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { callApi, useErrorText } from '@/components/session';
import { Button, Field, Input, Notice } from '@/components/ui';

/** Uses an admin-generated reset link; the token is in the URL fragment (never sent to a server). */
export default function ResetPasswordPage() {
  const t = useTranslations('reset');
  const locale = useLocale();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) {
      setError(t('mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callApi('/auth/password/reset', {
        method: 'POST',
        body: { token: window.location.hash.slice(1), password: String(f.get('password') ?? '') },
      });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold" data-testid="page-title">
        {t('title')}
      </h1>
      {done ? (
        <>
          <Notice tone="success" testId="reset-done">
            {t('done')}
          </Notice>
          <Link href={`/${locale}/login`} className="text-sm text-accent underline">
            {t('signIn')}
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t('password')} hint={t('passwordHint')}>
            <Input
              name="password"
              type="password"
              required
              minLength={12}
              dir="ltr"
              autoComplete="new-password"
              data-testid="password"
            />
          </Field>
          <Field label={t('confirm')}>
            <Input
              name="confirm"
              type="password"
              required
              dir="ltr"
              autoComplete="new-password"
              data-testid="confirm"
            />
          </Field>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button tone="primary" type="submit" disabled={busy} data-testid="submit">
            {t('submit')}
          </Button>
        </form>
      )}
    </div>
  );
}

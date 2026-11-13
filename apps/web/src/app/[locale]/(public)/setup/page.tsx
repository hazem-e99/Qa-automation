'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { callApi, useErrorText } from '@/components/session';
import { Button, Field, Input, Notice } from '@/components/ui';

/**
 * First-run setup (S-ONB-01): creates the organization and its first administrator. Needs the
 * setup token from the server's configuration (`SETUP_TOKEN`, created by `qos init`).
 */
export default function SetupPage() {
  const t = useTranslations('setup');
  const locale = useLocale();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '');
    setBusy(true);
    setError(null);
    try {
      await callApi('/setup', {
        method: 'POST',
        headers: { 'x-setup-token': get('setupToken').trim() },
        body: {
          orgName: get('orgName'),
          displayName: get('displayName'),
          email: get('email'),
          password: get('password'),
        },
      });
      await callApi('/auth/login', {
        method: 'POST',
        body: { email: get('email'), password: get('password') },
      });
      window.location.assign(`/${locale}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="setup-form">
      <h1 className="text-xl font-semibold" data-testid="page-title">
        {t('title')}
      </h1>
      <p className="text-sm text-muted">{t('subtitle')}</p>
      <Field label={t('setupToken')} hint={t('setupTokenHint')}>
        <Input
          name="setupToken"
          type="password"
          required
          dir="ltr"
          autoComplete="off"
          data-testid="setup-token"
        />
      </Field>
      <Field label={t('orgName')}>
        <Input name="orgName" required minLength={2} maxLength={100} data-testid="org-name" />
      </Field>
      <Field label={t('displayName')}>
        <Input name="displayName" required maxLength={100} data-testid="display-name" />
      </Field>
      <Field label={t('email')}>
        <Input name="email" type="email" required dir="ltr" autoComplete="username" data-testid="email" />
      </Field>
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
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button tone="primary" type="submit" disabled={busy} data-testid="submit">
        {t('submit')}
      </Button>
    </form>
  );
}

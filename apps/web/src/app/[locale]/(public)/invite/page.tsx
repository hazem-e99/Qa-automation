'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { callApi, useErrorText } from '@/components/session';
import { Button, Field, Input, Notice } from '@/components/ui';

type Lookup = { email: string; orgName: string; displayName: string; expiresAt: string };

/**
 * Invitation acceptance (T-P2-03). The token is in the URL fragment, which the browser never
 * sends to a server; this page reads it and posts it in a request body.
 */
export default function InvitePage() {
  const t = useTranslations('invite');
  const locale = useLocale();
  const errorText = useErrorText();
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const tok = window.location.hash.slice(1);
    setToken(tok);
    if (!tok) {
      setError(t('missing'));
      return;
    }
    callApi<Lookup>('/invitations/lookup', { method: 'POST', body: { token: tok } })
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [errorText, t]);

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
      await callApi('/invitations/accept', {
        method: 'POST',
        body: {
          token,
          displayName: String(f.get('displayName') ?? ''),
          password: String(f.get('password') ?? ''),
        },
      });
      window.location.replace(`/${locale}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="invite-page">
      <h1 className="text-xl font-semibold" data-testid="page-title">
        {t('title')}
      </h1>
      {info ? (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('intro', { org: info.orgName, email: info.email })}</p>
          <Field label={t('displayName')}>
            <Input
              name="displayName"
              defaultValue={info.displayName}
              required
              maxLength={100}
              data-testid="display-name"
            />
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
      ) : error ? (
        <Notice tone="danger" testId="invite-error">
          {error}
        </Notice>
      ) : (
        <p className="text-sm text-muted">{t('checking')}</p>
      )}
    </div>
  );
}

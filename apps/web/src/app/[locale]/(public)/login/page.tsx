'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { callApi, useErrorText } from '@/components/session';
import { Button, Field, Input, Notice } from '@/components/ui';

type LoginReply = { csrfToken: string } | { mfaRequired: true; challengeToken: string };

/** Sign-in (T-P2-01) with the optional TOTP step (T-P2-02). */
export default function LoginPage() {
  const t = useTranslations('login');
  const locale = useLocale();
  const errorText = useErrorText();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = () => {
    const next = new URLSearchParams(window.location.search).get('next');
    // Only same-site paths: never an absolute URL from the query string.
    window.location.assign(
      next && /^\/[a-z]{2}(\/|$)/.test(next) && !next.startsWith('//') ? next : `/${locale}`,
    );
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        await callApi('/auth/mfa/verify', {
          method: 'POST',
          body: { challengeToken: challenge, code: String(form.get('code') ?? '') },
        });
        done();
      } else {
        const reply = await callApi<LoginReply>('/auth/login', {
          method: 'POST',
          body: { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') },
        });
        if ('mfaRequired' in reply) setChallenge(reply.challengeToken);
        else done();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="login-form">
      <h1 className="text-xl font-semibold" data-testid="page-title">
        {challenge ? t('mfaTitle') : t('title')}
      </h1>
      {challenge ? (
        <>
          <p className="text-sm text-muted">{t('mfaHint')}</p>
          <Field label={t('code')}>
            <Input
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              required
              autoFocus
              dir="ltr"
              data-testid="mfa-code"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={t('email')}>
            <Input
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              dir="ltr"
              data-testid="email"
            />
          </Field>
          <Field label={t('password')}>
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              dir="ltr"
              data-testid="password"
            />
          </Field>
        </>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button tone="primary" type="submit" disabled={busy} data-testid="submit">
        {challenge ? t('verify') : t('signIn')}
      </Button>
      {challenge ? (
        <Button tone="ghost" onClick={() => setChallenge(null)}>
          {t('back')}
        </Button>
      ) : (
        <p className="text-xs text-muted">
          {t('firstRun')}{' '}
          <Link href={`/${locale}/setup`} className="text-accent underline">
            {t('setupLink')}
          </Link>
        </p>
      )}
    </form>
  );
}

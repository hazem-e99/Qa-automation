'use client';

import type { MfaStatusResponse, UserResponse } from '@qos/contracts';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, Field, Input, Ltr, Notice, PageHeader, Select } from '@/components/ui';

type Msg = { tone: 'success' | 'danger'; text: string } | null;

/** Own profile, password and MFA (M13-FR-01, T-P2-02). */
export default function ProfilePage() {
  const t = useTranslations('me');
  const api = useApi();
  const errorText = useErrorText();
  const [profile, setProfile] = useState<UserResponse | null>(null);
  const [mfa, setMfa] = useState<MfaStatusResponse | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const say = (k: string, m: Msg) => setMsg((x) => ({ ...x, [k]: m }));

  const load = useCallback(async () => {
    setProfile(await api<UserResponse>('/me/profile'));
    setMfa(await api<MfaStatusResponse>('/me/mfa'));
  }, [api]);
  useEffect(() => void load().catch(() => undefined), [load]);

  const saveProfile = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/me/profile', {
        method: 'PATCH',
        body: {
          displayName: String(f.get('displayName')),
          locale: String(f.get('locale')),
          timezone: String(f.get('timezone')),
        },
      });
      say('profile', { tone: 'success', text: t('saved') });
      await load();
    } catch (err) {
      say('profile', { tone: 'danger', text: errorText(err) });
    }
  };
  const changePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get('newPassword') !== f.get('confirm'))
      return say('password', { tone: 'danger', text: t('mismatch') });
    try {
      await api('/me/password', {
        method: 'POST',
        body: {
          currentPassword: String(f.get('currentPassword')),
          newPassword: String(f.get('newPassword')),
        },
      });
      form.reset();
      say('password', { tone: 'success', text: t('passwordChanged') });
    } catch (err) {
      say('password', { tone: 'danger', text: errorText(err) });
    }
  };

  if (!profile) return <p className="text-sm text-muted">{t('loading')}</p>;
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [profile.timezone];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader title={t('title')} subtitle={<Ltr>{profile.email}</Ltr>} />
      <Card title={t('profile')}>
        <form onSubmit={saveProfile} className="grid gap-3 md:grid-cols-3">
          <Field label={t('displayName')}>
            <Input name="displayName" defaultValue={profile.displayName} required maxLength={100} />
          </Field>
          <Field label={t('language')}>
            <Select name="locale" defaultValue={profile.locale}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </Select>
          </Field>
          <Field label={t('timezone')}>
            <Select name="timezone" defaultValue={profile.timezone}>
              {['UTC', ...zones.filter((z) => z !== 'UTC')].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>
          {msg.profile ? (
            <div className="md:col-span-3">
              <Notice tone={msg.profile.tone}>{msg.profile.text}</Notice>
            </div>
          ) : null}
          <div className="md:col-span-3">
            <Button tone="primary" type="submit">
              {t('save')}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t('password')}>
        <form onSubmit={changePassword} className="grid gap-3 md:grid-cols-3">
          <Field label={t('currentPassword')}>
            <Input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              dir="ltr"
            />
          </Field>
          <Field label={t('newPassword')} hint={t('passwordHint')}>
            <Input
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              dir="ltr"
            />
          </Field>
          <Field label={t('confirm')}>
            <Input name="confirm" type="password" required autoComplete="new-password" dir="ltr" />
          </Field>
          {msg.password ? (
            <div className="md:col-span-3">
              <Notice tone={msg.password.tone}>{msg.password.text}</Notice>
            </div>
          ) : null}
          <p className="text-xs text-muted md:col-span-3">{t('passwordSessions')}</p>
          <div className="md:col-span-3">
            <Button type="submit">{t('changePassword')}</Button>
          </div>
        </form>
      </Card>

      <Card
        title={t('mfa')}
        actions={mfa?.enabled ? <Badge tone="success">{t('mfaOn')}</Badge> : <Badge>{t('mfaOff')}</Badge>}
        testId="mfa-card"
      >
        <div className="flex flex-col gap-3 text-sm">
          {msg.mfa ? <Notice tone={msg.mfa.tone}>{msg.mfa.text}</Notice> : null}
          {codes ? (
            <Notice tone="warning" testId="recovery-codes">
              <p className="font-medium">{t('recoveryTitle')}</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs" dir="ltr">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs">{t('recoveryHint')}</p>
            </Notice>
          ) : null}
          {mfa?.enabled ? (
            <>
              <p className="text-muted">{t('mfaEnabledHint', { left: mfa.recoveryCodesLeft })}</p>
              <form
                className="grid gap-3 md:grid-cols-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  try {
                    await api('/me/mfa/disable', {
                      method: 'POST',
                      body: { password: String(f.get('password')), code: String(f.get('code')) },
                    });
                    setCodes(null);
                    say('mfa', { tone: 'success', text: t('mfaDisabled') });
                    await load();
                  } catch (err) {
                    say('mfa', { tone: 'danger', text: errorText(err) });
                  }
                }}
              >
                <Field label={t('currentPassword')}>
                  <Input name="password" type="password" required dir="ltr" autoComplete="current-password" />
                </Field>
                <Field label={t('code')}>
                  <Input name="code" required dir="ltr" autoComplete="one-time-code" />
                </Field>
                <div className="self-end">
                  <Button tone="danger" type="submit">
                    {t('disableMfa')}
                  </Button>
                </div>
              </form>
            </>
          ) : enroll ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const code = String(new FormData(e.currentTarget).get('code') ?? '');
                try {
                  const res = await api<{ recoveryCodes: string[] }>('/me/mfa/confirm', {
                    method: 'POST',
                    body: { code },
                  });
                  setEnroll(null);
                  setCodes(res.recoveryCodes);
                  say('mfa', { tone: 'success', text: t('mfaEnabled') });
                  await load();
                } catch (err) {
                  say('mfa', { tone: 'danger', text: errorText(err) });
                }
              }}
            >
              <p>{t('enrollStep1')}</p>
              <code
                className="block break-all rounded border border-line bg-bg p-2 text-xs"
                dir="ltr"
                data-testid="mfa-secret"
              >
                {enroll.secret}
              </code>
              <a href={enroll.otpauthUri} className="text-accent underline">
                {t('openApp')}
              </a>
              <Field label={t('enrollStep2')}>
                <Input
                  name="code"
                  required
                  pattern="\d{6}"
                  inputMode="numeric"
                  dir="ltr"
                  autoComplete="one-time-code"
                  data-testid="mfa-confirm-code"
                />
              </Field>
              <div className="flex gap-2">
                <Button tone="primary" type="submit" data-testid="mfa-confirm">
                  {t('confirmMfa')}
                </Button>
                <Button onClick={() => setEnroll(null)}>{t('cancel')}</Button>
              </div>
            </form>
          ) : (
            <>
              <p className="text-muted">{t('mfaHint')}</p>
              <div>
                <Button
                  tone="primary"
                  data-testid="mfa-enroll"
                  onClick={async () => {
                    try {
                      setCodes(null);
                      setEnroll(
                        await api<{ secret: string; otpauthUri: string }>('/me/mfa/enroll', {
                          method: 'POST',
                        }),
                      );
                    } catch (err) {
                      say('mfa', { tone: 'danger', text: errorText(err) });
                    }
                  }}
                >
                  {t('enableMfa')}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

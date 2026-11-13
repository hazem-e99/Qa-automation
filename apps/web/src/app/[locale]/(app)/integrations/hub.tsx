'use client';

import type { ConnectionResponse, ProviderResponse } from '@qos/contracts';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
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
} from '@/components/ui';

export const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  degraded: 'warning',
  auth_failed: 'danger',
  untested: 'neutral',
  retired: 'neutral',
};

/**
 * Integration Hub (T-P2-30, M03): connections with their status, the provider catalog, and a
 * setup form. The credential is write-only: it goes to the secret store and is never shown again.
 */
export function IntegrationHub() {
  const t = useTranslations('hub');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [connections, setConnections] = useState<ConnectionResponse[]>([]);
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [provider, setProvider] = useState<ProviderResponse | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<ConnectionResponse[]>('/connections')
        .then(setConnections)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, errorText],
  );
  useEffect(() => {
    void load();
    api<ProviderResponse[]>('/providers')
      .then(setProviders)
      .catch(() => undefined);
  }, [api, load]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!provider) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMsg(null);
    try {
      const c = await api<ConnectionResponse>('/connections', {
        method: 'POST',
        body: {
          providerType: provider.providerType,
          displayName: String(f.get('displayName') ?? ''),
          authStrategy: String(f.get('authStrategy') ?? provider.authStrategies[0]),
          baseUrl: String(f.get('baseUrl') ?? '') || null,
          credential: String(f.get('credential') ?? '') || null,
        },
      });
      // Test straight away, so the connection shows what it can do.
      await api(`/connections/${c.id}/test`, { method: 'POST' }).catch(() => undefined);
      setProvider(null);
      setMsg({ tone: 'success', text: t('created', { name: c.displayName }) });
      await load();
    } catch (err) {
      setMsg({ tone: 'danger', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const live = connections.filter((c) => c.status !== 'retired');
  const retired = connections.filter((c) => c.status === 'retired');
  return (
    <div className="flex flex-col gap-6">
      {msg ? (
        <Notice tone={msg.tone} testId="hub-message">
          {msg.text}
        </Notice>
      ) : null}
      <Card title={t('connections')} testId="connections">
        {live.length === 0 ? (
          <EmptyState title={t('none')}>{t('noneHint')}</EmptyState>
        ) : (
          <Table
            head={[t('name'), t('provider'), t('status'), t('lastTested'), t('expires')]}
            testId="connections-table"
          >
            {live.map((c) => (
              <tr key={c.id} data-connection={c.displayName}>
                <Td>
                  <Link
                    href={`/${locale}/integrations/${c.id}`}
                    className="font-medium text-accent underline"
                  >
                    {c.displayName}
                  </Link>{' '}
                  {c.isDemo ? <Badge tone="accent">{t('demo')}</Badge> : null}
                </Td>
                <Td>
                  <Ltr>{c.providerType}</Ltr>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[c.status]}>{t(`status_${c.status}`)}</Badge>
                </Td>
                <Td className="text-muted">
                  {c.lastTestedAt ? new Date(c.lastTestedAt).toLocaleString(locale) : t('never')}
                </Td>
                <Td className="text-muted">
                  {c.credentialExpiresAt ? new Date(c.credentialExpiresAt).toLocaleDateString(locale) : '—'}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('catalog')} testId="catalog">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => (
            <li key={p.providerType} className="flex flex-col gap-2 rounded-lg border border-line p-4">
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{p.displayName}</span>
                {p.demoOnly ? <Badge tone="accent">{t('demo')}</Badge> : null}
              </span>
              <span className="text-xs text-muted">
                {t(`family_${p.family}`)} · {t('capabilityCount', { count: p.capabilities.length })}
              </span>
              <Button
                className="mt-auto self-start"
                onClick={() => setProvider(p)}
                data-testid={`connect-${p.providerType}`}
              >
                {t('connect')}
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {provider ? (
        <Card title={t('setupTitle', { provider: provider.displayName })} testId="setup-form">
          <form onSubmit={create} className="grid gap-3 md:grid-cols-2">
            <Field label={t('displayName')}>
              <Input name="displayName" required minLength={2} maxLength={80} data-testid="connection-name" />
            </Field>
            <Field label={t('authStrategy')}>
              <Select name="authStrategy">
                {provider.authStrategies.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('baseUrl')} hint={t('baseUrlHint')}>
              <Input name="baseUrl" dir="ltr" placeholder="https://" />
            </Field>
            <Field label={t('credential')} hint={t('credentialHint')}>
              <Input
                name="credential"
                type="password"
                autoComplete="off"
                dir="ltr"
                data-testid="connection-credential"
              />
            </Field>
            <div className="flex gap-2 md:col-span-2">
              <Button tone="primary" type="submit" disabled={busy} data-testid="create-connection">
                {busy ? t('creating') : t('create')}
              </Button>
              <Button onClick={() => setProvider(null)}>{t('cancel')}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {retired.length ? (
        <Card title={t('retired')}>
          <ul className="flex flex-col gap-1 text-sm text-muted">
            {retired.map((c) => (
              <li key={c.id}>
                <Link href={`/${locale}/integrations/${c.id}`} className="underline">
                  {c.displayName}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

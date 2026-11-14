'use client';

import type { ConnectionResponse } from '@qos/contracts';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useCan, useErrorText } from '@/components/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Ltr,
  Notice,
  PageHeader,
  Table,
  Td,
} from '@/components/ui';
import { STATUS_TONE } from '../hub';

type Capability = { capability: string; ok: boolean; detail: string | null };
type Check = { ok: boolean; result: Record<string, unknown>; createdAt: string };
type Impact = {
  externalRefs: Record<string, number>;
  bindings: { projectKey: string; projectName: string; role: string }[];
};
type Webhook = {
  url?: string;
  path?: string;
  secret?: string;
  verification?: string;
  createdAt?: string;
} & Record<string, unknown>;

/** Connection detail: capabilities, test history, credential rotation, webhook, retire with impact. */
export function ConnectionDetail({ id }: { id: string }) {
  const t = useTranslations('connection');
  const h = useTranslations('hub');
  const locale = useLocale();
  const api = useApi();
  const can = useCan();
  const errorText = useErrorText();
  const [c, setC] = useState<ConnectionResponse | null>(null);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [webhook, setWebhook] = useState<Webhook | null>(null);
  const [revealed, setRevealed] = useState<Webhook | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      setC(await api<ConnectionResponse>(`/connections/${id}`));
    } catch {
      setNotFound(true);
      return;
    }
    api<Capability[]>(`/connections/${id}/capabilities`)
      .then(setCaps)
      .catch(() => undefined);
    api<Check[]>(`/connections/${id}/checks`)
      .then(setChecks)
      .catch(() => undefined);
    api<Webhook>(`/connections/${id}/webhook`)
      .then(setWebhook)
      .catch(() => setWebhook(null));
  }, [api, id]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (notFound) return <EmptyState title={t('notFound')} />;
  if (!c) return <p className="text-sm text-muted">{t('loading')}</p>;
  const retired = c.status === 'retired';

  return (
    <>
      <PageHeader
        title={c.displayName}
        subtitle={
          <Ltr>
            {c.providerType}
            {c.baseUrl ? ` · ${c.baseUrl}` : ''}
          </Ltr>
        }
        actions={
          <>
            <Badge tone={STATUS_TONE[c.status]}>{h(`status_${c.status}`)}</Badge>
            {c.isDemo ? <Badge tone="accent">{h('demo')}</Badge> : null}
            <Link href={`/${locale}/integrations`} className="text-sm text-accent underline">
              {t('back')}
            </Link>
          </>
        }
      />
      {msg ? (
        <Notice tone={msg.tone} testId="connection-message">
          {msg.text}
        </Notice>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t('capabilities')}
          actions={
            !retired ? (
              <Button
                disabled={busy}
                onClick={() => act(() => api(`/connections/${id}/test`, { method: 'POST' }), t('tested'))}
                data-testid="test-connection"
              >
                {t('test')}
              </Button>
            ) : null
          }
          testId="capabilities"
        >
          {caps.length === 0 ? (
            <p className="text-sm text-muted">
              {c.status === 'untested' ? t('untested') : t('noCapabilities')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {caps.map((x) => (
                <li
                  key={x.capability}
                  className="flex items-center justify-between gap-2"
                  data-capability={x.capability}
                  data-ok={x.ok}
                >
                  <Ltr>{x.capability}</Ltr>
                  {x.ok ? (
                    <Badge tone="success">{t('confirmed')}</Badge>
                  ) : (
                    <Badge tone="danger">{x.detail ?? t('missing')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {c.credentialExpiresAt ? (
            <p className="mt-3 text-xs text-warning">
              {t('expiresOn', { date: new Date(c.credentialExpiresAt).toLocaleDateString(locale) })}
            </p>
          ) : null}
        </Card>

        <Card title={t('history')}>
          {checks.length === 0 ? (
            <p className="text-sm text-muted">{t('noChecks')}</p>
          ) : (
            <Table head={[t('when'), t('result')]}>
              {checks.map((x) => (
                <tr key={x.createdAt}>
                  <Td className="text-muted">{new Date(x.createdAt).toLocaleString(locale)}</Td>
                  <Td>
                    {x.ok ? (
                      <Badge tone="success">{t('ok')}</Badge>
                    ) : (
                      <Badge tone="danger">
                        <Ltr>{String(x.result.errorKind ?? 'error')}</Ltr>
                      </Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {!retired && can('connection.secret.rotate') ? (
          <Card title={t('rotate')}>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const credential = String(new FormData(form).get('credential') ?? '');
                void act(async () => {
                  await api(`/connections/${id}/rotate-secret`, { method: 'POST', body: { credential } });
                  await api(`/connections/${id}/test`, { method: 'POST' });
                  form.reset();
                }, t('rotated'));
              }}
            >
              <Field label={t('newCredential')} hint={t('rotateHint')}>
                <Input
                  name="credential"
                  type="password"
                  required
                  autoComplete="new-password"
                  dir="ltr"
                  data-testid="rotate-credential"
                />
              </Field>
              <div>
                <Button type="submit" disabled={busy} data-testid="rotate">
                  {t('rotateButton')}
                </Button>
              </div>
            </form>
          </Card>
        ) : null}

        {!retired ? (
          <Card title={t('webhook')}>
            <div className="flex flex-col gap-3 text-sm">
              {revealed ? (
                <Notice tone="warning" testId="webhook-secret">
                  <p className="font-medium">{t('webhookOnce')}</p>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs" dir="ltr">
                    {JSON.stringify(revealed, null, 2)}
                  </pre>
                </Notice>
              ) : webhook ? (
                <p className="text-muted">
                  {t('webhookExists', {
                    date: webhook.createdAt
                      ? new Date(String(webhook.createdAt)).toLocaleString(locale)
                      : '—',
                  })}
                </p>
              ) : (
                <p className="text-muted">{t('webhookNone')}</p>
              )}
              {can('connection.secret.rotate') ? (
                <div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        setRevealed(await api<Webhook>(`/connections/${id}/webhook`, { method: 'POST' }));
                      }, t('webhookCreated'))
                    }
                  >
                    {webhook ? t('webhookRotate') : t('webhookCreate')}
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        {!retired && can('connection.retire') ? (
          <Card title={t('retire')} testId="retire">
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-muted">{t('retireHint')}</p>
              {impact ? (
                <div data-testid="retire-impact" className="flex flex-col gap-2">
                  {impact.bindings.length ? (
                    <Notice tone="warning">
                      <p>{t('impactBindings')}</p>
                      <ul className="mt-1 list-disc ps-5">
                        {impact.bindings.map((b) => (
                          <li key={`${b.projectKey}:${b.role}`}>
                            <Ltr>{b.projectKey}</Ltr> — {b.projectName} ({b.role})
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  ) : (
                    <p>{t('impactNoBindings')}</p>
                  )}
                  <p>
                    {Object.keys(impact.externalRefs).length
                      ? t('impactRefs', {
                          list: Object.entries(impact.externalRefs)
                            .map(([k, n]) => `${k}: ${n}`)
                            .join(', '),
                        })
                      : t('impactNoRefs')}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      tone="danger"
                      disabled={busy}
                      onClick={() =>
                        act(() => api(`/connections/${id}/retire`, { method: 'POST' }), t('retired'))
                      }
                      data-testid="confirm-retire"
                    >
                      {t('confirmRetire')}
                    </Button>
                    <Button onClick={() => setImpact(null)}>{t('cancel')}</Button>
                  </div>
                </div>
              ) : (
                <div>
                  <Button
                    tone="danger"
                    onClick={() =>
                      api<Impact>(`/connections/${id}/impact`)
                        .then(setImpact)
                        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) }))
                    }
                    data-testid="retire-start"
                  >
                    {t('retireButton')}
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}

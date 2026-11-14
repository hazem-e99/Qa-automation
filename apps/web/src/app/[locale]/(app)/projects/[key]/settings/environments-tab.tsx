'use client';

import type { EnvironmentResponse } from '@qos/contracts';
import { useTranslations } from 'next-intl';
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
  Table,
  Td,
  Textarea,
} from '@/components/ui';
import type { TabProps } from './general-tab';

const list = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Environments (M02-FR-03): URLs, allowed hosts, production flag, write-only test login. */
export function EnvironmentsTab({ project, permissions }: TabProps) {
  const t = useTranslations('environments');
  const api = useApi();
  const errorText = useErrorText();
  const canManage = permissions.includes('project.environments.manage');
  const [rows, setRows] = useState<EnvironmentResponse[]>([]);
  const [editing, setEditing] = useState<EnvironmentResponse | 'new' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const P = `/projects/${project.key}/environments`;

  const load = useCallback(
    () =>
      api<EnvironmentResponse[]>(P)
        .then(setRows)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, P, errorText],
  );
  useEffect(() => void load(), [load]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const secret = String(f.get('authSecret') ?? '');
    const body = {
      name: String(f.get('name') ?? ''),
      baseUrls: list(f.get('baseUrls')),
      allowedHosts: list(f.get('allowedHosts')),
      isProduction: f.get('isProduction') === 'on',
      resetHookUrl: String(f.get('resetHookUrl') ?? '') || null,
      tags: list(f.get('tags')),
      // Write-only: blank keeps the stored value; the checkbox removes it.
      ...(f.get('clearSecret') === 'on' ? { authSecret: null } : secret ? { authSecret: secret } : {}),
    };
    try {
      if (editing === 'new') await api(P, { method: 'POST', body });
      else if (editing) await api(`${P}/${editing.id}`, { method: 'PUT', body });
      setEditing(null);
      setMsg({ tone: 'success', text: t('saved') });
      await load();
    } catch (err) {
      setMsg({ tone: 'danger', text: errorText(err) });
    }
  };

  const current = editing && editing !== 'new' ? editing : null;
  return (
    <div className="flex flex-col gap-4">
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card
        title={t('title')}
        actions={
          canManage && !editing ? (
            <Button tone="primary" onClick={() => setEditing('new')} data-testid="add-environment">
              {t('add')}
            </Button>
          ) : null
        }
      >
        {rows.length === 0 ? (
          <EmptyState title={t('none')}>{t('noneHint')}</EmptyState>
        ) : (
          <Table
            head={[t('name'), t('baseUrls'), t('allowedHosts'), t('login'), '']}
            testId="environments-table"
          >
            {rows.map((env) => (
              <tr key={env.id}>
                <Td>
                  {env.name} {env.isProduction ? <Badge tone="danger">{t('production')}</Badge> : null}
                </Td>
                <Td>
                  {env.baseUrls.map((u) => (
                    <div key={u}>
                      <Ltr>{u}</Ltr>
                    </div>
                  ))}
                </Td>
                <Td>
                  {env.allowedHosts.map((h) => (
                    <div key={h}>
                      <Ltr>{h}</Ltr>
                    </div>
                  ))}
                </Td>
                <Td>
                  {env.hasAuthSecret ? (
                    <Badge tone="success">{t('stored')}</Badge>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td>
                  {canManage ? (
                    <div className="flex gap-2">
                      <Button onClick={() => setEditing(env)}>{t('edit')}</Button>
                      <Button
                        tone="danger"
                        onClick={async () => {
                          if (!window.confirm(t('confirmDelete', { name: env.name }))) return;
                          try {
                            await api(`${P}/${env.id}`, { method: 'DELETE' });
                            await load();
                          } catch (err) {
                            setMsg({ tone: 'danger', text: errorText(err) });
                          }
                        }}
                      >
                        {t('delete')}
                      </Button>
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing ? (
        <Card title={editing === 'new' ? t('add') : t('editTitle', { name: current!.name })}>
          <form onSubmit={submit} className="grid gap-3 md:grid-cols-2" key={current?.id ?? 'new'}>
            <Field label={t('name')}>
              <Input
                name="name"
                defaultValue={current?.name ?? ''}
                required
                maxLength={60}
                data-testid="env-name"
              />
            </Field>
            <Field label={t('tags')} hint={t('listHint')}>
              <Input name="tags" defaultValue={current?.tags.join(', ') ?? ''} />
            </Field>
            <Field label={t('baseUrls')} hint={t('listHint')}>
              <Textarea
                name="baseUrls"
                rows={2}
                dir="ltr"
                defaultValue={current?.baseUrls.join('\n') ?? ''}
                required
                data-testid="env-urls"
              />
            </Field>
            <Field label={t('allowedHosts')} hint={t('allowedHostsHint')}>
              <Textarea
                name="allowedHosts"
                rows={2}
                dir="ltr"
                defaultValue={current?.allowedHosts.join('\n') ?? ''}
              />
            </Field>
            <Field label={t('resetHook')} hint={t('resetHookHint')}>
              <Input name="resetHookUrl" dir="ltr" defaultValue={current?.resetHookUrl ?? ''} />
            </Field>
            <Field
              label={t('authSecret')}
              hint={current?.hasAuthSecret ? t('authSecretKeep') : t('authSecretHint')}
            >
              <Input name="authSecret" type="password" autoComplete="new-password" dir="ltr" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isProduction" defaultChecked={current?.isProduction ?? false} />{' '}
              {t('isProduction')}
            </label>
            {current?.hasAuthSecret ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="clearSecret" /> {t('clearSecret')}
              </label>
            ) : null}
            <div className="flex gap-2 md:col-span-2">
              <Button tone="primary" type="submit" data-testid="save-environment">
                {t('save')}
              </Button>
              <Button onClick={() => setEditing(null)}>{t('cancel')}</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

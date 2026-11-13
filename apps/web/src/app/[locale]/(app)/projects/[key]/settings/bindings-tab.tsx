'use client';

import type { ConnectionResponse } from '@qos/contracts';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { BindingHealthPanel } from '@/components/binding-health';
import { useApi, useErrorText } from '@/components/session';
import { Button, Card, EmptyState, Field, Notice, Select, Table, Td } from '@/components/ui';
import type { TabProps } from './general-tab';

type Binding = {
  id: string;
  role: string;
  connectionId: string;
  startedAt: string;
  endedAt: string | null;
  warnings: string[];
};
type RoleCheck = {
  ok: boolean;
  missingRequired: string[];
  missingAnyOf: string[][];
  missingOptional: string[];
  familyMismatch: boolean;
};
const ROLES = [
  'repository',
  'test_repository',
  'requirements',
  'issue_tracker',
  'ci',
  'ai',
  'orchestrator',
] as const;

/** Bindings (M02-FR-04): health panel, history, and binding with a capability check first. */
export function BindingsTab({ project, permissions }: TabProps) {
  const t = useTranslations('bindings');
  const h = useTranslations('health');
  const api = useApi();
  const errorText = useErrorText();
  const canManage = permissions.includes('project.bindings.manage');
  const [rows, setRows] = useState<Binding[]>([]);
  const [connections, setConnections] = useState<ConnectionResponse[]>([]);
  const [role, setRole] = useState<string>('repository');
  const [connectionId, setConnectionId] = useState('');
  const [check, setCheck] = useState<RoleCheck | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  const P = `/projects/${project.key}/bindings`;

  const load = useCallback(
    () =>
      api<Binding[]>(`${P}?history=true`)
        .then(setRows)
        .catch(() => undefined),
    [api, P],
  );
  useEffect(() => {
    void load();
    if (canManage)
      api<ConnectionResponse[]>('/connections')
        .then(setConnections)
        .catch(() => undefined);
  }, [api, canManage, load]);
  useEffect(() => {
    setCheck(null);
    if (!connectionId) return;
    api<RoleCheck>(`/connections/${connectionId}/role-check?role=${role}`)
      .then(setCheck)
      .catch(() => undefined);
  }, [api, connectionId, role]);

  const name = (id: string) => connections.find((c) => c.id === id)?.displayName ?? id.slice(0, 8);
  const usable = connections.filter((c) => c.status !== 'retired' && (project.isDemo || !c.isDemo));

  const bind = async () => {
    setMsg(null);
    try {
      const b = await api<Binding>(P, { method: 'POST', body: { role, connectionId } });
      setMsg({
        tone: 'success',
        text: b.warnings.length ? t('boundWithWarnings', { list: b.warnings.join(', ') }) : t('bound'),
      });
      setConnectionId('');
      setReload((n) => n + 1);
      await load();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BindingHealthPanel key={reload} projectKey={project.key} />
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {canManage ? (
        <Card title={t('bindTitle')}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('role')}>
              <Select value={role} onChange={(e) => setRole(e.target.value)} data-testid="bind-role">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {h(`role_${r}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('connection')} className="min-w-60 flex-1">
              <Select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                data-testid="bind-connection"
              >
                <option value="">{t('choose')}</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.family}, {c.status})
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              tone="primary"
              disabled={!connectionId || (check !== null && !check.ok)}
              onClick={bind}
              data-testid="bind"
            >
              {t('bind')}
            </Button>
          </div>
          {check ? (
            <div className="mt-3">
              {check.ok ? (
                <Notice tone="success">
                  {t('checkOk')}
                  {check.missingOptional.length
                    ? ` ${t('optional', { list: check.missingOptional.join(', ') })}`
                    : ''}
                </Notice>
              ) : (
                <Notice tone="danger" testId="bind-check-missing">
                  {check.familyMismatch
                    ? t('familyMismatch')
                    : t('missing', {
                        list: [
                          ...check.missingRequired,
                          ...check.missingAnyOf.map((g) => g.join(' | ')),
                        ].join(', '),
                      })}
                </Notice>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}
      <Card title={t('history')}>
        {rows.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          <Table head={[t('role'), t('connection'), t('started'), t('ended'), '']}>
            {rows.map((b) => (
              <tr key={b.id}>
                <Td>{h(`role_${b.role}`)}</Td>
                <Td>{name(b.connectionId)}</Td>
                <Td className="text-muted">{new Date(b.startedAt).toLocaleString()}</Td>
                <Td className="text-muted">
                  {b.endedAt ? new Date(b.endedAt).toLocaleString() : t('active')}
                </Td>
                <Td>
                  {canManage && !b.endedAt ? (
                    <Button
                      tone="danger"
                      onClick={async () => {
                        if (!window.confirm(t('confirmEnd'))) return;
                        try {
                          await api(`${P}/${b.id}`, { method: 'DELETE' });
                          setReload((n) => n + 1);
                          await load();
                        } catch (e) {
                          setMsg({ tone: 'danger', text: errorText(e) });
                        }
                      }}
                    >
                      {t('end')}
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

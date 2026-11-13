'use client';

import type { MemberResponse } from '@qos/contracts';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useErrorText, useSession } from '@/components/session';
import { Button, Card, EmptyState, Field, Notice, Select, Table, Td } from '@/components/ui';
import type { TabProps } from './general-tab';

const ROLES = ['qa_lead', 'qa_engineer', 'qc_reviewer', 'developer', 'project_manager', 'viewer'] as const;
type Candidate = { id: string; displayName: string; email: string };

/** Members (T-P2-42 UI): one role per person; leads assign roles up to their own (BR-M13-3). */
export function MembersTab({ project, permissions }: TabProps) {
  const t = useTranslations('members');
  const r = useTranslations('roles');
  const api = useApi();
  const errorText = useErrorText();
  const session = useSession();
  const canManage = permissions.includes('members.manage');
  const [rows, setRows] = useState<MemberResponse[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [pick, setPick] = useState({ userId: '', role: 'qa_engineer' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const P = `/projects/${project.key}/members`;

  const load = useCallback(
    () =>
      api<MemberResponse[]>(P)
        .then(setRows)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, P, errorText],
  );
  useEffect(() => {
    void load();
    if (canManage)
      api<Candidate[]>(`/projects/${project.key}/member-candidates`)
        .then(setCandidates)
        .catch(() => undefined);
  }, [api, canManage, load, project.key]);

  const setRole = async (userId: string, role: string) => {
    setMsg(null);
    try {
      await api(`${P}/${userId}`, { method: 'PUT', body: { role } });
      setMsg({ tone: 'success', text: t('saved') });
      await load();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };
  const outsiders = candidates.filter((c) => !rows.some((m) => m.userId === c.id));

  return (
    <div className="flex flex-col gap-4">
      {msg ? (
        <Notice tone={msg.tone} testId="members-message">
          {msg.text}
        </Notice>
      ) : null}
      {canManage ? (
        <Card title={t('add')}>
          {outsiders.length === 0 ? (
            <p className="text-sm text-muted">{t('noCandidates')}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t('person')} className="min-w-60 flex-1">
                <Select
                  value={pick.userId}
                  onChange={(e) => setPick((p) => ({ ...p, userId: e.target.value }))}
                  data-testid="member-user"
                >
                  <option value="">{t('choose')}</option>
                  {outsiders.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} — {c.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('role')}>
                <Select
                  value={pick.role}
                  onChange={(e) => setPick((p) => ({ ...p, role: e.target.value }))}
                  data-testid="member-role"
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {r(role)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                tone="primary"
                disabled={!pick.userId}
                onClick={() => setRole(pick.userId, pick.role)}
                data-testid="add-member"
              >
                {t('addButton')}
              </Button>
            </div>
          )}
        </Card>
      ) : null}
      <Card title={t('title')}>
        {rows.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          <Table head={[t('person'), t('role'), '']} testId="members-table">
            {rows.map((m) => (
              <tr key={m.userId} data-member={m.email}>
                <Td>
                  {m.displayName}{' '}
                  <span className="text-muted" dir="ltr">
                    {m.email}
                  </span>
                </Td>
                <Td>
                  {canManage && m.userId !== session?.id ? (
                    <Select
                      value={m.role}
                      onChange={(e) => setRole(m.userId, e.target.value)}
                      aria-label={t('roleFor', { name: m.displayName })}
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {r(role)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    r(m.role)
                  )}
                </Td>
                <Td>
                  {canManage && m.userId !== session?.id ? (
                    <Button
                      tone="danger"
                      onClick={async () => {
                        if (!window.confirm(t('confirmRemove', { name: m.displayName }))) return;
                        try {
                          await api(`${P}/${m.userId}`, { method: 'DELETE' });
                          await load();
                        } catch (e) {
                          setMsg({ tone: 'danger', text: errorText(e) });
                        }
                      }}
                    >
                      {t('remove')}
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

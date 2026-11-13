'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, Field, Input, Notice } from '@/components/ui';
import type { TabProps } from './general-tab';

type Rules = {
  approverRoles: string[];
  approvalsRequired: number;
  allowSelfApproval: boolean;
  expiresInHours: number;
};
type Policy = { action: string; version: number; rules: Rules; isDefault: boolean };
const APPROVER_ROLES = ['qa_lead', 'qa_engineer', 'qc_reviewer', 'developer', 'project_manager'] as const;

/** Approval policies per action (M14-FR-04): who approves, how many, self-approval, expiry. */
export function ApprovalsTab({ project, permissions }: TabProps) {
  const t = useTranslations('policies');
  const r = useTranslations('roles');
  const api = useApi();
  const errorText = useErrorText();
  const canManage = permissions.includes('project.settings.manage');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Rules>>({});
  const [msg, setMsg] = useState<Record<string, { tone: 'success' | 'danger'; text: string }>>({});

  const load = useCallback(
    () =>
      api<Policy[]>(`/projects/${project.key}/approval-policies`).then((p) => {
        setPolicies(p);
        setDrafts(Object.fromEntries(p.map((x) => [x.action, { ...x.rules }])));
      }),
    [api, project.key],
  );
  useEffect(() => void load().catch(() => undefined), [load]);

  const save = async (action: string) => {
    try {
      await api(`/projects/${project.key}/approval-policies/${action}`, {
        method: 'PUT',
        body: drafts[action],
      });
      setMsg((m) => ({ ...m, [action]: { tone: 'success', text: t('saved') } }));
      await load();
    } catch (e) {
      setMsg((m) => ({ ...m, [action]: { tone: 'danger', text: errorText(e) } }));
    }
  };
  const update = (action: string, patch: Partial<Rules>) =>
    setDrafts((d) => ({ ...d, [action]: { ...d[action]!, ...patch } }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {policies.map((p) => {
        const d = drafts[p.action] ?? p.rules;
        return (
          <Card
            key={p.action}
            title={
              <bdi dir="ltr" className="font-mono">
                {p.action}
              </bdi>
            }
            actions={
              p.isDefault ? (
                <Badge>{t('default')}</Badge>
              ) : (
                <Badge tone="accent">{t('version', { version: p.version })}</Badge>
              )
            }
            testId={`policy-${p.action}`}
          >
            <div className="flex flex-col gap-3 text-sm">
              <fieldset className="flex flex-wrap gap-3">
                <legend className="mb-1 font-medium">{t('approvers')}</legend>
                {APPROVER_ROLES.map((role) => (
                  <label key={role} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      disabled={!canManage}
                      checked={d.approverRoles.includes(role)}
                      onChange={(e) =>
                        update(p.action, {
                          approverRoles: e.target.checked
                            ? [...d.approverRoles, role]
                            : d.approverRoles.filter((x) => x !== role),
                        })
                      }
                    />
                    {r(role)}
                  </label>
                ))}
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('required')}>
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    disabled={!canManage}
                    value={d.approvalsRequired}
                    onChange={(e) => update(p.action, { approvalsRequired: e.target.valueAsNumber })}
                  />
                </Field>
                <Field label={t('expires')}>
                  <Input
                    type="number"
                    min={1}
                    disabled={!canManage}
                    value={d.expiresInHours}
                    onChange={(e) => update(p.action, { expiresInHours: e.target.valueAsNumber })}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={d.allowSelfApproval}
                  onChange={(e) => update(p.action, { allowSelfApproval: e.target.checked })}
                />
                {t('selfApproval')}
              </label>
              <p className="text-xs text-muted">{t('selfApprovalHint')}</p>
              {msg[p.action] ? <Notice tone={msg[p.action]!.tone}>{msg[p.action]!.text}</Notice> : null}
              {canManage ? (
                <div>
                  <Button tone="primary" onClick={() => save(p.action)}>
                    {t('save')}
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

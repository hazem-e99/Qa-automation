'use client';

import type { ConnectionResponse, ProjectTemplateResponse, UserResponse } from '@qos/contracts';
import { cn } from '@qos/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { BindingHealthPanel } from '@/components/binding-health';
import { useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui';

type RoleCheck = {
  ok: boolean;
  familyMismatch: boolean;
  missingRequired: string[];
  missingAnyOf: string[][];
  missingOptional: string[];
};
const STEPS = ['basics', 'template', 'repository', 'tracker', 'environment', 'members', 'review'] as const;
type Step = (typeof STEPS)[number];
const PROJECT_ROLES = [
  'qa_lead',
  'qa_engineer',
  'qc_reviewer',
  'developer',
  'project_manager',
  'viewer',
] as const;

/** Key suggestion from the name: upper-case initials or letters, 2–10 characters (BR-M02-1). */
export const suggestKey = (name: string): string => {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '');
  key = key.replace(/^[^A-Z]+/, '').slice(0, 10);
  return key.length >= 2 ? key : (words[0] ?? '').replace(/^[^A-Z]+/, '').slice(0, 10);
};

/**
 * Project creation wizard (T-P2-15, M02-FR-01), P2 subset: basics → template → repository →
 * issue tracker → environment → members → review. Optional steps can be skipped. On "Create",
 * the project is created (with its template), then bindings, environment and members are added
 * one by one; any step that fails is reported, and the project stays usable.
 */
export function ProjectWizard({ demoMode }: { demoMode: boolean }) {
  const t = useTranslations('wizard');
  const r = useTranslations('roles');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [step, setStep] = useState<Step>('basics');
  const [basics, setBasics] = useState({
    name: '',
    key: '',
    keyTouched: false,
    description: '',
    isDemo: demoMode,
  });
  const [templateId, setTemplateId] = useState<string>('');
  const [templates, setTemplates] = useState<ProjectTemplateResponse[]>([]);
  const [connections, setConnections] = useState<ConnectionResponse[]>([]);
  const [users, setUsers] = useState<UserResponse[]>([]);
  const [repo, setRepo] = useState('');
  const [tracker, setTracker] = useState('');
  const [checks, setChecks] = useState<Record<string, RoleCheck>>({});
  const [env, setEnv] = useState({ name: 'staging', baseUrl: '' });
  const [members, setMembers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ key: string; problems: string[] } | null>(null);

  useEffect(() => {
    api<ProjectTemplateResponse[]>('/project-templates')
      .then(setTemplates)
      .catch(() => undefined);
    api<ConnectionResponse[]>('/connections')
      .then(setConnections)
      .catch(() => undefined);
    api<UserResponse[]>('/users')
      .then(setUsers)
      .catch(() => undefined);
  }, [api]);

  // Demo connections may only serve demo projects (doc 11 §8), and retired ones never.
  const usable = useMemo(
    () => connections.filter((c) => c.status !== 'retired' && (basics.isDemo || !c.isDemo)),
    [connections, basics.isDemo],
  );
  const check = async (connectionId: string, role: string) => {
    if (!connectionId) return;
    try {
      const res = await api<RoleCheck>(`/connections/${connectionId}/role-check?role=${role}`);
      setChecks((c) => ({ ...c, [`${connectionId}:${role}`]: res }));
    } catch {
      /* the binding step reports it */
    }
  };

  const keyValid = /^[A-Z][A-Z0-9]{1,9}$/.test(basics.key);
  const canNext = step !== 'basics' || (basics.name.trim().length >= 2 && keyValid);
  const go = (delta: number) =>
    setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, STEPS.indexOf(step) + delta))]!);

  const create = async () => {
    setBusy(true);
    setError(null);
    const problems: string[] = [];
    try {
      await api('/projects', {
        method: 'POST',
        body: {
          key: basics.key,
          name: basics.name.trim(),
          description: basics.description,
          ...(demoMode && basics.isDemo ? { isDemo: true } : {}),
          ...(templateId ? { templateId } : {}),
        },
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      return;
    }
    const P = `/projects/${basics.key}`;
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        problems.push(`${label}: ${errorText(e)}`);
      }
    };
    if (repo)
      await attempt(t('repository'), () =>
        api(`${P}/bindings`, { method: 'POST', body: { role: 'repository', connectionId: repo } }),
      );
    if (tracker)
      await attempt(t('tracker'), () =>
        api(`${P}/bindings`, { method: 'POST', body: { role: 'issue_tracker', connectionId: tracker } }),
      );
    if (env.baseUrl.trim()) {
      await attempt(t('environment'), () =>
        api(`${P}/environments`, {
          method: 'POST',
          body: { name: env.name.trim() || 'staging', baseUrls: [env.baseUrl.trim()] },
        }),
      );
    }
    for (const [userId, role] of Object.entries(members)) {
      if (role)
        await attempt(t('members'), () => api(`${P}/members/${userId}`, { method: 'PUT', body: { role } }));
    }
    setCreated({ key: basics.key, problems });
    setBusy(false);
  };

  if (created) {
    return (
      <div className="flex flex-col gap-4" data-testid="wizard-done">
        <Notice tone="success">{t('created', { key: created.key })}</Notice>
        {created.problems.length ? (
          <Notice tone="warning" testId="wizard-problems">
            <p>{t('partial')}</p>
            <ul className="mt-1 list-disc ps-5">
              {created.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <BindingHealthPanel projectKey={created.key} />
        <div>
          <a
            href={`/${locale}/projects/${created.key}`}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast"
            data-testid="open-project"
          >
            {t('openProject')}
          </a>
        </div>
      </div>
    );
  }

  const connectionPicker = (
    role: 'repository' | 'issue_tracker',
    family: string,
    value: string,
    set: (v: string) => void,
  ) => {
    const options = usable.filter((c) => c.family === family);
    const result = value ? checks[`${value}:${role}`] : undefined;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t(`${role}Hint`)}</p>
        {options.length === 0 ? (
          <Notice>{t('noConnections')}</Notice>
        ) : (
          <Field label={t('connection')}>
            <Select
              value={value}
              data-testid={`pick-${role}`}
              onChange={(e) => {
                set(e.target.value);
                void check(e.target.value, role);
              }}
            >
              <option value="">{t('skip')}</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} ({c.status}){c.isDemo ? ` — ${t('demo')}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {result ? (
          result.ok ? (
            <Notice tone="success" testId="role-check-ok">
              {t('capabilitiesOk')}
              {result.missingOptional.length
                ? ` ${t('optionalMissing', { list: result.missingOptional.join(', ') })}`
                : ''}
            </Notice>
          ) : (
            <Notice tone="danger" testId="role-check-missing">
              {t('capabilitiesMissing', {
                list: [...result.missingRequired, ...result.missingAnyOf.map((g) => g.join(' | '))].join(
                  ', ',
                ),
              })}
            </Notice>
          )
        ) : null}
      </div>
    );
  };

  return (
    <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
      <ol className="flex flex-col gap-1 text-sm" aria-label={t('steps')}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              disabled={i > STEPS.indexOf(step) && !canNext}
              onClick={() => (i <= STEPS.indexOf(step) || canNext ? setStep(s) : undefined)}
              aria-current={s === step ? 'step' : undefined}
              className={cn(
                'w-full rounded-md px-3 py-2 text-start',
                s === step ? 'bg-raised font-medium text-accent' : 'text-muted hover:bg-raised',
              )}
            >
              {i + 1}. {t(s)}
            </button>
          </li>
        ))}
      </ol>
      <Card title={t(step)} testId={`step-${step}`}>
        <div className="flex flex-col gap-4">
          {step === 'basics' ? (
            <>
              <Field label={t('name')}>
                <Input
                  value={basics.name}
                  data-testid="project-name"
                  onChange={(e) => {
                    const name = e.target.value;
                    setBasics((b) => ({ ...b, name, key: b.keyTouched ? b.key : suggestKey(name) }));
                  }}
                />
              </Field>
              <Field
                label={t('key')}
                hint={t('keyHint')}
                error={basics.key && !keyValid ? t('keyInvalid') : null}
              >
                <Input
                  value={basics.key}
                  dir="ltr"
                  maxLength={10}
                  data-testid="project-key"
                  onChange={(e) =>
                    setBasics((b) => ({ ...b, key: e.target.value.toUpperCase(), keyTouched: true }))
                  }
                />
              </Field>
              <Field label={t('description')}>
                <Textarea
                  rows={3}
                  value={basics.description}
                  onChange={(e) => setBasics((b) => ({ ...b, description: e.target.value }))}
                />
              </Field>
              {demoMode ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={basics.isDemo}
                    onChange={(e) => setBasics((b) => ({ ...b, isDemo: e.target.checked }))}
                    data-testid="is-demo"
                  />
                  {t('isDemo')}
                </label>
              ) : null}
            </>
          ) : null}

          {step === 'template' ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm text-muted">{t('templateHint')}</legend>
              {[
                { id: '', name: t('noTemplate'), description: t('noTemplateHint'), builtin: true },
                ...templates,
              ].map((tp) => (
                <label
                  key={tp.id || 'none'}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-md border p-3',
                    templateId === tp.id ? 'border-accent' : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="template"
                    checked={templateId === tp.id}
                    onChange={() => setTemplateId(tp.id)}
                    data-testid={`template-${tp.id || 'none'}`}
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      {tp.name} {tp.id && !tp.builtin ? <Badge>{t('orgTemplate')}</Badge> : null}
                    </span>
                    <span className="block text-xs text-muted">{tp.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {step === 'repository' ? connectionPicker('repository', 'source_control', repo, setRepo) : null}
          {step === 'tracker'
            ? connectionPicker('issue_tracker', 'issue_tracking', tracker, setTracker)
            : null}

          {step === 'environment' ? (
            <>
              <p className="text-sm text-muted">{t('environmentHint')}</p>
              <Field label={t('envName')}>
                <Input value={env.name} onChange={(e) => setEnv((v) => ({ ...v, name: e.target.value }))} />
              </Field>
              <Field label={t('envUrl')} hint={t('envUrlHint')}>
                <Input
                  value={env.baseUrl}
                  dir="ltr"
                  placeholder="https://staging.example.test"
                  data-testid="env-url"
                  onChange={(e) => setEnv((v) => ({ ...v, baseUrl: e.target.value }))}
                />
              </Field>
            </>
          ) : null}

          {step === 'members' ? (
            <>
              <p className="text-sm text-muted">{t('membersHint')}</p>
              {users.filter((u) => u.status === 'active').length <= 1 ? (
                <Notice>{t('noOtherUsers')}</Notice>
              ) : null}
              <ul className="flex flex-col gap-2">
                {users
                  .filter((u) => u.status === 'active')
                  .map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-3 text-sm">
                      <span>
                        {u.displayName}{' '}
                        <span className="text-muted" dir="ltr">
                          {u.email}
                        </span>
                      </span>
                      <Select
                        value={members[u.id] ?? ''}
                        onChange={(e) => setMembers((m) => ({ ...m, [u.id]: e.target.value }))}
                        aria-label={t('roleFor', { name: u.displayName })}
                      >
                        <option value="">{t('notMember')}</option>
                        {PROJECT_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {r(role)}
                          </option>
                        ))}
                      </Select>
                    </li>
                  ))}
              </ul>
              <p className="text-xs text-muted">{t('creatorNote')}</p>
            </>
          ) : null}

          {step === 'review' ? (
            <dl className="grid grid-cols-[10rem_1fr] gap-2 text-sm" data-testid="review">
              <dt className="text-muted">{t('name')}</dt>
              <dd>{basics.name}</dd>
              <dt className="text-muted">{t('key')}</dt>
              <dd dir="ltr">{basics.key}</dd>
              <dt className="text-muted">{t('template')}</dt>
              <dd>{templates.find((x) => x.id === templateId)?.name ?? t('noTemplate')}</dd>
              <dt className="text-muted">{t('repository')}</dt>
              <dd>{usable.find((c) => c.id === repo)?.displayName ?? t('skipped')}</dd>
              <dt className="text-muted">{t('tracker')}</dt>
              <dd>{usable.find((c) => c.id === tracker)?.displayName ?? t('skipped')}</dd>
              <dt className="text-muted">{t('environment')}</dt>
              <dd dir="ltr">{env.baseUrl || t('skipped')}</dd>
              <dt className="text-muted">{t('members')}</dt>
              <dd>{Object.values(members).filter(Boolean).length}</dd>
            </dl>
          ) : null}

          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex justify-between gap-2 border-t border-line pt-4">
            <Button onClick={() => go(-1)} disabled={step === 'basics'}>
              {t('back')}
            </Button>
            {step === 'review' ? (
              <Button
                tone="primary"
                onClick={create}
                disabled={busy || !keyValid}
                data-testid="create-project"
              >
                {busy ? t('creating') : t('create')}
              </Button>
            ) : (
              <Button tone="primary" onClick={() => go(1)} disabled={!canNext} data-testid="next">
                {t('next')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

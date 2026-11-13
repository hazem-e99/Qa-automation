'use client';

import type { ProjectResponse } from '@qos/contracts';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Button, Card, Field, Input, Notice, Textarea } from '@/components/ui';

export type TabProps = { project: ProjectResponse; permissions: string[] };

/** Basics, lifecycle (archive / restore / delete), save as template, clone (M02-FR-02/10). */
export function GeneralTab({ project, permissions }: TabProps) {
  const t = useTranslations('settings');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const router = useRouter();
  const canManage = permissions.includes('project.settings.manage');
  const canCreate = permissions.includes('project.create');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [confirmKey, setConfirmKey] = useState('');

  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      if (after) after();
      else router.refresh();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const tags = String(f.get('tags') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void run(
      () =>
        api(`/projects/${project.key}`, {
          method: 'PATCH',
          body: { name: String(f.get('name')), description: String(f.get('description') ?? ''), tags },
        }),
      t('saved'),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {msg ? (
        <Notice tone={msg.tone} testId="settings-message">
          {msg.text}
        </Notice>
      ) : null}
      <Card title={t('basics')}>
        <form onSubmit={save} className="flex flex-col gap-3">
          <Field label={t('name')}>
            <Input
              name="name"
              defaultValue={project.name}
              required
              minLength={2}
              disabled={!canManage}
              data-testid="edit-name"
            />
          </Field>
          <Field label={t('key')} hint={t('keyImmutable')}>
            <Input value={project.key} disabled dir="ltr" />
          </Field>
          <Field label={t('description')}>
            <Textarea name="description" rows={3} defaultValue={project.description} disabled={!canManage} />
          </Field>
          <Field label={t('tags')} hint={t('tagsHint')}>
            <Input name="tags" defaultValue={project.tags.join(', ')} disabled={!canManage} />
          </Field>
          {canManage ? (
            <div>
              <Button tone="primary" type="submit" data-testid="save-basics">
                {t('save')}
              </Button>
            </div>
          ) : null}
        </form>
      </Card>

      {canManage ? (
        <Card title={t('reuse')}>
          <div className="flex flex-col gap-4">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = String(new FormData(e.currentTarget).get('templateName') ?? '');
                void run(
                  () => api(`/projects/${project.key}/save-as-template`, { method: 'POST', body: { name } }),
                  t('templateSaved'),
                );
              }}
            >
              <Field label={t('templateName')} hint={t('templateHint')} className="flex-1">
                <Input name="templateName" required minLength={2} maxLength={80} />
              </Field>
              <Button type="submit">{t('saveTemplate')}</Button>
            </form>
            {canCreate ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const key = String(f.get('cloneKey') ?? '').toUpperCase();
                  void run(
                    () =>
                      api(`/projects/${project.key}/clone`, {
                        method: 'POST',
                        body: { key, name: String(f.get('cloneName') ?? '') },
                      }),
                    t('cloned'),
                    () => router.push(`/${locale}/projects/${key}`),
                  );
                }}
              >
                <Field label={t('cloneKey')}>
                  <Input
                    name="cloneKey"
                    required
                    pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                    dir="ltr"
                    className="w-32"
                  />
                </Field>
                <Field label={t('cloneName')} className="flex-1">
                  <Input name="cloneName" required minLength={2} />
                </Field>
                <Button type="submit">{t('clone')}</Button>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}

      {canManage ? (
        <Card title={t('lifecycle')}>
          <div className="flex flex-col gap-3 text-sm">
            {project.status === 'archived' ? (
              <>
                <p className="text-muted">{t('archivedHint')}</p>
                <div>
                  <Button
                    onClick={() =>
                      run(() => api(`/projects/${project.key}/restore`, { method: 'POST' }), t('restored'))
                    }
                    data-testid="restore"
                  >
                    {t('restore')}
                  </Button>
                </div>
                <Field label={t('deleteConfirm', { key: project.key })}>
                  <Input
                    value={confirmKey}
                    onChange={(e) => setConfirmKey(e.target.value)}
                    dir="ltr"
                    data-testid="delete-confirm"
                  />
                </Field>
                <div>
                  <Button
                    tone="danger"
                    disabled={confirmKey !== project.key}
                    data-testid="delete"
                    onClick={() =>
                      run(
                        () => api(`/projects/${project.key}`, { method: 'DELETE' }),
                        t('deleted'),
                        () => router.push(`/${locale}`),
                      )
                    }
                  >
                    {t('delete')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-muted">{t('archiveHint')}</p>
                <div>
                  <Button
                    tone="danger"
                    onClick={() =>
                      run(() => api(`/projects/${project.key}/archive`, { method: 'POST' }), t('archived'))
                    }
                    data-testid="archive"
                  >
                    {t('archive')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

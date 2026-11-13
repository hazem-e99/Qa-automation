'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Button, Card, Field, Input, Notice, Select } from '@/components/ui';
import type { TabProps } from './general-tab';

type Section = { section: string; schemaVersion: number; version: number; data: Record<string, unknown> };
const SECTIONS = ['testing_rules', 'execution', 'ai', 'quality'] as const;
/** Closed vocabularies get checkboxes or a select; everything else follows the value's type. */
const MULTI: Record<string, readonly string[]> = {
  browsers: ['chromium', 'firefox', 'webkit'],
  mandatoryFields: ['preconditions', 'expectedResult', 'priority', 'tags'],
};
const SINGLE: Record<string, readonly string[]> = { defaultPriority: ['critical', 'high', 'medium', 'low'] };

/** Typed, versioned settings sections (M02-FR-05..08). Stale edits are refused with a reload hint. */
export function RulesTab({ project, permissions }: TabProps) {
  const t = useTranslations('rules');
  const api = useApi();
  const errorText = useErrorText();
  const canManage = permissions.includes('project.settings.manage');
  const [sections, setSections] = useState<Record<string, Section>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [msg, setMsg] = useState<Record<string, { tone: 'success' | 'danger'; text: string }>>({});

  const load = useCallback(async () => {
    const all = await Promise.all(
      SECTIONS.map((s) => api<Section>(`/projects/${project.key}/settings/${s}`).catch(() => null)),
    );
    const next: Record<string, Section> = {};
    for (const s of all) if (s) next[s.section] = s;
    setSections(next);
    setDrafts(Object.fromEntries(Object.values(next).map((s) => [s.section, { ...s.data }])));
  }, [api, project.key]);
  useEffect(() => void load(), [load]);

  const label = (field: string) => (t.has(`field_${field}`) ? t(`field_${field}`) : field);
  const set = (section: string, field: string, value: unknown) =>
    setDrafts((d) => ({ ...d, [section]: { ...d[section], [field]: value } }));

  const save = async (section: string) => {
    try {
      const res = await api<Section>(`/projects/${project.key}/settings/${section}`, {
        method: 'PUT',
        body: { expectedVersion: sections[section]!.version, data: drafts[section] },
      });
      setSections((s) => ({ ...s, [section]: res }));
      setMsg((m) => ({ ...m, [section]: { tone: 'success', text: t('saved', { version: res.version }) } }));
    } catch (e) {
      setMsg((m) => ({ ...m, [section]: { tone: 'danger', text: errorText(e) } }));
    }
  };

  const control = (section: string, field: string, value: unknown) => {
    const disabled = !canManage;
    if (MULTI[field]) {
      const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="sr-only">{label(field)}</legend>
          {MULTI[field].map((opt) => (
            <label key={opt} className="flex items-center gap-1">
              <input
                type="checkbox"
                disabled={disabled}
                checked={chosen.has(opt)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(opt);
                  else next.delete(opt);
                  set(
                    section,
                    field,
                    MULTI[field]!.filter((o) => next.has(o)),
                  );
                }}
              />
              {t.has(`opt_${opt}`) ? t(`opt_${opt}`) : opt}
            </label>
          ))}
        </fieldset>
      );
    }
    if (SINGLE[field]) {
      return (
        <Select
          value={String(value)}
          disabled={disabled}
          onChange={(e) => set(section, field, e.target.value)}
        >
          {SINGLE[field].map((o) => (
            <option key={o} value={o}>
              {t.has(`opt_${o}`) ? t(`opt_${o}`) : o}
            </option>
          ))}
        </Select>
      );
    }
    if (typeof value === 'boolean') {
      return (
        <input
          type="checkbox"
          className="self-start"
          disabled={disabled}
          checked={value}
          onChange={(e) => set(section, field, e.target.checked)}
          data-testid={`${section}-${field}`}
        />
      );
    }
    if (typeof value === 'number') {
      return (
        <Input
          type="number"
          value={value}
          disabled={disabled}
          onChange={(e) => set(section, field, e.target.valueAsNumber)}
          data-testid={`${section}-${field}`}
        />
      );
    }
    if (Array.isArray(value)) {
      return (
        <Input
          value={(value as string[]).join(', ')}
          disabled={disabled}
          onChange={(e) =>
            set(
              section,
              field,
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );
    }
    return (
      <Input
        value={String(value ?? '')}
        disabled={disabled}
        dir="ltr"
        onChange={(e) => set(section, field, e.target.value)}
      />
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {SECTIONS.filter((s) => sections[s]).map((s) => (
        <Card
          key={s}
          title={t(`section_${s}`)}
          testId={`section-${s}`}
          actions={
            <span className="text-xs text-muted">{t('version', { version: sections[s]!.version })}</span>
          }
        >
          <div className="flex flex-col gap-3">
            {Object.entries(drafts[s] ?? {}).map(([field, value]) => (
              <Field key={field} label={label(field)} group={Boolean(MULTI[field])}>
                {control(s, field, value)}
              </Field>
            ))}
            {msg[s] ? <Notice tone={msg[s].tone}>{msg[s].text}</Notice> : null}
            {canManage ? (
              <div className="flex gap-2">
                <Button tone="primary" onClick={() => save(s)} data-testid={`save-${s}`}>
                  {t('save')}
                </Button>
                <Button onClick={() => void load()}>{t('reload')}</Button>
              </div>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}

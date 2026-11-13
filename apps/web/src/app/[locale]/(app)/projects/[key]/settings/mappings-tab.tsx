'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, EmptyState, Input, Ltr, Notice, Select } from '@/components/ui';
import type { TabProps } from './general-tab';

type Entry = { external: string; canonical: string };
type Issue = { severity: 'error' | 'warning'; code: string; value: string };
type Mapping = {
  kind: string;
  entries: Entry[];
  canonical: string[];
  discovered: string[] | null;
  discoveredAt: string | null;
  version: number;
  lint: { ok: boolean; issues: Issue[] };
};
type State = { bindingId: string; defectSync: boolean; mappings: Mapping[] };

/**
 * Mapping editor (T-P2-32, S-INT-05): external ↔ canonical values of the issue-tracker binding,
 * with the validation lint. Defect sync can be switched on only with a clean status mapping.
 */
export function MappingsTab({ project, permissions }: TabProps) {
  const t = useTranslations('mappings');
  const api = useApi();
  const errorText = useErrorText();
  const canEdit = permissions.includes('project.settings.manage');
  const [state, setState] = useState<State | null>(null);
  const [noTracker, setNoTracker] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Entry[]>>({});
  const [lints, setLints] = useState<Record<string, Mapping['lint']>>({});
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const P = `/projects/${project.key}`;

  const load = useCallback(async () => {
    try {
      const s = await api<State>(`${P}/mappings`);
      setState(s);
      setDrafts(Object.fromEntries(s.mappings.map((m) => [m.kind, m.entries.map((e) => ({ ...e }))])));
      setLints(Object.fromEntries(s.mappings.map((m) => [m.kind, m.lint])));
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'mapping.no_tracker') setNoTracker(true);
      else setMsg({ tone: 'danger', text: errorText(e) });
    }
  }, [api, P, errorText]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };
  const edit = (kind: string, next: Entry[]) => {
    setDrafts((d) => ({ ...d, [kind]: next }));
    // Live lint against the last discovery, without saving.
    void api<Mapping['lint']>(`${P}/mappings/${kind}/validate`, { method: 'POST', body: { entries: next } })
      .then((l) => setLints((x) => ({ ...x, [kind]: l })))
      .catch(() => undefined);
  };

  if (noTracker) return <EmptyState title={t('noTracker')}>{t('noTrackerHint')}</EmptyState>;
  if (!state)
    return msg ? (
      <Notice tone="danger">{msg.text}</Notice>
    ) : (
      <p className="text-sm text-muted">{t('loading')}</p>
    );
  const issueText = (i: Issue) => t(`lint_${i.code}`, { value: i.value });

  return (
    <div className="flex flex-col gap-4" data-testid="mapping-editor">
      {msg ? (
        <Notice tone={msg.tone} testId="mapping-message">
          {msg.text}
        </Notice>
      ) : null}
      <Card
        title={t('title')}
        actions={
          canEdit ? (
            <Button
              onClick={() => act(() => api(`${P}/mappings/discover`, { method: 'POST' }), t('discovered'))}
              data-testid="discover"
            >
              {t('discover')}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted">{t('intro')}</p>
          <div className="flex items-center gap-2">
            <span>{t('defectSync')}</span>
            {state.defectSync ? <Badge tone="success">{t('on')}</Badge> : <Badge>{t('off')}</Badge>}
            {canEdit ? (
              <Button
                tone={state.defectSync ? 'danger' : 'primary'}
                data-testid="toggle-defect-sync"
                onClick={() =>
                  act(
                    () => api(`${P}/defect-sync`, { method: 'POST', body: { enabled: !state.defectSync } }),
                    state.defectSync ? t('syncOff') : t('syncOn'),
                  )
                }
              >
                {state.defectSync ? t('pause') : t('activate')}
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {state.mappings.map((m) => {
          const entries = drafts[m.kind] ?? [];
          const lint = lints[m.kind] ?? m.lint;
          const unmapped = (m.discovered ?? []).filter((v) => !entries.some((e) => e.external === v));
          return (
            <Card
              key={m.kind}
              title={t(`kind_${m.kind}`)}
              testId={`mapping-${m.kind}`}
              actions={
                <>
                  {lint.ok ? (
                    <Badge tone="success">{t('valid')}</Badge>
                  ) : (
                    <Badge tone="danger">{t('invalid')}</Badge>
                  )}
                  <span className="text-xs text-muted">{t('version', { version: m.version })}</span>
                </>
              }
            >
              <div className="flex flex-col gap-3 text-sm">
                <p className="text-xs text-muted">
                  {m.discoveredAt
                    ? t('discoveredAt', { date: new Date(m.discoveredAt).toLocaleString() })
                    : t('neverDiscovered')}
                </p>
                <table className="w-full">
                  <thead>
                    <tr className="text-muted">
                      <th scope="col" className="pb-1 text-start font-normal">
                        {t('external')}
                      </th>
                      <th scope="col" className="pb-1 text-start font-normal">
                        {t('canonical')}
                      </th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr key={i} data-external={e.external}>
                        <td className="pe-2 pb-1">
                          <Input
                            value={e.external}
                            dir="ltr"
                            disabled={!canEdit}
                            aria-label={t('external')}
                            onChange={(ev) =>
                              edit(
                                m.kind,
                                entries.map((x, j) => (j === i ? { ...x, external: ev.target.value } : x)),
                              )
                            }
                          />
                        </td>
                        <td className="pe-2 pb-1">
                          <Select
                            value={e.canonical}
                            disabled={!canEdit}
                            aria-label={t('canonical')}
                            onChange={(ev) =>
                              edit(
                                m.kind,
                                entries.map((x, j) => (j === i ? { ...x, canonical: ev.target.value } : x)),
                              )
                            }
                          >
                            {!m.canonical.includes(e.canonical) ? (
                              <option value={e.canonical}>{e.canonical}</option>
                            ) : null}
                            {m.canonical.map((c) => (
                              <option key={c} value={c}>
                                {t.has(`canon_${c}`) ? t(`canon_${c}`) : c}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="pb-1">
                          {canEdit ? (
                            <Button
                              tone="ghost"
                              aria-label={t('remove')}
                              onClick={() =>
                                edit(
                                  m.kind,
                                  entries.filter((_, j) => j !== i),
                                )
                              }
                            >
                              ✕
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEdit && unmapped.length ? (
                  <div className="flex flex-wrap items-center gap-2" data-testid={`unmapped-${m.kind}`}>
                    <span className="text-xs text-muted">{t('unmappedValues')}</span>
                    {unmapped.map((v) => (
                      <Button
                        key={v}
                        onClick={() =>
                          edit(m.kind, [...entries, { external: v, canonical: m.canonical[0] ?? '' }])
                        }
                      >
                        + <Ltr>{v}</Ltr>
                      </Button>
                    ))}
                  </div>
                ) : null}
                {lint.issues.length ? (
                  <ul className="flex flex-col gap-1" data-testid={`lint-${m.kind}`}>
                    {lint.issues.map((i, n) => (
                      <li
                        key={n}
                        className={i.severity === 'error' ? 'text-danger' : 'text-warning'}
                        data-code={i.code}
                      >
                        {issueText(i)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {canEdit ? (
                  <div className="flex gap-2">
                    <Button
                      tone="primary"
                      onClick={() =>
                        act(
                          () =>
                            api(`${P}/mappings/${m.kind}`, {
                              method: 'PUT',
                              body: { expectedVersion: m.version, entries },
                            }),
                          t('saved'),
                        )
                      }
                      data-testid={`save-${m.kind}`}
                    >
                      {t('save')}
                    </Button>
                    <Button
                      onClick={() =>
                        edit(m.kind, [...entries, { external: '', canonical: m.canonical[0] ?? '' }])
                      }
                    >
                      {t('addRow')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

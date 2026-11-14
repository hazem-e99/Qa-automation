'use client';

import type { ProjectResponse } from '@qos/contracts';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi, useErrorText } from '@/components/session';
import { Badge, Button, Card, EmptyState, Field, Input, Ltr, Notice, Select } from '@/components/ui';
import type { DocumentView, SourceView } from '@/lib/requirements';

type Msg = { tone: 'success' | 'danger' | 'warning'; text: string } | null;
const UPLOADABLE = ['document_set', 'spreadsheet'];
const ACCEPT: Record<string, string> = {
  document_set: '.pdf,.docx,.xlsx,.csv',
  spreadsheet: '.xlsx,.csv',
};

const statusTone = (s: string) =>
  s === 'parsed'
    ? 'success'
    : s === 'failed' || s === 'rejected'
      ? 'danger'
      : s === 'pending'
        ? 'accent'
        : 'neutral';

/**
 * Sources of a project and, for document and spreadsheet sources, their uploads: each document
 * is a series of versions with its parse status and extraction quality. Refreshes while a parse
 * is pending.
 */
export function SourcesView({ project, permissions }: { project: ProjectResponse; permissions: string[] }) {
  const t = useTranslations('requirements');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [docs, setDocs] = useState<Record<string, DocumentView[]>>({});
  const [msg, setMsg] = useState<Msg>(null);
  const P = `/projects/${project.key}`;
  const base = `/${locale}/projects/${project.key}/requirements`;
  const canManage = permissions.includes('requirement_source.manage');
  const canUpload = permissions.includes('document.upload');

  const load = useCallback(async () => {
    try {
      const list = await api<SourceView[]>(`${P}/requirement-sources`);
      setSources(list);
      const entries = await Promise.all(
        list
          .filter((s) => UPLOADABLE.includes(s.kind))
          .map(
            async (s) =>
              [s.id, await api<DocumentView[]>(`${P}/requirement-sources/${s.id}/documents`)] as const,
          ),
      );
      setDocs(Object.fromEntries(entries));
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  }, [api, P, errorText]);
  useEffect(() => void load(), [load]);

  const pending = Object.values(docs).some((ds) =>
    ds.some((d) => d.versions.some((v) => v.parseStatus === 'pending')),
  );
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, [pending, load]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setMsg(null);
    try {
      await api(`${P}/requirement-sources`, {
        method: 'POST',
        body: { kind: String(f.get('kind')), name: String(f.get('name') ?? '').trim() },
      });
      form.reset();
      setMsg({ tone: 'success', text: t('sourceCreated') });
      await load();
    } catch (err) {
      setMsg({ tone: 'danger', text: errorText(err) });
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="sources-view">
      <div className="flex items-center gap-3">
        <Link href={base} className="text-sm text-accent hover:underline">
          {t('backToList')}
        </Link>
        <h2 className="text-lg font-semibold">{t('sources')}</h2>
      </div>
      {msg ? (
        <Notice tone={msg.tone} testId="sources-message">
          {msg.text}
        </Notice>
      ) : null}
      {canManage ? (
        <Card title={t('newSource')}>
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field label={t('sourceKind')}>
              <Select name="kind" defaultValue="document_set" data-testid="source-kind">
                <option value="document_set">{t('kind_document_set')}</option>
                <option value="spreadsheet">{t('kind_spreadsheet')}</option>
              </Select>
            </Field>
            <Field label={t('sourceName')}>
              <Input name="name" required maxLength={120} dir="auto" data-testid="source-name" />
            </Field>
            <Button type="submit" tone="primary" data-testid="create-source">
              {t('createSource')}
            </Button>
          </form>
        </Card>
      ) : null}
      {sources === null ? (
        <p className="text-sm text-muted">{t('loading')}</p>
      ) : sources.length === 0 ? (
        <EmptyState title={t('noSources')}>{t('noSourcesHint')}</EmptyState>
      ) : (
        sources.map((s) => (
          <Card
            key={s.id}
            testId={`source-${s.name}`}
            title={
              <span className="flex items-center gap-2">
                <bdi>{s.name}</bdi>
                <Badge>{t(`kind_${s.kind}`)}</Badge>
                {!s.enabled ? <Badge tone="warning">{t('disabled')}</Badge> : null}
              </span>
            }
            actions={
              UPLOADABLE.includes(s.kind) && canUpload && s.enabled ? (
                <UploadButton
                  accept={ACCEPT[s.kind]!}
                  onFile={async (file) => {
                    setMsg(null);
                    try {
                      const r = await api<{ duplicate: boolean }>(
                        `${P}/requirement-sources/${s.id}/documents?fileName=${encodeURIComponent(file.name)}`,
                        { method: 'POST', raw: file },
                      );
                      setMsg(
                        r.duplicate
                          ? { tone: 'warning', text: t('uploadDuplicate', { name: file.name }) }
                          : { tone: 'success', text: t('uploaded', { name: file.name }) },
                      );
                      await load();
                    } catch (err) {
                      setMsg({ tone: 'danger', text: errorText(err) });
                    }
                  }}
                />
              ) : null
            }
          >
            {UPLOADABLE.includes(s.kind) ? (
              (docs[s.id] ?? []).length ? (
                <ul className="flex flex-col gap-3">
                  {(docs[s.id] ?? []).map((d) => (
                    <li key={d.id} data-document={d.title}>
                      <p className="font-medium" dir="auto">
                        {d.title}
                      </p>
                      <ul className="mt-1 flex flex-col gap-1 text-sm">
                        {[...d.versions].reverse().map((v) => (
                          <li
                            key={v.id}
                            className="flex flex-wrap items-center gap-2"
                            data-version={v.version}
                          >
                            <span>{t('versionN', { n: v.version })}</span>
                            <Ltr>{v.fileName ?? ''}</Ltr>
                            <Badge tone={statusTone(v.parseStatus)}>
                              <span data-testid="parse-status">{t(`parse_${v.parseStatus}`)}</span>
                            </Badge>
                            {v.parseStatus === 'failed' && v.extractionQuality?.error ? (
                              <span className="text-xs text-danger">
                                {t('parseError', { code: String(v.extractionQuality.error) })}
                              </span>
                            ) : null}
                            {v.parseStatus === 'parsed' ? (
                              <>
                                <span className="text-xs text-muted">
                                  {t('counts', {
                                    open: v.counts.candidate,
                                    accepted: v.counts.accepted,
                                    rejected: v.counts.rejected,
                                  })}
                                </span>
                                <Link
                                  href={`${base}/review/${v.id}`}
                                  className="text-accent hover:underline"
                                  data-testid="review-link"
                                >
                                  {t('review')}
                                </Link>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{t('noDocuments')}</p>
              )
            ) : (
              <p className="text-sm text-muted">{t(`sourceHint_${s.kind}`)}</p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

function UploadButton({ accept, onFile }: { accept: string; onFile: (f: File) => Promise<void> }) {
  const t = useTranslations('requirements');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        data-testid="upload-input"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          await onFile(file);
          setBusy(false);
        }}
      />
      <Button tone="primary" disabled={busy} onClick={() => input.current?.click()} data-testid="upload">
        {busy ? t('uploading') : t('upload')}
      </Button>
    </>
  );
}

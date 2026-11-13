'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useCan, useErrorText } from './session';
import { Badge, Button, Card, EmptyState, Notice, Table, Td } from './ui';

export type BindingHealth = {
  bindingId: string;
  role: string;
  connectionId: string;
  connectionName: string;
  connectionStatus: string;
  lastTestedAt: string | null;
  ok: boolean;
  missingRequired: string[];
  missingOptional: string[];
  familyMismatch: boolean;
};

/**
 * Integration health panel (M02-FR-09, T-P2-17): every binding with its connection's last test.
 * "Re-test" runs the connection test (org admins) and refreshes the panel.
 */
export function BindingHealthPanel({ projectKey }: { projectKey: string }) {
  const t = useTranslations('health');
  const api = useApi();
  const can = useCan();
  const errorText = useErrorText();
  const [rows, setRows] = useState<BindingHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<BindingHealth[]>(`/projects/${projectKey}/bindings/health`)
        .then((r) => {
          setRows(r);
          setError(null);
        })
        .catch((e) => setError(errorText(e))),
    [api, errorText, projectKey],
  );
  useEffect(() => void load(), [load]);

  const retest = async (connectionId: string) => {
    setBusy(connectionId);
    try {
      await api(`/connections/${connectionId}/test`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('title')} testId="binding-health">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {rows === null ? (
        <p className="text-sm text-muted">{t('loading')}</p>
      ) : rows.length === 0 ? (
        <EmptyState title={t('none')}>{t('noneHint')}</EmptyState>
      ) : (
        <Table head={[t('role'), t('connection'), t('status'), t('lastTested'), '']}>
          {rows.map((h) => (
            <tr key={h.bindingId} data-role={h.role} data-ok={h.ok}>
              <Td>{t(`role_${h.role}`)}</Td>
              <Td>{h.connectionName}</Td>
              <Td>
                {h.ok ? (
                  <Badge tone="success">{t('healthy')}</Badge>
                ) : (
                  <Badge tone="danger">{t('unhealthy')}</Badge>
                )}
                {!h.ok && h.missingRequired.length ? (
                  <span className="mt-1 block text-xs text-danger" dir="ltr">
                    {h.missingRequired.join(', ')}
                  </span>
                ) : null}
                {h.ok && h.missingOptional.length ? (
                  <span className="mt-1 block text-xs text-muted">
                    {t('optionalMissing', { count: h.missingOptional.length })}
                  </span>
                ) : null}
              </Td>
              <Td className="text-muted">
                {h.lastTestedAt ? new Date(h.lastTestedAt).toLocaleString() : t('never')}
              </Td>
              <Td>
                {can('connection.manage') ? (
                  <Button
                    onClick={() => retest(h.connectionId)}
                    disabled={busy !== null}
                    data-testid={`retest-${h.role}`}
                  >
                    {busy === h.connectionId ? t('testing') : t('retest')}
                  </Button>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

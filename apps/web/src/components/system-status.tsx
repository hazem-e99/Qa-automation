import { HealthResponse } from '@qos/contracts';
import { getTranslations } from 'next-intl/server';

/** Backend processes the status table reports on. URLs are server-side settings, never sent to the browser. */
const SERVICES = [
  { name: 'api', url: process.env.QOS_API_URL ?? 'http://127.0.0.1:3001' },
  { name: 'worker', url: process.env.QOS_WORKER_URL ?? 'http://127.0.0.1:3002' },
  { name: 'execution-controller', url: process.env.QOS_CONTROLLER_URL ?? 'http://127.0.0.1:3003' },
] as const;

type Row = { name: string; state: 'ok' | 'fail' | 'unreachable'; version: string | null; checks: string[] };

async function probe(service: (typeof SERVICES)[number]): Promise<Row> {
  try {
    const res = await fetch(`${service.url}/readyz`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    const parsed = HealthResponse.safeParse(await res.json());
    if (!parsed.success) return { name: service.name, state: 'unreachable', version: null, checks: [] };
    const checks = Object.entries(parsed.data.checks)
      .filter(([, c]) => c.status !== 'ok')
      .map(([n]) => n);
    return { name: service.name, state: parsed.data.status, version: parsed.data.version, checks };
  } catch {
    return { name: service.name, state: 'unreachable', version: null, checks: [] };
  }
}

const TONE = { ok: 'text-success', fail: 'text-danger', unreachable: 'text-warning' } as const;

/** System health (T-P2-55): readiness of every backend process, from their public health endpoints. */
export async function SystemStatus() {
  const t = await getTranslations('overview');
  const rows = await Promise.all(SERVICES.map(probe));
  return (
    <section aria-labelledby="status-heading" className="rounded-lg border border-line bg-surface">
      <h2 id="status-heading" className="border-b border-line px-4 py-3 text-sm font-medium">
        {t('systemStatus')}
      </h2>
      <table className="w-full text-sm" data-testid="status-table">
        <thead>
          <tr className="text-muted">
            <th scope="col" className="px-4 py-2 text-start font-normal">
              {t('service')}
            </th>
            <th scope="col" className="px-4 py-2 text-start font-normal">
              {t('status')}
            </th>
            <th scope="col" className="px-4 py-2 text-start font-normal">
              {t('version')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              className="border-t border-line"
              data-service={row.name}
              data-state={row.state}
            >
              <th scope="row" className="px-4 py-2 text-start font-medium" dir="ltr">
                {row.name}
              </th>
              <td className={`px-4 py-2 ${TONE[row.state]}`}>
                {t(row.state)}
                {row.checks.length ? (
                  <span className="ms-2 text-xs text-muted" dir="ltr">
                    ({row.checks.join(', ')})
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-2 text-muted" dir="ltr">
                {row.version ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

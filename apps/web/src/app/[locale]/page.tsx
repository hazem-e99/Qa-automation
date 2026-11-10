import { HealthResponse } from '@qos/contracts';
import { getTranslations, setRequestLocale } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/** Backend processes the overview reports on. URLs are server-side settings, never sent to the browser. */
const SERVICES = [
  { name: 'api', url: process.env.QOS_API_URL ?? 'http://127.0.0.1:3001' },
  { name: 'worker', url: process.env.QOS_WORKER_URL ?? 'http://127.0.0.1:3002' },
  { name: 'execution-controller', url: process.env.QOS_CONTROLLER_URL ?? 'http://127.0.0.1:3003' },
] as const;

type Row = { name: string; state: 'ok' | 'fail' | 'unreachable'; version: string | null };

async function probe(service: (typeof SERVICES)[number]): Promise<Row> {
  try {
    const res = await fetch(`${service.url}/readyz`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    const parsed = HealthResponse.safeParse(await res.json());
    if (!parsed.success) return { name: service.name, state: 'unreachable', version: null };
    return { name: service.name, state: parsed.data.status, version: parsed.data.version };
  } catch {
    return { name: service.name, state: 'unreachable', version: null };
  }
}

const TONE = { ok: 'text-success', fail: 'text-danger', unreachable: 'text-warning' } as const;

export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('overview');
  const rows = await Promise.all(SERVICES.map(probe));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="page-title">
          {t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>
      </div>
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
                <td className={`px-4 py-2 ${TONE[row.state]}`}>{t(row.state)}</td>
                <td className="px-4 py-2 text-muted" dir="ltr">
                  {row.version ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';

const ITEMS = [
  { key: 'overview', ready: true },
  { key: 'requirements', ready: false },
  { key: 'tests', ready: false },
  { key: 'runs', ready: false },
  { key: 'defects', ready: false },
  { key: 'automation', ready: false },
  { key: 'integrations', ready: false },
  { key: 'settings', ready: false },
] as const;

/** Primary navigation. Entries for modules that are not built yet are shown disabled, not hidden. */
export async function Sidebar() {
  const t = await getTranslations('nav');
  const appName = (await getTranslations('app'))('name');
  const locale = await getLocale();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-e border-line bg-surface" data-testid="sidebar">
      <div className="flex h-13 items-center border-b border-line px-4 text-base font-semibold">
        {appName}
      </div>
      <nav aria-label={t('label')} className="flex-1 overflow-auto p-2">
        <ul className="flex flex-col gap-1">
          {ITEMS.map((item) => (
            <li key={item.key}>
              {item.ready ? (
                <Link
                  href={`/${locale}`}
                  aria-current="page"
                  className="block rounded-md bg-raised px-3 py-2 text-sm font-medium text-accent"
                >
                  {t(item.key)}
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  title={t('comingSoon')}
                  className="block cursor-not-allowed rounded-md px-3 py-2 text-sm text-muted"
                >
                  {t(item.key)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

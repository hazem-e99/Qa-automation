'use client';

import { cn } from '@qos/ui';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { SETTINGS_TABS } from '@/lib/settings-tabs';

export function ProjectTabs({ projectKey, canSettings }: { projectKey: string; canSettings: boolean }) {
  const t = useTranslations('project');
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams();
  const base = `/${locale}/projects/${projectKey}`;
  const onSettings = pathname.startsWith(`${base}/settings`);
  const tab = search.get('tab') ?? 'general';
  const link = (href: string, label: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'border-b-2 px-3 py-2 text-sm',
        active ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-fg',
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="flex flex-col gap-2">
      <nav aria-label={t('sections')} className="flex gap-1 border-b border-line">
        {link(base, t('overview'), !onSettings)}
        {canSettings ? link(`${base}/settings`, t('settings'), onSettings) : null}
      </nav>
      {onSettings ? (
        <nav aria-label={t('settingsSections')} className="flex flex-wrap gap-1" data-testid="settings-tabs">
          {SETTINGS_TABS.map((s) => (
            <Link
              key={s}
              href={`${base}/settings?tab=${s}`}
              aria-current={tab === s ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1 text-sm',
                tab === s ? 'bg-raised font-medium text-accent' : 'text-muted hover:bg-raised',
              )}
              data-testid={`tab-${s}`}
            >
              {t(`tab_${s}`)}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

'use client';

import { cn } from '@qos/ui';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from './session';

/**
 * Primary navigation. Entries for modules that are not built yet are shown disabled, not hidden;
 * administration entries appear only for users holding the permission behind them.
 */
const ITEMS = [
  { key: 'overview', href: '' },
  { key: 'requirements', href: null },
  { key: 'tests', href: null },
  { key: 'runs', href: null },
  { key: 'defects', href: null },
  { key: 'automation', href: null },
  { key: 'approvals', href: '/approvals', needs: 'signed_in' },
  { key: 'integrations', href: '/integrations', needs: 'connection.manage' },
  { key: 'users', href: '/admin/users', needs: 'user.manage' },
  { key: 'audit', href: '/audit', needs: 'org_admin' },
  { key: 'system', href: '/system' },
] as const;

export function Sidebar() {
  const t = useTranslations('nav');
  const app = useTranslations('app');
  const locale = useLocale();
  const pathname = usePathname();
  const session = useSession();
  const visible = ITEMS.filter((item) => {
    if (!('needs' in item)) return true;
    if (!session) return false;
    if (item.needs === 'signed_in') return true;
    if (item.needs === 'org_admin')
      return session.orgRoles.some((r) => r === 'org_admin' || r === 'platform_admin');
    return session.permissions.includes(item.needs);
  });
  const active = (href: string) => {
    const full = `/${locale}${href}`;
    return href === ''
      ? pathname === full || pathname.startsWith(`${full}/projects`)
      : pathname.startsWith(full);
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-e border-line bg-surface" data-testid="sidebar">
      <div className="flex h-13 items-center border-b border-line px-4 text-base font-semibold">
        {app('name')}
      </div>
      <nav aria-label={t('label')} className="flex-1 overflow-auto p-2">
        <ul className="flex flex-col gap-1">
          {visible.map((item) => (
            <li key={item.key}>
              {item.href !== null ? (
                <Link
                  href={`/${locale}${item.href}`}
                  aria-current={active(item.href) ? 'page' : undefined}
                  className={cn(
                    'block rounded-md px-3 py-2 text-sm',
                    active(item.href) ? 'bg-raised font-medium text-accent' : 'text-fg hover:bg-raised',
                  )}
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

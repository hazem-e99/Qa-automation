'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi, useSession } from './session';

/** Notifications count, profile link and sign-out. Renders nothing when nobody is signed in. */
export function UserMenu() {
  const t = useTranslations('topbar');
  const locale = useLocale();
  const session = useSession();
  const api = useApi();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const load = () =>
      api<{ unread: number }>('/me/notifications?unread=true')
        .then((r) => alive && setUnread(r.unread))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, session]);

  if (!session) return null;
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign(`/${locale}/login`);
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <Link
        href={`/${locale}/notifications`}
        className="rounded-md px-2 py-1 text-muted hover:bg-raised"
        aria-label={t('notificationsCount', { count: unread })}
        data-testid="notifications-link"
      >
        {t('notifications')}
        {unread > 0 ? (
          <span className="ms-1 rounded-full bg-accent px-1.5 text-xs text-accent-contrast">{unread}</span>
        ) : null}
      </Link>
      <Link
        href={`/${locale}/me`}
        className="max-w-40 truncate rounded-md px-2 py-1 hover:bg-raised"
        data-testid="user-menu"
      >
        {session.displayName}
      </Link>
      <button
        type="button"
        onClick={signOut}
        className="rounded-md px-2 py-1 text-muted hover:bg-raised"
        data-testid="sign-out"
      >
        {t('signOut')}
      </button>
    </div>
  );
}

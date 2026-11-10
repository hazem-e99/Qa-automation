'use client';

import { LOCALES, THEMES, type Theme } from '@qos/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

const THEME_LABEL = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' } as const;
const LOCALE_NAME: Record<string, string> = { en: 'English', ar: 'العربية' };

export function Topbar({ locale, theme: initialTheme }: { locale: string; theme: Theme }) {
  const t = useTranslations('topbar');
  const p = useTranslations('palette');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const dialog = useRef<HTMLDialogElement>(null);

  const applyTheme = useCallback((next: Theme) => {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    // A preference, not a credential: readable by the server so the first paint has the right theme.
    document.cookie = `qos-theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const openPalette = useCallback(() => dialog.current?.showModal(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);

  return (
    <header
      className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-surface px-4"
      data-testid="topbar"
    >
      <button
        type="button"
        onClick={openPalette}
        className="flex min-w-0 flex-1 items-center justify-between rounded-md border border-line bg-bg px-3 py-1.5 text-start text-sm text-muted"
      >
        <span className="truncate">{t('search')}</span>
        <kbd className="ms-3 rounded border border-line px-1.5 text-xs" dir="ltr">
          Ctrl K
        </kbd>
      </button>

      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted">{t('theme')}</span>
        <select
          value={theme}
          onChange={(e) => applyTheme(e.target.value as Theme)}
          className="rounded-md border border-line bg-surface px-2 py-1"
          data-testid="theme-select"
        >
          {THEMES.map((v) => (
            <option key={v} value={v}>
              {t(THEME_LABEL[v])}
            </option>
          ))}
        </select>
      </label>

      <nav aria-label={t('language')} className="flex items-center gap-1 text-sm">
        {LOCALES.map((l) => (
          <Link
            key={l}
            href={`/${l}`}
            lang={l}
            hrefLang={l}
            aria-current={l === locale ? 'true' : undefined}
            className={
              l === locale
                ? 'rounded-md bg-raised px-2 py-1 font-medium text-accent'
                : 'rounded-md px-2 py-1 text-muted'
            }
          >
            {LOCALE_NAME[l]}
          </Link>
        ))}
      </nav>

      <dialog
        ref={dialog}
        aria-label={p('title')}
        className="m-auto w-full max-w-xl rounded-lg border border-line bg-surface p-0 text-fg"
        data-testid="command-palette"
      >
        <form method="dialog" className="flex flex-col">
          <input
            autoFocus
            type="search"
            placeholder={p('placeholder')}
            aria-label={p('title')}
            className="border-b border-line bg-transparent px-4 py-3 text-sm outline-none"
          />
          <p className="px-4 py-6 text-sm text-muted">{p('empty')}</p>
          <div className="flex justify-end border-t border-line px-4 py-2">
            <button type="submit" className="rounded-md border border-line px-3 py-1 text-sm">
              {p('close')}
            </button>
          </div>
        </form>
      </dialog>
    </header>
  );
}

/** Joins class names, skipping empty values. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const isTheme = (v: unknown): v is Theme =>
  typeof v === 'string' && (THEMES as readonly string[]).includes(v);

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const RTL_LOCALES: readonly Locale[] = ['ar'];
export const directionOf = (locale: string): 'ltr' | 'rtl' =>
  (RTL_LOCALES as readonly string[]).includes(locale) ? 'rtl' : 'ltr';

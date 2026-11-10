import { LOCALES } from '@qos/ui';
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: 'en',
  localePrefix: 'always',
});

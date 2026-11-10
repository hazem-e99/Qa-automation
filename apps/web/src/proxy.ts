import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Locale negotiation and redirects ("/" → "/en"). Runs for pages only, never for assets.
export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};

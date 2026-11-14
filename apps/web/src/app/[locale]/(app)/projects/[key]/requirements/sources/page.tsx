import { setRequestLocale } from 'next-intl/server';
import { projectContext } from '@/lib/project-context';
import { SourcesView } from './sources-view';

export const dynamic = 'force-dynamic';

/** Requirement sources and document uploads (T-P3-02/04, S-REQ-04). */
export default async function SourcesPage({ params }: { params: Promise<{ locale: string; key: string }> }) {
  const { locale, key } = await params;
  setRequestLocale(locale);
  return <SourcesView {...await projectContext(key)} />;
}

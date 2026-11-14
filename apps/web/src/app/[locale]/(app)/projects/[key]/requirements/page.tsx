import { setRequestLocale } from 'next-intl/server';
import { projectContext } from '@/lib/project-context';
import { RequirementsList } from './requirements-list';

export const dynamic = 'force-dynamic';

/** Requirements list (T-P3-15, S-REQ-01). */
export default async function RequirementsPage({
  params,
}: {
  params: Promise<{ locale: string; key: string }>;
}) {
  const { locale, key } = await params;
  setRequestLocale(locale);
  return <RequirementsList {...await projectContext(key)} />;
}

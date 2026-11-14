import { setRequestLocale } from 'next-intl/server';
import { projectContext } from '@/lib/project-context';
import { RequirementDetailView } from './requirement-detail';

export const dynamic = 'force-dynamic';

/** Requirement detail (T-P3-15, S-REQ-02): versions, provenance, findings, workflow and trace (T-P3-12). */
export default async function RequirementPage({
  params,
}: {
  params: Promise<{ locale: string; key: string; reqKey: string }>;
}) {
  const { locale, key, reqKey } = await params;
  setRequestLocale(locale);
  return <RequirementDetailView {...await projectContext(key)} reqKey={decodeURIComponent(reqKey)} />;
}

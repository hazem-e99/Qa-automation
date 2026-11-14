import { setRequestLocale } from 'next-intl/server';
import { projectContext } from '@/lib/project-context';
import { ReviewWorkspace } from './review-workspace';

export const dynamic = 'force-dynamic';

/** Extraction review workspace (T-P3-08, S-REQ-03) with the source viewer (T-P3-14). */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; key: string; snapshotId: string }>;
  searchParams: Promise<{ item?: string }>;
}) {
  const { locale, key, snapshotId } = await params;
  const { item } = await searchParams;
  setRequestLocale(locale);
  return <ReviewWorkspace {...await projectContext(key)} snapshotId={snapshotId} focusItem={item ?? null} />;
}

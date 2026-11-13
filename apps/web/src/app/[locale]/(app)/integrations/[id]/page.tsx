import { setRequestLocale } from 'next-intl/server';
import { ConnectionDetail } from './detail';

export const dynamic = 'force-dynamic';

export default async function ConnectionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <ConnectionDetail id={id} />
    </div>
  );
}

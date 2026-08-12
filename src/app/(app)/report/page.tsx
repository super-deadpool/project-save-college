import Link from 'next/link';
import { requireRole } from '@/lib/auth/session';
import { listLocations } from '@/lib/locations';
import { ReportChat } from './report-chat';

export default async function ReportPage() {
  await requireRole('STUDENT');
  const locations = await listLocations();

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Report an issue</h1>
        <Link href="/report/form" className="text-sm text-muted underline">
          Use the plain form
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted">
        Just describe what&apos;s wrong. We&apos;ll ask only what we still need.
      </p>
      <ReportChat locations={locations.map((l) => ({ id: l.id, name: l.name, depth: l.depth }))} />
    </div>
  );
}

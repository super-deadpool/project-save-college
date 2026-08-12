import { requireRole } from '@/lib/auth/session';
import { CATEGORY_SCHEMAS } from '@/lib/engine/schemas';
import { listLocations } from '@/lib/locations';
import { StaticReportForm } from './static-report-form';

/**
 * Layer 1: the deliberately unintelligent path — a category picker plus a form
 * generated from the category's REQUIRED slots. It stays available as the
 * "plain form" fallback behind the Layer 2 conversation.
 */
export default async function StaticReportPage() {
  await requireRole('STUDENT');
  const locations = await listLocations();

  return (
    <div>
      <h1 className="text-xl font-semibold">Report an issue</h1>
      <p className="mt-1 text-sm text-muted">Plain form. Pick a category and fill in the essentials.</p>
      <StaticReportForm
        categories={CATEGORY_SCHEMAS.map((c) => ({
          key: c.key,
          label: c.label,
          description: c.description,
          slots: c.slots,
        }))}
        locations={locations}
      />
    </div>
  );
}

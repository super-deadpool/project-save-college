'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * §30's scan, on demand. The worker runs it nightly; this is the button for a
 * walkthrough, and it writes the same `RecurringSignal` rows — so a preventive
 * suggestion is a record somebody can come back to rather than a sentence that
 * disappears on the next page load.
 */
export function ScanRecurring() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="text-right">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          const res = await fetch('/api/analytics/recurring/scan', { method: 'POST' });
          const data = (await res.json().catch(() => ({}))) as {
            detected?: number;
            written?: number;
            refreshed?: number;
            error?: string;
          };
          setBusy(false);
          if (!res.ok) {
            setResult(data.error ?? 'The scan failed');
            return;
          }
          setResult(
            `${data.detected ?? 0} detected · ${data.written ?? 0} new · ${data.refreshed ?? 0} refreshed`,
          );
          router.refresh();
        }}
        className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-60"
      >
        {busy ? 'Scanning…' : 'Scan and record'}
      </button>
      {result && <p className="mt-1 text-xs text-muted">{result}</p>}
    </div>
  );
}

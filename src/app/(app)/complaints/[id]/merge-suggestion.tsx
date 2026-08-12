'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The staff half of the 0.45–0.70 dedup band. The system says what it noticed
 * and why; a person decides. Confirming runs exactly the same link the automatic
 * path runs — the only difference is that the timeline records who decided.
 */
export function MergeSuggestion({
  complaintId,
  incidentId,
  incidentCode,
  score,
  explain,
}: {
  complaintId: string;
  incidentId: string;
  incidentCode: string;
  score: number | null;
  explain: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  async function merge() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/incidents/${incidentId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complaintId }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? 'Could not merge');
      return;
    }
    router.refresh();
  }

  return (
    <section className="rounded-lg border border-yellow-300 bg-yellow-50 p-5">
      <h2 className="text-sm font-medium text-yellow-900">Possible duplicate</h2>
      <p className="mt-1 text-sm text-yellow-900">
        This looks like it may be part of{' '}
        <a href={`/incidents/${incidentId}`} className="underline">
          {incidentCode}
        </a>
        {score != null && <span className="font-mono text-xs"> · confidence {score.toFixed(2)}</span>}
      </p>
      {explain && <p className="mt-1 text-xs text-yellow-800">{explain}</p>}
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          disabled={busy}
          onClick={merge}
          className="rounded-md bg-yellow-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Merging…' : `Merge into ${incidentCode}`}
        </button>
        <button
          disabled={busy}
          onClick={() => setDismissed(true)}
          className="rounded-md border border-yellow-400 px-3 py-1.5 text-sm text-yellow-900"
        >
          Not a duplicate
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}

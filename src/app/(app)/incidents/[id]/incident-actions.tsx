'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ComplaintStatus } from '@/generated/prisma/enums';

/**
 * §17's one-action-many-complaints control. The server works out which moves are
 * legal for at least one member and passes them down; the API applies each
 * member through `transition()` and reports the ones that could not move rather
 * than forcing them.
 */
export function IncidentActions({
  incidentId,
  memberCount,
  actions,
}: {
  incidentId: string;
  memberCount: number;
  actions: { status: ComplaintStatus; label: string; requiresNote: boolean }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<{ status: ComplaintStatus; label: string } | null>(null);
  const [note, setNote] = useState('');

  async function apply(status: ComplaintStatus, withNote?: string) {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await fetch(`/api/incidents/${incidentId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, note: withNote }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      applied?: unknown[];
      skipped?: unknown[];
    };
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? 'That did not work');
      return;
    }
    const applied = data.applied?.length ?? 0;
    const skipped = data.skipped?.length ?? 0;
    setResult(
      `${applied} complaint${applied === 1 ? '' : 's'} updated${skipped ? `, ${skipped} left alone` : ''}`,
    );
    setNoteFor(null);
    router.refresh();
  }

  if (actions.length === 0) return null;

  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">Act on all {memberCount} complaints</h2>
      <p className="mt-1 text-sm text-muted">
        One fix, one action — every student who reported this is told.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action.status}
            disabled={busy}
            onClick={() => {
              if (action.requiresNote) {
                setNoteFor(action);
                setNote('');
                return;
              }
              apply(action.status);
            }}
            className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {action.label}
          </button>
        ))}
      </div>

      {noteFor && (
        <div className="mt-3 rounded-md border border-line p-3">
          <label className="text-sm font-medium" htmlFor="incident-note">
            Why? Every affected student will read this.
          </label>
          <textarea
            id="incident-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-2 w-full rounded-md border border-line bg-background p-2 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              disabled={busy || !note.trim()}
              onClick={() => apply(noteFor.status, note)}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-60"
            >
              {noteFor.label}
            </button>
            <button
              disabled={busy}
              onClick={() => setNoteFor(null)}
              className="rounded-md border border-line px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && <p className="mt-3 text-sm text-muted">{result}</p>}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}

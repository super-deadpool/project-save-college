'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_RATING, RATING_LABEL } from '@/lib/feedback/satisfaction';

/**
 * §23 and §24, the two questions only the student can answer: was it actually
 * fixed, and how well was it handled.
 *
 * They are deliberately one component in one place on the page. A complaint that
 * has been marked resolved presents exactly one thing to do next, and splitting
 * "confirm" from "rate" across the screen is how a student ends up closing a
 * complaint without ever being asked the question the campus wants answered.
 */

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, error: (data as { error?: string }).error ?? null };
}

export function ResolutionConfirm({ complaintId }: { complaintId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  async function send(body: unknown) {
    setBusy(true);
    setError(null);
    const result = await post(`/api/complaints/${complaintId}/confirm`, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That did not work');
      return;
    }
    router.refresh();
  }

  return (
    <section className="rounded-lg border border-green-300 bg-green-50 p-5">
      <h2 className="text-sm font-semibold text-green-900">
        Your complaint has been marked as resolved. Was the issue actually fixed?
      </h2>

      {!rejecting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            disabled={busy}
            onClick={() => send({ confirmed: true })}
            className="rounded-md bg-green-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Yes, resolved
          </button>
          <button
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="rounded-md border border-green-300 bg-white px-3 py-1.5 text-sm disabled:opacity-60"
          >
            No, still having the problem
          </button>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-green-300 bg-white p-3">
          <label className="text-sm font-medium" htmlFor="reopen-reason">
            What is still wrong? The department will read this.
          </label>
          <textarea
            id="reopen-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="The light works again but it started flickering the same evening."
            className="mt-2 w-full rounded-md border border-line bg-background p-2 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              disabled={busy || !reason.trim()}
              onClick={() => send({ confirmed: false, reason })}
              className="rounded-md bg-orange-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              Reopen the complaint
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setRejecting(false);
                setReason('');
              }}
              className="rounded-md border border-line px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-green-900">
        Nothing closes on its own — it stays open until you say it is fixed.
      </p>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}

/** §24's stars. Asked after the fix is confirmed, never as a condition of it. */
export function RatingForm({ complaintId }: { complaintId: string }) {
  const router = useRouter();
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">How satisfied are you with the resolution?</h2>

      <div className="mt-3 flex items-center gap-1">
        {Array.from({ length: MAX_RATING }, (_, i) => i + 1).map((star) => (
          <button
            key={star}
            type="button"
            aria-label={`${star} of ${MAX_RATING} — ${RATING_LABEL[star]}`}
            aria-pressed={rating != null && star <= rating}
            onClick={() => setRating(star)}
            className={`text-2xl leading-none transition-opacity ${
              rating != null && star <= rating ? 'opacity-100' : 'opacity-30 hover:opacity-60'
            }`}
          >
            ★
          </button>
        ))}
        {rating != null && <span className="ml-2 text-sm text-muted">{RATING_LABEL[rating]}</span>}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        aria-label="Anything you want to add"
        placeholder="Anything you want to add (optional)"
        className="mt-3 w-full rounded-md border border-line bg-background p-2 text-sm"
      />

      <button
        disabled={busy || rating == null}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await post(`/api/complaints/${complaintId}/feedback`, {
            rating,
            comment: comment.trim() || undefined,
          });
          setBusy(false);
          if (!result.ok) {
            setError(result.error ?? 'Could not save your rating');
            return;
          }
          router.refresh();
        }}
        className="mt-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Send rating'}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}

/** What was said, once it has been said — the same block for the student and for staff. */
export function FeedbackGiven({
  rating,
  comment,
  resolutionConfirmed,
}: {
  rating: number;
  comment: string | null;
  resolutionConfirmed: boolean;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">Student rating</h2>
      <p className="mt-2 text-sm">
        <span className="text-lg">{'★'.repeat(rating)}</span>
        <span className="text-lg opacity-25">{'★'.repeat(MAX_RATING - rating)}</span>
        <span className="ml-2 text-muted">
          {rating}/{MAX_RATING} · {RATING_LABEL[rating]}
        </span>
      </p>
      {comment && <p className="mt-2 text-sm">{comment}</p>}
      <p className="mt-2 text-xs text-muted">
        {resolutionConfirmed
          ? 'The student confirmed the issue was fixed.'
          : 'Rated without confirming the fix.'}
      </p>
    </section>
  );
}

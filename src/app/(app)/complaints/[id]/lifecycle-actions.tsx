'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ComplaintStatus } from '@/generated/prisma/enums';

/**
 * §21's staff controls: accept, update status, add a progress update, request
 * more information. The buttons are not hardcoded — the server asks
 * `nextStatuses()` what this person may do from here and passes the answer down,
 * so a move that the transition table forbids has no button to press.
 */
export interface StatusAction {
  status: ComplaintStatus;
  label: string;
  requiresNote: boolean;
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, error: (data as { error?: string }).error ?? null };
}

export function StaffActions({
  complaintId,
  canAccept,
  canRequestInfo,
  actions,
}: {
  complaintId: string;
  canAccept: boolean;
  canRequestInfo: boolean;
  actions: StatusAction[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<StatusAction | null>(null);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState('');
  const [internal, setInternal] = useState(false);
  const [question, setQuestion] = useState('');

  async function run(fn: () => Promise<{ ok: boolean; error: string | null }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That did not work');
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">Actions</h2>

      <div className="mt-3 flex flex-wrap gap-2">
        {canAccept && (
          <button
            disabled={busy}
            onClick={() => run(() => post(`/api/complaints/${complaintId}/assign`, { action: 'ACCEPT' }))}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-60"
          >
            Accept
          </button>
        )}
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
              run(() =>
                post(`/api/complaints/${complaintId}/status`, { status: action.status }),
              );
            }}
            className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* Rejecting or reopening without a reason leaves the student with a
          status change and no explanation, so the table refuses it and the UI
          asks for the sentence first. */}
      {noteFor && (
        <div className="mt-3 rounded-md border border-line p-3">
          <label className="text-sm font-medium" htmlFor="transition-note">
            Why are you doing this? The student will read it.
          </label>
          <textarea
            id="transition-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-2 w-full rounded-md border border-line bg-background p-2 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              disabled={busy || !note.trim()}
              onClick={async () => {
                const done = await run(() =>
                  post(`/api/complaints/${complaintId}/status`, {
                    status: noteFor.status,
                    note,
                  }),
                );
                if (done) setNoteFor(null);
              }}
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

      <div className="mt-4 border-t border-line pt-4">
        <label className="text-sm font-medium" htmlFor="progress-update">
          Progress update
        </label>
        <textarea
          id="progress-update"
          value={progress}
          onChange={(e) => setProgress(e.target.value)}
          rows={2}
          placeholder="Technician on site, switch being replaced…"
          className="mt-2 w-full rounded-md border border-line bg-background p-2 text-sm"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            disabled={busy || !progress.trim()}
            onClick={async () => {
              const done = await run(() =>
                post(`/api/complaints/${complaintId}/updates`, {
                  kind: 'PROGRESS',
                  message: progress,
                  isInternal: internal,
                }),
              );
              if (done) setProgress('');
            }}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-60"
          >
            Post update
          </button>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            Internal note — the student will not see this
          </label>
        </div>
      </div>

      {canRequestInfo && (
        <div className="mt-4 border-t border-line pt-4">
          <label className="text-sm font-medium" htmlFor="info-request">
            Ask the student for more information
          </label>
          <textarea
            id="info-request"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder="Which room number is the affected outlet in?"
            className="mt-2 w-full rounded-md border border-line bg-background p-2 text-sm"
          />
          <button
            disabled={busy || !question.trim()}
            onClick={async () => {
              const done = await run(() =>
                post(`/api/complaints/${complaintId}/updates`, {
                  kind: 'INFO_REQUEST',
                  message: question,
                }),
              );
              if (done) setQuestion('');
            }}
            className="mt-2 rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-60"
          >
            Send the question
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}

/**
 * The student's half of `WAITING_FOR_STUDENT`. Answering is what moves the
 * complaint back to `IN_PROGRESS` — the wait ends because the reason for it did.
 */
export function StudentReply({ complaintId, question }: { complaintId: string; question: string | null }) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-yellow-300 bg-yellow-50 p-5">
      <h2 className="text-sm font-medium text-yellow-900">The team needs one more thing</h2>
      {question && <p className="mt-1 text-sm text-yellow-900">{question}</p>}
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        aria-label="Your reply"
        className="mt-3 w-full rounded-md border border-yellow-300 bg-white p-2 text-sm"
      />
      <button
        disabled={busy || !message.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await post(`/api/complaints/${complaintId}/updates`, {
            kind: 'INFO_RESPONSE',
            message,
          });
          setBusy(false);
          if (!result.ok) {
            setError(result.error ?? 'Could not send your reply');
            return;
          }
          setMessage('');
          router.refresh();
        }}
        className="mt-2 rounded-md bg-yellow-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}

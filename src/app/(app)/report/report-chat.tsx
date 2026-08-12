'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PriorityBadge } from '@/components/badges';

type LocationLite = { id: string; name: string; depth: number };

type DraftView = {
  id: string;
  categoryLabel: string | null;
  turns: { role: string; text: string; slotKey?: string; at: string }[];
  step:
    | { kind: 'CATEGORY'; categories: { key: string; label: string; description: string }[] }
    | {
        kind: 'QUESTION';
        slotKey: string;
        question: string;
        type: string;
        options: { value: string; label: string }[];
        allowUnsure: boolean;
        allowSkip: boolean;
        safetyCritical: boolean;
        placeholder?: string;
      }
    | {
        kind: 'SUMMARY';
        reason: string | null;
        safetyShortCircuit: boolean;
        assessment: {
          priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
          reasons: string[];
          departmentName: string | null;
          categoryLabel: string;
          subcategoryLabel: string | null;
          safetyShortCircuit: boolean;
        } | null;
      };
  summary: { slotKey: string; label: string; display: string; state: string }[];
  canSubmit: boolean;
  /** Which extractor read the last message. Null on turns that ran no extraction. */
  extractionSource: 'RULES' | 'LLM' | null;
};

export function ReportChat({ locations }: { locations: LocationLite[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [text, setText] = useState('');
  const [multi, setMulti] = useState<string[]>([]);
  const [addingInfo, setAddingInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? 'Something went wrong');
      return null;
    }
    return data;
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const data = await call('/api/drafts', { rawText: text });
    if (!data) return;
    setDraft(data.draft);
    setText('');
    setMulti([]);
  }

  async function act(body: unknown) {
    if (!draft) return;
    const data = await call(`/api/drafts/${draft.id}`, body);
    if (!data) return;
    setDraft(data.draft);
    setText('');
    setMulti([]);
    setAddingInfo(false);
  }

  async function submit() {
    if (!draft) return;
    const data = await call(`/api/drafts/${draft.id}/submit`, {});
    if (!data) return;
    router.push(`/complaints/${data.complaint.id}`);
  }

  if (!draft) {
    return (
      <form onSubmit={start} className="mt-6 space-y-3 rounded-lg border border-line bg-surface p-5">
        <label className="block text-sm">
          <span className="font-medium">What&apos;s the problem?</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            required
            placeholder="e.g. The wifi is down in CSE Block since morning"
            className="mt-1 w-full rounded-md border border-line px-3 py-2"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Reading…' : 'Continue'}
        </button>
      </form>
    );
  }

  const step = draft.step;

  return (
    <div className="mt-6 space-y-4">
      <div className="space-y-2 rounded-lg border border-line bg-surface p-5">
        {draft.categoryLabel && (
          <p className="text-xs uppercase tracking-wide text-muted">{draft.categoryLabel}</p>
        )}
        {draft.turns.map((turn, i) => (
          <p key={i} className={turn.role === 'USER' ? 'text-sm' : 'text-sm text-muted'}>
            <span className="text-muted">{turn.role === 'USER' ? 'You: ' : ''}</span>
            {turn.text}
          </p>
        ))}
        {draft.extractionSource && (
          <p className="pt-1 text-xs text-muted">
            {draft.extractionSource === 'LLM'
              ? 'Read with AI extraction — anything it filled in is shown below and editable.'
              : 'Read with keyword matching.'}
          </p>
        )}
      </div>

      {step.kind === 'CATEGORY' && (
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="font-medium">Which of these fits best?</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {step.categories.map((c) => (
              <button
                key={c.key}
                onClick={() => act({ action: 'category', categoryKey: c.key })}
                disabled={busy}
                className="rounded-md border border-line p-3 text-left hover:border-accent"
              >
                <span className="font-medium">{c.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{c.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step.kind === 'QUESTION' && (
        <div
          className={`rounded-lg border bg-surface p-5 ${
            step.safetyCritical ? 'border-red-300' : 'border-line'
          }`}
        >
          <p className="font-medium">{step.question}</p>
          {step.safetyCritical && (
            <p className="mt-1 text-xs text-red-600">Safety question — asked first on purpose.</p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {step.type === 'enum' &&
              step.options.map((o) => (
                <button
                  key={o.value}
                  disabled={busy}
                  onClick={() => act({ action: 'answer', slotKey: step.slotKey, kind: 'VALUE', value: o.value })}
                  className="rounded-full border border-line px-3 py-1 text-sm hover:border-accent"
                >
                  {o.label}
                </button>
              ))}

            {step.type === 'boolean' &&
              [true, false].map((v) => (
                <button
                  key={String(v)}
                  disabled={busy}
                  onClick={() => act({ action: 'answer', slotKey: step.slotKey, kind: 'VALUE', value: v })}
                  className="rounded-full border border-line px-4 py-1 text-sm hover:border-accent"
                >
                  {v ? 'Yes' : 'No'}
                </button>
              ))}

            {step.type === 'multi' &&
              step.options.map((o) => {
                const on = multi.includes(o.value);
                return (
                  <button
                    key={o.value}
                    disabled={busy}
                    onClick={() =>
                      setMulti((m) => (on ? m.filter((v) => v !== o.value) : [...m, o.value]))
                    }
                    className={`rounded-full border px-3 py-1 text-sm ${
                      on ? 'border-accent bg-accent text-white' : 'border-line hover:border-accent'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
          </div>

          {step.type === 'multi' && (
            <button
              disabled={busy || multi.length === 0}
              onClick={() => act({ action: 'answer', slotKey: step.slotKey, kind: 'VALUE', value: multi })}
              className="mt-3 rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Continue
            </button>
          )}

          {step.type === 'location' && (
            <select
              disabled={busy}
              defaultValue=""
              onChange={(e) =>
                e.target.value &&
                act({ action: 'answer', slotKey: step.slotKey, kind: 'VALUE', value: e.target.value })
              }
              className="mt-3 w-full rounded-md border border-line px-3 py-2 text-sm"
            >
              <option value="">Select a location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {' '.repeat(l.depth * 3)}
                  {l.name}
                </option>
              ))}
            </select>
          )}

          {(step.type === 'text' || step.type === 'number' || step.type === 'date') && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act({ action: 'message', text, slotKey: step.slotKey });
              }}
              className="mt-3 flex gap-2"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={step.placeholder}
                className="flex-1 rounded-md border border-line px-3 py-2 text-sm"
              />
              <button disabled={busy || !text} className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">
                Send
              </button>
            </form>
          )}

          <div className="mt-4 flex gap-3 text-sm">
            {step.allowUnsure && (
              <button
                disabled={busy}
                onClick={() => act({ action: 'answer', slotKey: step.slotKey, kind: 'UNSURE' })}
                className="text-muted underline"
              >
                I&apos;m not sure
              </button>
            )}
            {step.allowSkip && (
              <button
                disabled={busy}
                onClick={() => act({ action: 'answer', slotKey: step.slotKey, kind: 'SKIP' })}
                className="text-muted underline"
              >
                Skip
              </button>
            )}
          </div>
        </div>
      )}

      {step.kind === 'SUMMARY' && (
        <div className="rounded-lg border border-line bg-surface p-5">
          {step.safetyShortCircuit && (
            <p className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
              This looks unsafe — we&apos;ve stopped asking questions. Submit now and it goes out as
              a critical report.
            </p>
          )}
          <p className="font-medium">Here&apos;s what we understood</p>
          <dl className="mt-3 divide-y divide-line">
            {draft.summary.map((line) => (
              <div key={line.slotKey} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <dt className="text-muted">{line.label}</dt>
                  <dd>{line.display}</dd>
                </div>
                <button
                  disabled={busy}
                  onClick={() => act({ action: 'edit', slotKey: line.slotKey })}
                  className="text-xs text-accent underline"
                >
                  Edit
                </button>
              </div>
            ))}
          </dl>

          {step.assessment && (
            <div className="mt-4 rounded-md border border-line bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Priority</span>
                <PriorityBadge priority={step.assessment.priority} />
              </div>

              {step.assessment.reasons.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {step.assessment.reasons.map((reason) => (
                    <li key={reason}>· {reason}</li>
                  ))}
                </ul>
              )}

              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted">Category</dt>
                  <dd>
                    {step.assessment.categoryLabel}
                    {step.assessment.subcategoryLabel ? ` — ${step.assessment.subcategoryLabel}` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Responsible department</dt>
                  {/* An unrouted complaint is a routing decision the student can
                      do nothing about, so it reads as a handover, not a doubt. */}
                  <dd>
                    {step.assessment.departmentName ?? 'To be assigned by the campus office'}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {addingInfo ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act({ action: 'message', text });
              }}
              className="mt-4 flex gap-2"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Anything else we should know?"
                className="flex-1 rounded-md border border-line px-3 py-2 text-sm"
              />
              <button disabled={busy || !text} className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">
                Add
              </button>
            </form>
          ) : (
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                disabled={busy}
                onClick={submit}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                Looks correct — submit
              </button>
              <button
                disabled={busy}
                onClick={() => setAddingInfo(true)}
                className="rounded-md border border-line px-4 py-2 text-sm"
              >
                Add more info
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

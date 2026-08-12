'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Slot, SlotValues } from '@/lib/engine/types';
import { evaluateCondition } from '@/lib/engine/condition';

type CategoryLite = { key: string; label: string; description: string; slots: Slot[] };
type LocationLite = { id: string; name: string; depth: number };

export function StaticReportForm({
  categories,
  locations,
}: {
  categories: CategoryLite[];
  locations: LocationLite[];
}) {
  const router = useRouter();
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [locationId, setLocationId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const category = categories.find((c) => c.key === categoryKey) ?? null;

  // Slot values are needed to evaluate askIf as the form is filled in.
  const slotValues = useMemo<SlotValues>(() => {
    const out: SlotValues = {};
    for (const [key, value] of Object.entries(answers)) {
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
      out[key] = { value, state: 'FILLED', source: 'ANSWERED', confidence: 1 };
    }
    if (locationId) {
      out.location = { value: locationId, state: 'FILLED', source: 'ANSWERED', confidence: 1 };
    }
    return out;
  }, [answers, locationId]);

  const visibleSlots = (category?.slots ?? []).filter(
    (s) =>
      (s.importance === 'REQUIRED' || s.key === 'details') && evaluateCondition(s.askIf, slotValues),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!category) return;
    setBusy(true);
    setError(null);

    const res = await fetch('/api/complaints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryKey: category.key,
        locationId: locationId || null,
        slots: slotValues,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? 'Could not submit the complaint');
      setBusy(false);
      return;
    }
    router.push(`/complaints/${data.complaint.id}`);
  }

  if (!category) {
    return (
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategoryKey(c.key)}
            className="rounded-lg border border-line bg-surface p-4 text-left hover:border-accent"
          >
            <span className="font-medium">{c.label}</span>
            <span className="mt-1 block text-sm text-muted">{c.description}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-5 rounded-lg border border-line bg-surface p-5">
      <div className="flex items-center justify-between">
        <span className="font-medium">{category.label}</span>
        <button
          type="button"
          onClick={() => {
            setCategoryKey(null);
            setAnswers({});
            setLocationId('');
          }}
          className="text-sm text-muted underline"
        >
          Change category
        </button>
      </div>

      {visibleSlots.map((slot) => (
        <SlotField
          key={slot.key}
          slot={slot}
          locations={locations}
          locationId={locationId}
          value={answers[slot.key]}
          onLocation={setLocationId}
          onChange={(v) => setAnswers((a) => ({ ...a, [slot.key]: v }))}
        />
      ))}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? 'Submitting…' : 'Submit complaint'}
      </button>
    </form>
  );
}

function SlotField({
  slot,
  value,
  onChange,
  locations,
  locationId,
  onLocation,
}: {
  slot: Slot;
  value: unknown;
  onChange: (v: unknown) => void;
  locations: LocationLite[];
  locationId: string;
  onLocation: (id: string) => void;
}) {
  const required = slot.importance === 'REQUIRED';

  if (slot.type === 'location') {
    return (
      <label className="block text-sm">
        <span className="font-medium">{slot.question}</span>
        <select
          value={locationId}
          onChange={(e) => onLocation(e.target.value)}
          required={required}
          className="mt-1 w-full rounded-md border border-line px-3 py-2"
        >
          <option value="">Select a location…</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {' '.repeat(l.depth * 3)}
              {l.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (slot.type === 'enum') {
    return (
      <label className="block text-sm">
        <span className="font-medium">{slot.question}</span>
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          required={required}
          className="mt-1 w-full rounded-md border border-line px-3 py-2"
        >
          <option value="">Select…</option>
          {slot.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (slot.type === 'multi') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="text-sm">
        <legend className="font-medium">{slot.question}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {slot.options?.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() =>
                  onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])
                }
                className={`rounded-full border px-3 py-1 ${
                  on ? 'border-accent bg-accent text-white' : 'border-line'
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (slot.type === 'boolean') {
    return (
      <fieldset className="text-sm">
        <legend className="font-medium">{slot.question}</legend>
        <div className="mt-2 flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              onClick={() => onChange(v)}
              className={`rounded-full border px-4 py-1 ${
                value === v ? 'border-accent bg-accent text-white' : 'border-line'
              }`}
            >
              {v ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <label className="block text-sm">
      <span className="font-medium">{slot.question}</span>
      <textarea
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={slot.placeholder}
        required={required}
        rows={3}
        className="mt-1 w-full rounded-md border border-line px-3 py-2"
      />
    </label>
  );
}

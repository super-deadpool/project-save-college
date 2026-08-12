import { count, dayLabel, monthLabel, percent, signed } from '@/lib/analytics/format';
import { HEAT_LABEL, type HeatCell } from '@/lib/analytics/heatmap';
import type { HealthScore } from '@/lib/analytics/health';
import type { MonthlyCount } from '@/lib/analytics/recurring';

/**
 * The dashboard's charts — server-rendered SVG and CSS, no chart library and no
 * client JavaScript.
 *
 * Two rules shape all of them. **Every chart here plots exactly one series**, a
 * magnitude, so there is no categorical palette to assign and no legend to
 * carry: the heading names the measure and the bars carry the size. And **colour
 * never carries meaning alone** — the heat bands print their word, §34's terms
 * print their signed points, and every mark has a `<title>` so hovering says the
 * number aloud. That is also why the numbers sit in ink beside their marks
 * rather than being coloured to match them.
 */

// ---------------------------------------------------------------- stat tiles

export function StatTile({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: 'plain' | 'good' | 'warning' | 'critical';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[var(--status-good)]'
      : tone === 'critical'
        ? 'text-[var(--status-critical)]'
        : tone === 'warning'
          ? 'text-[#8a6300]' // the warning step is sub-3:1 on white, so text uses a darker sibling
          : '';

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- bar list

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** What to print at the end of the row — the count, the share, the average. */
  display: string;
  hint?: string | null;
  href?: string;
}

/**
 * Horizontal bars for a ranked magnitude — §31's category distribution, and any
 * "which of these is biggest" question. Horizontal because the labels are words:
 * rotating "Hostel Administration" to fit a vertical axis is how a chart becomes
 * unreadable.
 */
export function BarList({ items, emptyNote = 'Nothing yet.' }: { items: BarItem[]; emptyNote?: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{emptyNote}</p>;
  const max = items.reduce((m, i) => Math.max(m, i.value), 0);

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const width = max === 0 ? 0 : (item.value / max) * 100;
        return (
          <li key={item.key} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3 text-sm">
            <span className="truncate text-muted" title={item.label}>
              {item.label}
            </span>
            {/* The track makes an empty bar legible as "zero" rather than as a
                missing row. 4px rounded ends, anchored at the baseline. */}
            <span className="h-2.5 w-full rounded-full bg-[var(--viz-track)]" role="presentation">
              <span
                className="block h-2.5 rounded-full bg-[var(--viz-bar)]"
                style={{ width: `${Math.max(width, item.value > 0 ? 2 : 0)}%` }}
                title={`${item.label}: ${item.display}`}
              />
            </span>
            <span className="text-right tabular-nums" title={item.hint ?? undefined}>
              {item.display}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- trend

/**
 * Monthly volume as columns. Columns rather than a line because six monthly
 * readings are six discrete facts, and a line between them implies a continuous
 * measurement nobody took. Only the extremes are labelled — a number on every
 * column is noise, and the tallest and the current one are the two anybody reads.
 */
export function MonthBars({
  months,
  caption,
}: {
  months: MonthlyCount[];
  caption?: string;
}) {
  if (months.length === 0) return <p className="text-sm text-muted">No history yet.</p>;

  const max = months.reduce((m, b) => Math.max(m, b.count), 0);
  const peak = months.reduce((best, b) => (b.count > best.count ? b : best), months[0]);
  const height = 96;

  return (
    <figure className="mt-3">
      <div className="flex items-end gap-2" style={{ height }}>
        {months.map((bucket) => {
          const barHeight = max === 0 ? 0 : Math.max(2, (bucket.count / max) * height);
          const isPeak = bucket === peak && bucket.count > 0;
          const isLast = bucket === months[months.length - 1];
          return (
            <div key={bucket.month.toISOString()} className="flex flex-1 flex-col items-center justify-end gap-1">
              {(isPeak || isLast) && bucket.count > 0 && (
                <span className="text-[11px] tabular-nums text-muted">{bucket.count}</span>
              )}
              <div
                className={`w-full rounded-t ${isLast ? 'bg-[var(--viz-bar)]' : 'bg-[var(--viz-bar-soft)]'}`}
                style={{ height: barHeight }}
                title={`${monthLabel(bucket.month, 'long')}: ${bucket.count} complaints`}
              />
            </div>
          );
        })}
      </div>
      {/* A recessive baseline instead of a grid: the comparison here is between
          neighbouring columns, not against absolute gridlines. */}
      <div className="mt-1 border-t border-line" />
      <div className="mt-1 flex gap-2">
        {months.map((bucket) => (
          <span key={bucket.month.toISOString()} className="flex-1 text-center text-[11px] text-muted">
            {monthLabel(bucket.month)}
          </span>
        ))}
      </div>
      {caption && <figcaption className="mt-2 text-xs text-muted">{caption}</figcaption>}
    </figure>
  );
}

/** Daily volume as a 2px line with the latest point marked — §31's sparkline. */
export function Sparkline({
  points,
  caption,
}: {
  points: { day: Date; count: number }[];
  caption?: string;
}) {
  if (points.length < 2) return null;

  const width = 320;
  const height = 48;
  const max = points.reduce((m, p) => Math.max(m, p.count), 0) || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: i * step,
    y: height - (p.count / max) * (height - 6) - 3,
    point: p,
  }));
  const path = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];

  return (
    <figure className="mt-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-12 w-full"
        role="img"
        aria-label={`Daily complaints over the last ${points.length} days, peaking at ${max}`}
      >
        <polyline
          points={path}
          fill="none"
          stroke="var(--viz-bar)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* One marker, on the reading everybody looks for: the latest. A 2px
            surface ring keeps it legible where it overlaps the line. */}
        <circle cx={last.x} cy={last.y} r={4} fill="var(--viz-bar)" stroke="var(--color-surface)" strokeWidth={2}>
          <title>{`${dayLabel(last.point.day)}: ${last.point.count}`}</title>
        </circle>
      </svg>
      {caption && <figcaption className="text-xs text-muted">{caption}</figcaption>}
    </figure>
  );
}

// ---------------------------------------------------------------- §28 heatmap

const HEAT_FILL: Record<HeatCell['level'], string> = {
  HIGH: 'var(--status-critical)',
  MEDIUM: 'var(--status-warning)',
  LOW: 'var(--status-good)',
};

const HEAT_BADGE: Record<HeatCell['level'], string> = {
  HIGH: 'bg-red-100 text-red-900',
  MEDIUM: 'bg-amber-100 text-amber-900',
  LOW: 'bg-green-100 text-green-900',
};

/**
 * §28's heatmap. Three bands, each printed as a word next to its swatch — the
 * spec's own 🔴🟡🟢 with the colour demoted to a second channel, because two of
 * the three status steps are below 3:1 on a white surface and because a reader
 * who cannot separate red from amber still has to be able to read the map.
 */
export function HeatGrid({ cells }: { cells: HeatCell[] }) {
  if (cells.length === 0) return <p className="text-sm text-muted">No located complaints yet.</p>;

  return (
    <ul className="space-y-2">
      {cells.map((cell) => (
        <li key={cell.locationId} className="grid grid-cols-[10rem_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate" title={cell.locationName}>
            {cell.locationName}
          </span>
          <span className="h-2.5 w-full rounded-full bg-[var(--viz-track)]" role="presentation">
            <span
              className="block h-2.5 rounded-full"
              style={{
                width: `${Math.max(cell.intensity * 100, cell.total > 0 ? 3 : 0)}%`,
                backgroundColor: HEAT_FILL[cell.level],
              }}
              title={`${cell.locationName}: ${cell.total} complaints, ${cell.open} open`}
            />
          </span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-muted">{count(cell.total)}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEAT_BADGE[cell.level]}`}>
              {HEAT_LABEL[cell.level]}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- §34 health

/**
 * §34's score with the arithmetic that produced it. The number is the headline;
 * the terms underneath are why it is not 100, and each one is signed and worded
 * so the score can be argued with — the same discipline §14 imposes on a priority
 * band.
 */
export function HealthPanel({ health, title = 'Campus health' }: { health: HealthScore; title?: string }) {
  const tone =
    health.band === 'GOOD'
      ? 'text-[var(--status-good)]'
      : health.band === 'FAIR'
        ? 'text-[#8a6300]'
        : 'text-[var(--status-critical)]';

  return (
    <div>
      <div className="flex items-end gap-3">
        <p className={`text-4xl font-semibold tabular-nums ${tone}`}>{health.score}</p>
        <p className="pb-1 text-sm text-muted">/ 100 · {title}</p>
      </div>
      {!health.meaningful && (
        <p className="mt-1 text-xs text-muted">
          Too little history for this to mean much yet — it will settle as complaints accumulate.
        </p>
      )}
      <ul className="mt-4 space-y-2">
        {health.terms.map((term) => (
          <li key={term.label} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-sm">
            <span>{term.label}</span>
            {/* Signed magnitude against a common 25-point scale: penalties grow
                left of the zero tick, the satisfaction bonus right of it, so the
                shape of the score is legible before any number is read. */}
            <span className="relative block h-2 rounded-full bg-[var(--viz-track)]" role="presentation">
              <span className="absolute left-1/2 top-0 h-2 w-px bg-[var(--color-line)]" />
              <span
                className="absolute top-0 h-2 rounded-full"
                style={{
                  width: `${Math.min(50, (Math.abs(term.points) / 25) * 50)}%`,
                  left: term.points >= 0 ? '50%' : undefined,
                  right: term.points < 0 ? '50%' : undefined,
                  backgroundColor: term.points >= 0 ? 'var(--status-good)' : 'var(--status-critical)',
                }}
                title={`${term.label}: ${signed(term.points)} — ${term.detail}`}
              />
            </span>
            <span className="text-right tabular-nums">{signed(term.points)}</span>
            <span className="col-span-3 -mt-1 text-xs text-muted">{term.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- meters

/**
 * A percentage inside a table cell — SLA compliance, satisfaction. Thin, in ink,
 * with the number beside it: a bar in a table is an aid to scanning, not the
 * value itself.
 */
export function Meter({ fraction, label }: { fraction: number | null; label?: string }) {
  if (fraction == null) return <span className="text-muted">—</span>;
  const pct = Math.max(0, Math.min(1, fraction));
  const tone =
    pct >= 0.9 ? 'var(--status-good)' : pct >= 0.7 ? 'var(--status-warning)' : 'var(--status-critical)';

  return (
    <span className="flex items-center gap-2" title={label}>
      <span className="h-1.5 w-14 rounded-full bg-[var(--viz-track)]">
        <span
          className="block h-1.5 rounded-full"
          style={{ width: `${pct * 100}%`, backgroundColor: tone }}
        />
      </span>
      <span className="tabular-nums">{percent(fraction)}</span>
    </span>
  );
}

/** §24's distribution — five bars, one per star, for the satisfaction panel. */
export function RatingHistogram({ histogram, total }: { histogram: Record<number, number>; total: number }) {
  return (
    <ul className="mt-3 space-y-1">
      {[5, 4, 3, 2, 1].map((star) => {
        const value = histogram[star] ?? 0;
        const width = total === 0 ? 0 : (value / total) * 100;
        return (
          <li key={star} className="grid grid-cols-[2.5rem_1fr_2rem] items-center gap-2 text-xs">
            <span className="text-muted">{'★'.repeat(star)}</span>
            <span className="h-1.5 w-full rounded-full bg-[var(--viz-track)]">
              <span
                className="block h-1.5 rounded-full bg-[var(--viz-bar)]"
                style={{ width: `${width}%` }}
                title={`${star} stars: ${value}`}
              />
            </span>
            <span className="text-right tabular-nums text-muted">{value}</span>
          </li>
        );
      })}
    </ul>
  );
}

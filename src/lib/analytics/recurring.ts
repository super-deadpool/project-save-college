/**
 * §27 and §30 — the difference between fixing a thing forty times and fixing the
 * thing that keeps breaking.
 *
 *     CSE Block Wi-Fi:  Jan 12 · Feb 18 · Mar 27 · Apr 43
 *
 * Pure (CLAUDE.md §5): a series of monthly counts per (location, category) in,
 * signals and recommendations out. `analytics/sql.ts` produces the series and
 * `analytics/service.ts` persists what this decides into `RecurringSignal`.
 */

export interface MonthlyCount {
  /** First day of the month, UTC — the bucket `date_trunc('month', ...)` returns. */
  month: Date;
  count: number;
}

export interface TrendSeries {
  categoryKey: string;
  locationId: string | null;
  locationName: string | null;
  categoryLabel: string;
  /** Oldest first. Months with no complaints must be present as zeroes. */
  months: MonthlyCount[];
}

export interface RecurringSignal {
  categoryKey: string;
  categoryLabel: string;
  locationId: string | null;
  locationName: string | null;
  windowStart: Date;
  windowEnd: Date;
  /** Complaints inside the window — what §30's "31 water complaints" counts. */
  occurrences: number;
  /**
   * Growth across the window as a fraction: 0.5 is "half again as many". A window
   * that starts from zero has no baseline to divide by, so it reports the latest
   * month's count instead — a number for ranking, never a percentage to print.
   */
  growthRate: number;
  /** False when the window starts at zero: there is no percentage to state. */
  hasBaseline: boolean;
  /** The growth in words — "up 258%", or "up from none" with no baseline. */
  growthLabel: string;
  /** How many consecutive months rose. Four in a row is §27's example. */
  risingMonths: number;
  /** The headline §27 shows: "Wi-Fi complaints in CSE Block have increased…". */
  narrative: string;
  /** §30's recommendation: what to go and look at. */
  suggestion: string;
  /** Louder when the trend is both steep and sustained. */
  severity: 'WATCH' | 'ACT';
}

export interface RecurringOptions {
  /** Minimum complaints in the window before a trend is worth a sentence. */
  minOccurrences?: number;
  /** Minimum complaints in the most recent month — the trend has to still be live. */
  minLatest?: number;
  /** Minimum growth across the window, as a fraction. 0.5 = up by half. */
  minGrowth?: number;
  /** How many of the most recent months to read. §27's example uses four. */
  months?: number;
  /**
   * Months that must carry complaints before a window with no baseline counts as
   * a trend. A category that only exists in the newest month is a *start*, not a
   * climb, and calling it "up 5200%" against months that predate the data is the
   * kind of number that discredits the whole panel.
   */
  minActiveMonths?: number;
}

export const RECURRING_DEFAULTS: Required<RecurringOptions> = {
  // Below these, "up 100%" is two complaints becoming four — true, and noise.
  // Both floors are needed: the window total keeps a one-off spike out, and the
  // latest month keeps in only trends that are still happening.
  minOccurrences: 12,
  minLatest: 4,
  minGrowth: 0.5,
  months: 4,
  minActiveMonths: 3,
};

/**
 * Signals worth putting in front of an administrator, worst first.
 *
 * Two things have to be true at once: the volume has to matter and the direction
 * has to be up. Growth alone flags a quiet corner of campus that went from one
 * complaint to three; volume alone flags the busiest building on campus every
 * month forever, which teaches an administrator to ignore the panel.
 */
export function detectRecurring(
  series: TrendSeries[],
  options: RecurringOptions = {},
): RecurringSignal[] {
  const { minOccurrences, minLatest, minGrowth, months, minActiveMonths } = {
    ...RECURRING_DEFAULTS,
    ...options,
  };

  const signals: RecurringSignal[] = [];

  for (const entry of series) {
    const window = entry.months.slice(-months);
    if (window.length < 2) continue;

    const occurrences = window.reduce((sum, m) => sum + m.count, 0);
    if (occurrences < minOccurrences) continue;
    if (window[window.length - 1].count < minLatest) continue;

    // With no baseline month there is nothing to have grown *from*, so the shape
    // has to come from the months themselves: a climb over several of them is a
    // trend, one busy month at the end of an empty window is just the start of
    // the data.
    const hasBaseline = window[0].count > 0;
    const activeMonths = window.filter((m) => m.count > 0).length;
    if (!hasBaseline && activeMonths < minActiveMonths) continue;

    const growthRate = growthAcross(window);
    if (growthRate < minGrowth) continue;

    const risingMonths = trailingRise(window);
    const where = entry.locationName ?? 'across campus';
    const first = window[0];
    const last = window[window.length - 1];

    signals.push({
      categoryKey: entry.categoryKey,
      categoryLabel: entry.categoryLabel,
      locationId: entry.locationId,
      locationName: entry.locationName,
      windowStart: first.month,
      windowEnd: endOfMonth(last.month),
      occurrences,
      growthRate,
      hasBaseline,
      growthLabel: hasBaseline ? `up ${Math.round(growthRate * 100)}%` : 'up from none',
      risingMonths,
      narrative: narrate(entry.categoryLabel, where, window, growthRate, hasBaseline),
      suggestion: suggest(entry.categoryKey, entry.categoryLabel, where, occurrences, window.length),
      // Sustained *and* steep is a different message from one bad month.
      severity: risingMonths >= 3 || growthRate >= 1 ? 'ACT' : 'WATCH',
    });
  }

  // Act before watch, then steepest first — an administrator reads this list from
  // the top and should be reading the thing that most needs doing.
  return signals.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.growthRate - a.growthRate ||
      b.occurrences - a.occurrences,
  );
}

const SEVERITY_ORDER: Record<RecurringSignal['severity'], number> = { ACT: 0, WATCH: 1 };

/**
 * Growth from the first month of the window to the last.
 *
 * Measured end to end rather than month over month on purpose: §27's example is
 * a four-month climb, and a single flat month in the middle should not cancel a
 * trend that tripled. A rise from zero counts as one whole increase per empty
 * month instead of dividing by zero.
 */
export function growthAcross(window: MonthlyCount[]): number {
  const first = window[0].count;
  const last = window[window.length - 1].count;
  if (first === 0) return last === 0 ? 0 : last;
  return (last - first) / first;
}

/** How many consecutive rises end the window — 4, 12, 18, 27, 43 gives 4. */
export function trailingRise(window: MonthlyCount[]): number {
  let rising = 0;
  for (let i = window.length - 1; i > 0; i--) {
    if (window[i].count > window[i - 1].count) rising += 1;
    else break;
  }
  return rising;
}

const MONTH_LABEL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthName(at: Date): string {
  return MONTH_LABEL[at.getUTCMonth()];
}

function endOfMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

/**
 * §27's sentence, with the numbers in it. "Increased significantly" on its own is
 * a claim; "12 in January to 43 in April" is the evidence for it, and an
 * administrator can only argue with the second kind.
 */
function narrate(
  categoryLabel: string,
  where: string,
  window: MonthlyCount[],
  growthRate: number,
  hasBaseline: boolean,
): string {
  const first = window[0];
  const last = window[window.length - 1];
  const place = where === 'across campus' ? where : `in ${where}`;
  const span = `${monthName(first.month)} to ${monthName(last.month)}`;

  // With no baseline there is no honest percentage: "up 5200%" against a month
  // that predates the data is arithmetic pretending to be a finding.
  if (!hasBaseline) {
    const started = window.find((m) => m.count > 0)!;
    return (
      `${categoryLabel} complaints ${place} have climbed to ${last.count} a month, ` +
      `from none before ${monthName(started.month)}.`
    );
  }

  return (
    `${categoryLabel} complaints ${place} rose ${Math.round(growthRate * 100)}% ` +
    `from ${span} — ${first.count} to ${last.count} a month.`
  );
}

/**
 * §30's recommendation. Deliberately about inspecting infrastructure rather than
 * about the individual complaints: the point of this whole layer is that the
 * forty-first complaint should not have to be filed.
 */
const INSPECTION: Record<string, string> = {
  NETWORK: 'Inspect the network hardware and access-point coverage',
  ELECTRICAL: 'Inspect the electrical wiring and distribution boards',
  WATER: 'Inspect the water supply and plumbing',
  SANITATION: 'Review the cleaning schedule and waste collection',
  FURNITURE: 'Audit the furniture condition',
  CLASSROOM: 'Service the classroom equipment',
  HOSTEL: 'Inspect the hostel fittings and maintenance backlog',
  HOSTEL_FOOD: 'Review the mess supplier and kitchen hygiene',
  CANTEEN: 'Review canteen hygiene and food handling',
  SECURITY: 'Review access control and patrol coverage',
  LIBRARY: 'Review library facilities and equipment',
  TRANSPORT: 'Review the bus schedule and vehicle maintenance',
  LAB_OTHER: 'Service the lab equipment',
};

function suggest(
  categoryKey: string,
  categoryLabel: string,
  where: string,
  occurrences: number,
  monthCount: number,
): string {
  const action = INSPECTION[categoryKey] ?? `Investigate the recurring ${categoryLabel.toLowerCase()} problem`;
  const place = where === 'across campus' ? 'campus-wide' : `in ${where}`;
  return `${action} ${place} — ${occurrences} complaints in ${monthCount} months suggests a fault that keeps coming back rather than ${occurrences} separate faults.`;
}

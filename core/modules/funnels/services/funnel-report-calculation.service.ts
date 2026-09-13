import type { FunnelReport, FunnelStep } from "../interfaces";
import type { FunnelStepCount } from "../interfaces";

/** Widest window the report will look back over, in days. */
const MAX_REPORT_DAYS = 366;
const DEFAULT_REPORT_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * Clamp a caller-supplied day count into a range the aggregation can serve.
 *
 * Anything unparseable falls back to the default rather than rejecting: `days` is a
 * dashboard control, and a stale bookmark should render the default range instead of
 * an error page.
 */
export function clampReportDays(days: number | undefined): number {
  return Math.min(
    MAX_REPORT_DAYS,
    Math.max(1, Math.floor(Number(days ?? DEFAULT_REPORT_DAYS) || DEFAULT_REPORT_DAYS)),
  );
}

/** The half-open range the report covers, as the ISO strings the query binds. */
export function reportWindow(days: number, now: Date = new Date()): { startIso: string; endIso: string } {
  const start = new Date(now.getTime() - days * MS_PER_DAY);
  return { startIso: start.toISOString(), endIso: now.toISOString() };
}

/**
 * Turn per-step visitor counts into the report the dashboard renders.
 *
 * Pure, so the arithmetic that users read as their conversion rate is testable
 * without a database.
 *
 * Two decisions worth knowing:
 * - Step 0's count *is* `totalEntries`, so its drop-off is always zero. Comparing
 *   step 0 against the completion bucket instead would report every unfinished
 *   visitor as having dropped at the first step.
 * - Counts are not monotonic. Visitors can reach step 2 in a session where step 1
 *   was never recorded (a deep link, or a batch lost before flush), which makes a
 *   later step exceed an earlier one. `Math.max(0, …)` reports that as no drop-off
 *   rather than as a negative one.
 */
export function buildFunnelReport(
  steps: Pick<FunnelStep, "name">[],
  counts: FunnelStepCount[],
): FunnelReport {
  const at = (order: number) => counts.find((r) => r.step_order === order)?.cnt ?? 0;

  const totalEntries = at(0);
  const completions = at(-1);
  const conversionRate =
    totalEntries > 0 ? Math.round((completions / totalEntries) * 1000) / 10 : 0;

  const stepBreakdown = steps.map((s, idx) => {
    const current = at(idx);
    const prev = idx === 0 ? totalEntries : at(idx - 1);
    const dropoffCount = Math.max(0, prev - current);
    const dropoffRate = prev > 0 ? Math.round((dropoffCount / prev) * 1000) / 10 : 0;
    return {
      stepOrder: idx,
      stepName: s.name,
      count: current,
      dropoffCount,
      dropoffRate,
    };
  });

  return { totalEntries, completions, conversionRate, stepBreakdown };
}

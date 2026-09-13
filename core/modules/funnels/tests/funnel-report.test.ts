import { describe, expect, it } from "bun:test";
import {
  buildFunnelReport,
  clampReportDays,
  reportWindow,
} from "../services/funnel-report-calculation.service";
import type { FunnelStepCount } from "../interfaces";

const steps = [{ name: "View" }, { name: "Cart" }, { name: "Pay" }];

/** `step_order` −1 is the completion bucket; 0..n are step indices. */
function counts(pairs: [number, number][]): FunnelStepCount[] {
  return pairs.map(([step_order, cnt]) => ({ step_order, cnt }));
}

describe("clampReportDays", () => {
  it("keeps a value inside the range", () => {
    expect(clampReportDays(7)).toBe(7);
  });

  it("defaults to 30 when absent", () => {
    expect(clampReportDays(undefined)).toBe(30);
  });

  // The route hands over `Number(query)` without validating, so NaN arrives here
  // whenever a bookmark carries `?days=last-month`.
  it("defaults to 30 for NaN", () => {
    expect(clampReportDays(Number("not-a-number"))).toBe(30);
  });

  it("clamps zero and negatives up to 1", () => {
    expect(clampReportDays(0)).toBe(30);
    expect(clampReportDays(-5)).toBe(1);
  });

  it("caps at 366", () => {
    expect(clampReportDays(100_000)).toBe(366);
  });

  it("floors a fractional value", () => {
    expect(clampReportDays(7.9)).toBe(7);
  });
});

describe("reportWindow", () => {
  it("spans exactly `days` back from now", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    expect(reportWindow(3, now)).toEqual({
      startIso: "2026-03-07T12:00:00.000Z",
      endIso: "2026-03-10T12:00:00.000Z",
    });
  });
});

describe("buildFunnelReport", () => {
  it("derives entries, completions and conversion rate", () => {
    const report = buildFunnelReport(
      steps,
      counts([
        [-1, 25],
        [0, 100],
        [1, 60],
        [2, 30],
      ]),
    );

    expect(report.totalEntries).toBe(100);
    expect(report.completions).toBe(25);
    expect(report.conversionRate).toBe(25);
  });

  it("reports the conversion rate to one decimal", () => {
    const report = buildFunnelReport(steps, counts([[-1, 1], [0, 3]]));
    expect(report.conversionRate).toBe(33.3);
  });

  // A funnel with no traffic must render as zeroes, not as a division by zero.
  it("returns zeroes for an empty range", () => {
    const report = buildFunnelReport(steps, []);
    expect(report).toEqual({
      totalEntries: 0,
      completions: 0,
      conversionRate: 0,
      stepBreakdown: [
        { stepOrder: 0, stepName: "View", count: 0, dropoffCount: 0, dropoffRate: 0 },
        { stepOrder: 1, stepName: "Cart", count: 0, dropoffCount: 0, dropoffRate: 0 },
        { stepOrder: 2, stepName: "Pay", count: 0, dropoffCount: 0, dropoffRate: 0 },
      ],
    });
  });

  // Step 0 is compared against itself, so the first step can never show drop-off —
  // comparing it against the completion bucket would blame step 1 for every
  // visitor who simply has not finished yet.
  it("never reports drop-off on the first step", () => {
    const report = buildFunnelReport(steps, counts([[-1, 5], [0, 100], [1, 100], [2, 100]]));
    expect(report.stepBreakdown[0]).toMatchObject({ dropoffCount: 0, dropoffRate: 0 });
  });

  it("measures each step's drop-off against the step before it", () => {
    const report = buildFunnelReport(steps, counts([[0, 100], [1, 60], [2, 30]]));

    expect(report.stepBreakdown[1]).toMatchObject({ dropoffCount: 40, dropoffRate: 40 });
    expect(report.stepBreakdown[2]).toMatchObject({ dropoffCount: 30, dropoffRate: 50 });
  });

  // Counts are not monotonic in practice: a deep link, or a batch lost before
  // flush, can leave a later step with more visitors than an earlier one.
  it("reports no drop-off when a later step exceeds an earlier one", () => {
    const report = buildFunnelReport(steps, counts([[0, 10], [1, 40], [2, 40]]));
    expect(report.stepBreakdown[1]).toMatchObject({ dropoffCount: 0, dropoffRate: 0 });
  });

  // The aggregation only returns buckets that have events, so a step nobody
  // reached exists in the report solely because it exists in the definition.
  it("includes steps that have no events at all", () => {
    const report = buildFunnelReport(steps, counts([[0, 10]]));
    expect(report.stepBreakdown).toHaveLength(3);
    expect(report.stepBreakdown[2]).toMatchObject({ stepName: "Pay", count: 0 });
  });

  it("ignores buckets beyond the defined steps", () => {
    const report = buildFunnelReport([{ name: "Only" }], counts([[0, 10], [5, 99]]));
    expect(report.stepBreakdown).toHaveLength(1);
  });
});

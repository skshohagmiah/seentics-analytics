import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeDbModule, fakeLogger } from "./helpers/fake-db";

mock.module("../../../db", fakeDbModule);
mock.module("../../../platform/lib/logger", fakeLogger);

type Call = { operation: string; args: unknown[] };
const calls: Call[] = [];

function query(operation: string) {
  return (...args: unknown[]) => {
    calls.push({ operation, args });
    return Promise.resolve({ operation });
  };
}

let DashboardAnalyticsService: typeof import("../services/dashboard-analytics.service").DashboardAnalyticsService;
let DimensionAnalyticsService: typeof import("../services/dimension-analytics.service").DimensionAnalyticsService;
let RealtimeAnalyticsService: typeof import("../services/realtime-analytics.service").RealtimeAnalyticsService;
let VisitorJourneyAnalyticsService: typeof import("../services/visitor-journey-analytics.service").VisitorJourneyAnalyticsService;
let ConversionAnalyticsService: typeof import("../services/conversion-analytics.service").ConversionAnalyticsService;
let AnalyticsExportService: typeof import("../services/analytics-export.service").AnalyticsExportService;

beforeAll(async () => {
  ({ DashboardAnalyticsService } = await import("../services/dashboard-analytics.service"));
  ({ DimensionAnalyticsService } = await import("../services/dimension-analytics.service"));
  ({ RealtimeAnalyticsService } = await import("../services/realtime-analytics.service"));
  ({ VisitorJourneyAnalyticsService } = await import("../services/visitor-journey-analytics.service"));
  ({ ConversionAnalyticsService } = await import("../services/conversion-analytics.service"));
  ({ AnalyticsExportService } = await import("../services/analytics-export.service"));
});

describe("analytics domain services", () => {
  beforeEach(() => calls.splice(0));

  it("dashboard reads delegate without repeating website access checks", async () => {
    const service = new DashboardAnalyticsService({
      getDashboardStats: query("dashboard") as never,
    });
    await service.getDashboard("site-1", { days: "30" });
    expect(calls).toEqual([{ operation: "dashboard", args: ["site-1", { days: "30" }] }]);
  });

  it("dimension reads stay in the dimension service", async () => {
    const service = new DimensionAnalyticsService({
      getPagesAnalytics: query("pages") as never,
    });
    await service.getPages("site-1", { limit: "10" });
    expect(calls[0]).toEqual({ operation: "pages", args: ["site-1", { limit: "10" }] });
  });

  it("realtime options pass through unchanged", async () => {
    const service = new RealtimeAnalyticsService({
      getRealtimeGeoAnalytics: query("realtime-geo") as never,
    });
    await service.getRealtimeGeo("site-1", { withinMinutes: 15 });
    expect(calls[0]).toEqual({
      operation: "realtime-geo",
      args: ["site-1", { withinMinutes: 15 }],
    });
  });

  it("journey analysis is separate from realtime", async () => {
    const service = new VisitorJourneyAnalyticsService({
      getPathAnalysisAnalytics: query("path-analysis") as never,
    });
    await service.getPathAnalysis("site-1", { days: "7" });
    expect(calls[0]?.operation).toBe("path-analysis");
  });

  it("conversion reporting groups goals and revenue", async () => {
    const service = new ConversionAnalyticsService({
      getGoalsStats: query("goals") as never,
      getRevenueDashboard: query("revenue") as never,
    });
    await service.getGoals("site-1", {});
    await service.getRevenueDashboard("site-1", {});
    expect(calls.map((call) => call.operation)).toEqual(["goals", "revenue"]);
  });

  it("export has an isolated service capability", async () => {
    const service = new AnalyticsExportService(query("export") as never);
    await service.exportEvents("site-1", { days: "1" });
    expect(calls[0]?.operation).toBe("export");
  });
});

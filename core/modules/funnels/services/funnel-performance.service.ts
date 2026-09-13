import type { AnalyticsFunnelEvents } from "../../analytics/interfaces";
import type { FunnelPerformance, FunnelReport } from "../interfaces";
import { findFunnel } from "../repositories/funnel.repository";
import {
  buildFunnelReport,
  clampReportDays,
  reportWindow,
} from "./funnel-report-calculation.service";

/** Computes conversion performance from a definition and analytics-owned events. */
export class FunnelPerformanceService implements FunnelPerformance {
  constructor(private readonly analyticsEvents: AnalyticsFunnelEvents) {}

  async report(
    websiteId: string,
    funnelId: string,
    days?: number,
  ): Promise<FunnelReport | null> {
    const funnel = await findFunnel(websiteId, funnelId);
    if (!funnel) return null;
    const { startIso, endIso } = reportWindow(clampReportDays(days));
    const counts = await this.analyticsEvents.countFunnelStepVisitors(
      websiteId,
      funnelId,
      startIso,
      endIso,
    );
    return buildFunnelReport(funnel.steps, counts);
  }
}

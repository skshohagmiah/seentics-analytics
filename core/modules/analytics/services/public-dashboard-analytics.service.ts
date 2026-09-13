import type { WebsitePublicSharing } from "../../websites/interfaces";
import type { AnalyticsPublicDashboard, AnalyticsQueryParams } from "../interfaces";
import { getDashboardStats } from "../repositories/dashboard.repository";

/**
 * The unauthenticated public dashboard.
 *
 * A service rather than a repository, because its job is orchestration: turn a
 * share link into a site id, then delegate to the same dashboard query the
 * authenticated endpoint uses. It previously did the first half with its own
 * `SELECT … FROM websites`, which is exactly the kind of cross-module table read
 * that erases the boundary. It now goes through the websites module's
 * `WebsitePublicSharing` port instead.
 */
export class PublicDashboardService implements AnalyticsPublicDashboard {
  constructor(private readonly sharing: WebsitePublicSharing) {}

  /**
   * Dashboard figures for a share link, or `null` when the link is unknown or
   * revoked.
   *
   * `null` — not a throw — because the route turns it into a 404, and a revoked
   * link is an expected state rather than an error.
   */
  async getPublicDashboard(
    publicShareId: string,
    query: AnalyticsQueryParams,
  ): Promise<unknown | null> {
    const resolved = await this.sharing.resolvePublicShareId(publicShareId);
    if (!resolved) return null;

    return getDashboardStats(resolved.websiteId, query);
  }
}

import type { WebsiteQuery } from "../../websites/interfaces";
import type { HeatmapSettings, ResolvedWebsite } from "../interfaces";

/**
 * Turns a loose website reference into everything the heatmap paths need, once.
 *
 * This is the module's only door to the `websites` table. Before it, five separate
 * heatmap functions each called `resolveWebsiteIds` / `resolveWebsiteIdsLenient`
 * directly, one of them read `websites.url` with its own hand-written query, and
 * two more looked the same website up a second time through `getWebsiteBySiteId`
 * to recover a UUID they had already resolved. Routing all of it through the
 * injected `WebsiteQuery` port means the heatmaps module no longer reads another
 * module's table, and a request pays for resolution once.
 *
 * Kept as its own class rather than folded into `HeatmapService` so the screenshot
 * services can depend on resolution without depending on the read/write facade —
 * which is also what keeps the object graph acyclic, since the facade needs them.
 */
export class HeatmapSettingsService implements HeatmapSettings {
  constructor(private readonly websites: WebsiteQuery) {}

  async getCaptureTarget(
    websiteRef: string,
  ): Promise<(ResolvedWebsite & { layoutEnabled: boolean }) | null> {
    const website = await this.websites.getById(websiteRef);
    if (!website) return null;
    return {
      websiteId: website.id,
      siteUrl: website.url,
      layoutEnabled: website.heatmapLayoutEnabled,
    };
  }
}

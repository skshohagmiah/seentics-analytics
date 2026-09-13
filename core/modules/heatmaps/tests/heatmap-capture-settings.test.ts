import { describe, it, expect, beforeEach } from "bun:test";
import type { Website, WebsiteQuery, WebsiteRole } from "../../websites/interfaces";
import { HeatmapSettingsService } from "../services/heatmap-capture-settings.service";

const WEBSITE_UUID = "11111111-1111-4111-8111-111111111111";

function makeWebsite(overrides: Partial<Website> = {}): Website {
  return {
    id: WEBSITE_UUID,
    ownerId: "owner_1",
    name: "One",
    url: "one.example",
    trackingId: "ST-0001",
    isActive: true,
    isVerified: false,
    automationEnabled: true,
    funnelEnabled: true,
    heatmapEnabled: true,
    heatmapIncludePatterns: null,
    heatmapExcludePatterns: null,
    heatmapLayoutEnabled: true,
    replayEnabled: true,
    replaySamplingRate: 1,
    replayIncludePatterns: null,
    replayExcludePatterns: null,
    verificationToken: "tok",
    publicShareId: null,
    settings: {
      allowedOrigins: [],
      trackingEnabled: true,
      dataRetentionDays: 365,
      useIpAnonymization: false,
      respectDoNotTrack: false,
      allowRawDataExport: false,
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

class FakeWebsiteQuery implements WebsiteQuery {
  lookups: string[] = [];
  constructor(private readonly websites: Website[] = [makeWebsite()]) {}

  async getById(websiteRef: string): Promise<Website | null> {
    this.lookups.push(websiteRef);
    return this.websites.find((w) => w.id === websiteRef || w.id === websiteRef) ?? null;
  }
  async listOwnedBy(): Promise<Website[]> {
    return this.websites;
  }
  async getRole(): Promise<WebsiteRole | null> {
    return "owner";
  }
}

/**
 * This class is the heatmaps module's only door to the `websites` table. These
 * tests pin that: it must return every identifier the heatmap paths need from a
 * single lookup, so nothing downstream has a reason to resolve again.
 */
describe("HeatmapSettingsService", () => {
  let websites: FakeWebsiteQuery;
  let settings: HeatmapSettingsService;

  beforeEach(() => {
    websites = new FakeWebsiteQuery();
    settings = new HeatmapSettingsService(websites);
  });

  it("returns both identifiers plus the site url", async () => {
    const target = await settings.getCaptureTarget(WEBSITE_UUID);

    expect(target).toEqual({
      websiteId: WEBSITE_UUID,
      siteUrl: "one.example",
      layoutEnabled: true,
    });
  });

  // Both identifier forms must land on the same resolved pair — the dashboard uses
  // the UUID, the tracker uses the websiteId.
  it("performs exactly one lookup", async () => {
    await settings.getCaptureTarget(WEBSITE_UUID);
    expect(websites.lookups).toEqual([WEBSITE_UUID]);
  });

  it("reports null for an unknown website", async () => {
    expect(await settings.getCaptureTarget("missing")).toBeNull();
  });

  it("carries layoutEnabled through when capture is off", async () => {
    websites = new FakeWebsiteQuery([makeWebsite({ heatmapLayoutEnabled: false })]);
    settings = new HeatmapSettingsService(websites);

    expect((await settings.getCaptureTarget(WEBSITE_UUID))?.layoutEnabled).toBe(false);
  });

  // A blank `url` is why `HeatmapAutoCapture` has a pageview-scanning fallback.
  it("passes through a blank site url rather than substituting one", async () => {
    websites = new FakeWebsiteQuery([makeWebsite({ url: "" })]);
    settings = new HeatmapSettingsService(websites);

    expect((await settings.getCaptureTarget(WEBSITE_UUID))?.siteUrl).toBe("");
  });
});

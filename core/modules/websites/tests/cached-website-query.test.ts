import { describe, it, expect, beforeEach } from "bun:test";
import type {
  Website,
  WebsiteQuery,
  WebsiteRole,
} from "../../../modules/websites/interfaces";
import { CachedWebsiteQuery } from "../../../modules/websites/services/cached-website-query.service";

function makeWebsite(overrides: Partial<Website> = {}): Website {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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

/** Counts calls so tests can assert what actually reached the inner query. */
class CountingWebsiteQuery implements WebsiteQuery {
  getByIdCalls: string[] = [];
  listCalls: string[] = [];
  roleCalls: [string, string][] = [];

  constructor(private readonly websites: Website[] = []) {}

  async getById(websiteRef: string): Promise<Website | null> {
    this.getByIdCalls.push(websiteRef);
    return (
      this.websites.find((w) => w.id === websiteRef || w.id === websiteRef) ?? null
    );
  }

  async listOwnedBy(ownerId: string): Promise<Website[]> {
    this.listCalls.push(ownerId);
    return this.websites.filter((w) => w.ownerId === ownerId);
  }

  async getRole(websiteRef: string, userId: string): Promise<WebsiteRole | null> {
    this.roleCalls.push([websiteRef, userId]);
    const found = this.websites.find((w) => w.id === websiteRef || w.id === websiteRef);
    if (!found) return null;
    return found.ownerId === userId ? "owner" : null;
  }
}

describe("CachedWebsiteQuery", () => {
  const site = makeWebsite();
  let inner: CountingWebsiteQuery;
  let cached: CachedWebsiteQuery;

  beforeEach(() => {
    inner = new CountingWebsiteQuery([site]);
    cached = new CachedWebsiteQuery(inner);
  });

  describe("getById", () => {
    it("returns the website", async () => {
      expect(await cached.getById(site.id)).toEqual(site);
    });

    it("serves a repeat lookup from cache", async () => {
      await cached.getById(site.id);
      await cached.getById(site.id);

      expect(inner.getByIdCalls).toEqual([site.id]);
    });

    // The tracker addresses sites by websiteId while the dashboard uses the UUID.
    // Warming both keys means the second surface does not pay for a lookup the
    // first already did.
    it("warms the sibling identifier so either form hits cache", async () => {
      await cached.getById(site.id);
      await cached.getById(site.id);

      expect(inner.getByIdCalls).toEqual([site.id]);
    });

    it("warms the UUID when first asked by websiteId", async () => {
      await cached.getById(site.id);
      await cached.getById(site.id);

      expect(inner.getByIdCalls).toEqual([site.id]);
    });

    // A dashboard polling a deleted site would otherwise hit the database on
    // every request, forever.
    it("caches a negative result", async () => {
      expect(await cached.getById("missing")).toBeNull();
      expect(await cached.getById("missing")).toBeNull();

      expect(inner.getByIdCalls).toEqual(["missing"]);
    });

    it("re-reads once the entry expires", async () => {
      const shortLived = new CachedWebsiteQuery(inner, 5);

      await shortLived.getById(site.id);
      await new Promise((r) => setTimeout(r, 15));
      await shortLived.getById(site.id);

      expect(inner.getByIdCalls).toEqual([site.id, site.id]);
    });
  });

  describe("pass-through", () => {
    // The owned list changes whenever the user adds a site; caching it would show
    // them a stale dashboard immediately after creating one.
    it("does not cache listOwnedBy", async () => {
      await cached.listOwnedBy("owner_1");
      await cached.listOwnedBy("owner_1");

      expect(inner.listCalls).toEqual(["owner_1", "owner_1"]);
    });

    // The load-bearing one: caching a role would leave a removed collaborator
    // with access for the rest of the TTL.
    it("never caches getRole", async () => {
      await cached.getRole(site.id, "owner_1");
      await cached.getRole(site.id, "owner_1");
      await cached.getRole(site.id, "owner_1");

      expect(inner.roleCalls).toHaveLength(3);
    });

    it("returns the role unchanged", async () => {
      expect(await cached.getRole(site.id, "owner_1")).toBe("owner");
      expect(await cached.getRole(site.id, "stranger")).toBeNull();
    });
  });

  describe("invalidate", () => {
    it("forces a re-read for the given reference", async () => {
      await cached.getById(site.id);
      cached.invalidate(site.id);
      await cached.getById(site.id);

      expect(inner.getByIdCalls).toEqual([site.id, site.id]);
    });

    // Because both keys are warmed, invalidating one alone would leave the other
    // serving stale data — which is why bootstrap passes both ids.
    it("clears both identifiers when both are given", async () => {
      await cached.getById(site.id);
      await cached.getById(site.id);

      cached.invalidate(site.id, site.id);

      await cached.getById(site.id);
      expect(inner.getByIdCalls).toEqual([site.id, site.id]);
    });

    it("leaves other websites cached", async () => {
      const other = makeWebsite({ id: "other-id" });
      inner = new CountingWebsiteQuery([site, other]);
      cached = new CachedWebsiteQuery(inner);

      await cached.getById(site.id);
      await cached.getById(other.id);
      cached.invalidate(site.id);
      await cached.getById(other.id);

      expect(inner.getByIdCalls).toEqual([site.id, other.id]);
    });

    it("is a no-op for an unknown reference", async () => {
      expect(() => cached.invalidate("never-cached")).not.toThrow();
    });
  });

  describe("clear", () => {
    it("drops every entry", async () => {
      await cached.getById(site.id);
      cached.clear();
      await cached.getById(site.id);

      expect(inner.getByIdCalls).toEqual([site.id, site.id]);
    });
  });
});

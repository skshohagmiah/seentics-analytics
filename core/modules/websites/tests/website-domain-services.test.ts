import { describe, it, expect, beforeEach } from "bun:test";
import type {
  AnalyticsModule,
  TrafficSummary,
} from "../../../modules/analytics/interfaces";
import type {
  CreateWebsiteInput,
  UpdateWebsiteInput,
  Website,
  WebsiteRepository,
  WebsiteRole,
  WebsiteMutations,
  WebsiteQuery,
  WebsiteTrafficReads,
} from "../../../modules/websites/interfaces";
import { WebsiteMutationService } from "../../../modules/websites/services/website-mutation.service";
import { WebsitePublicSharingService } from "../../../modules/websites/services/website-public-sharing.service";
import { WebsiteQueryService } from "../../../modules/websites/services/website-query.service";
import { WebsiteTrafficService } from "../../../modules/websites/services/website-traffic.service";
import type { Logger } from "../../../platform/lib/logger";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

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

/**
 * In-memory `WebsiteRepository`. Exists to prove the service depends only on the
 * interface — no database is involved in any test in this file.
 */
class FakeWebsiteRepository implements WebsiteRepository {
  websites = new Map<string, Website>();
  roles = new Map<string, WebsiteRole>();
  deleted: string[] = [];
  updates: { websiteId: string; input: UpdateWebsiteInput }[] = [];

  seed(website: Website, role: WebsiteRole | null = "owner"): Website {
    this.websites.set(website.id, website);
    if (role) this.roles.set(`${website.id}:${website.ownerId}`, role);
    return website;
  }

  grant(websiteId: string, userId: string, role: WebsiteRole): void {
    this.roles.set(`${websiteId}:${userId}`, role);
  }

  async findById(websiteId: string): Promise<Website | null> {
    return this.websites.get(websiteId) ?? null;
  }

  async listOwnedBy(ownerId: string): Promise<Website[]> {
    return [...this.websites.values()]
      .filter((w) => w.ownerId === ownerId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findRole(websiteId: string, userId: string): Promise<WebsiteRole | null> {
    return this.roles.get(`${websiteId}:${userId}`) ?? null;
  }

  async findByPublicShareId(
    publicShareId: string,
  ): Promise<{ websiteId: string } | null> {
    const match = [...this.websites.values()].find((w) => w.publicShareId === publicShareId);
    return match ? { websiteId: match.id } : null;
  }

  async create(ownerId: string, input: CreateWebsiteInput): Promise<Website> {
    const created = makeWebsite({
      id: `id_${this.websites.size + 1}`,
      ownerId,
      name: input.name,
      url: input.url,
    });
    this.seed(created);
    return created;
  }

  async update(websiteId: string, input: UpdateWebsiteInput): Promise<Website | null> {
    this.updates.push({ websiteId, input });
    const existing = this.websites.get(websiteId);
    if (!existing) return null;
    const updated = { ...existing, ...input } as Website;
    this.websites.set(websiteId, updated);
    return updated;
  }

  async delete(websiteId: string): Promise<boolean> {
    this.deleted.push(websiteId);
    return this.websites.delete(websiteId);
  }

  async setPublicShareId(websiteId: string, shareId: string | null): Promise<string | null> {
    const existing = this.websites.get(websiteId);
    if (!existing) return null;
    this.websites.set(websiteId, { ...existing, publicShareId: shareId });
    return shareId;
  }
}

/**
 * Stands in for the analytics module.
 *
 * `WebsiteService` calls exactly one method on it, so the other six members of
 * `AnalyticsModule` are left off and the cast below narrows what the service is
 * actually allowed to touch. Stubbing them with throwing placeholders would be worse:
 * it would imply this test cares about them, and the cast is the honest statement that
 * it does not.
 */
class FakeAnalytics {
  summaries = new Map<string, TrafficSummary>();
  calls: string[][] = [];

  async getTrafficSummary(websiteIds: string[]): Promise<Map<string, TrafficSummary>> {
    this.calls.push(websiteIds);
    const out = new Map<string, TrafficSummary>();
    for (const id of websiteIds) {
      const found = this.summaries.get(id);
      if (found) out.set(id, found);
    }
    return out;
  }
}

/** The lazy handle `WebsiteService` takes, over a fake. */
function analyticsHandle(fake: FakeAnalytics): () => AnalyticsModule {
  return () => fake as Pick<AnalyticsModule, "getTrafficSummary"> as AnalyticsModule;
}

/** Records every invalidation, so tests can assert the cache is told about a change. */
function recordingInvalidator(): { onChanged: (websiteId: string) => void; invalidated: string[] } {
  const invalidated: string[] = [];
  return { onChanged: (websiteId) => invalidated.push(websiteId), invalidated };
}

describe("website domain services", () => {
  let repo: FakeWebsiteRepository;
  let traffic: FakeAnalytics;
  let invalidated: string[];
  let service: WebsiteQuery & WebsiteTrafficReads & WebsiteMutations;

  beforeEach(() => {
    repo = new FakeWebsiteRepository();
    traffic = new FakeAnalytics();
    const rec = recordingInvalidator();
    invalidated = rec.invalidated;
    const query = new WebsiteQueryService(repo);
    const trafficReads = new WebsiteTrafficService(repo, analyticsHandle(traffic));
    const mutations = new WebsiteMutationService(repo, rec.onChanged);
    const sharing = new WebsitePublicSharingService(repo, rec.onChanged);
    service = {
      getById: query.getById.bind(query),
      listOwnedBy: query.listOwnedBy.bind(query),
      getRole: query.getRole.bind(query),
      listOwnedWithTraffic: trafficReads.listOwnedWithTraffic.bind(trafficReads),
      getWithTraffic: trafficReads.getWithTraffic.bind(trafficReads),
      create: mutations.create.bind(mutations),
      update: mutations.update.bind(mutations),
      delete: mutations.delete.bind(mutations),
      setPublicSharing: sharing.setPublicSharing.bind(sharing),
    };
  });

  describe("getById", () => {
    it("returns the website for its id", async () => {
      const site = repo.seed(makeWebsite());
      expect(await service.getById(site.id)).toEqual(site);
    });

    it("returns null for an unknown reference", async () => {
      expect(await service.getById("nope")).toBeNull();
    });
  });

  describe("getRole", () => {
    it("reports owner", async () => {
      const site = repo.seed(makeWebsite());
      expect(await service.getRole(site.id, "owner_1")).toBe("owner");
    });

    it("reports member", async () => {
      const site = repo.seed(makeWebsite());
      repo.grant(site.id, "user_2", "member");
      expect(await service.getRole(site.id, "user_2")).toBe("member");
    });

    it("returns null for a stranger", async () => {
      const site = repo.seed(makeWebsite());
      expect(await service.getRole(site.id, "stranger")).toBeNull();
    });

    it("returns null for an unknown website", async () => {
      expect(await service.getRole("missing", "owner_1")).toBeNull();
    });
  });

  describe("create", () => {
    it("returns the created website", async () => {
      const created = await service.create("owner_9", { name: "New", url: "new.example" });
      expect(created.ownerId).toBe("owner_9");
      expect(created.name).toBe("New");
    });

    /** Nothing is cached for a website that did not exist a moment ago. */
    it("does not invalidate anything on create", async () => {
      await service.create("owner_9", { name: "New", url: "new.example" });
      expect(invalidated).toEqual([]);
    });
  });

  describe("listOwnedWithTraffic", () => {
    it("returns an empty list without asking for traffic", async () => {
      expect(await service.listOwnedWithTraffic("owner_1")).toEqual([]);
      expect(traffic.calls).toEqual([]);
    });

    // The N+1 guard: one batched call regardless of how many sites are owned.
    it("requests traffic for every site in a single call", async () => {
      repo.seed(makeWebsite({ id: "a", ownerId: "owner_1" }));
      repo.seed(makeWebsite({ id: "b", ownerId: "owner_1" }));
      repo.seed(makeWebsite({ id: "c", ownerId: "owner_1" }));

      await service.listOwnedWithTraffic("owner_1");

      expect(traffic.calls).toHaveLength(1);
      expect(traffic.calls[0]).toEqual(["a", "b", "c"]);
    });

    it("attaches the matching summary to each site", async () => {
      repo.seed(makeWebsite({ id: "a", ownerId: "owner_1" }));
      traffic.summaries.set("a", {
        totalPageviews: 42,
        uniqueVisitors: 7,
        averageSessionDuration: 0,
        bounceRate: 0,
      });

      const [first] = await service.listOwnedWithTraffic("owner_1");
      expect(first?.traffic.totalPageviews).toBe(42);
      expect(first?.traffic.uniqueVisitors).toBe(7);
    });

    // Absence of traffic is normal for a new site, not an error.
    it("falls back to zeros for a site with no traffic", async () => {
      repo.seed(makeWebsite({ id: "a", ownerId: "owner_1" }));

      const [first] = await service.listOwnedWithTraffic("owner_1");
      expect(first?.traffic).toEqual({
        totalPageviews: 0,
        uniqueVisitors: 0,
        averageSessionDuration: 0,
        bounceRate: 0,
      });
    });

    it("excludes websites owned by others", async () => {
      repo.seed(makeWebsite({ id: "a", ownerId: "owner_1" }));
      repo.seed(makeWebsite({ id: "b", ownerId: "owner_2" }));

      const result = await service.listOwnedWithTraffic("owner_1");
      expect(result.map((w) => w.id)).toEqual(["a"]);
    });
  });

  describe("public sharing", () => {
    it("assigns a share id when enabled", async () => {
      const site = repo.seed(makeWebsite());
      const shareId = await service.setPublicSharing(site.id, true);

      expect(shareId).toBeTruthy();
      expect((await repo.findById(site.id))?.publicShareId).toBe(shareId!);
    });

    // Re-enabling must not mint a new id — any link already shared would break.
    it("reuses an existing share id", async () => {
      const site = repo.seed(makeWebsite({ publicShareId: "existing_share" }));
      const shareId = await service.setPublicSharing(site.id, true);
      expect(shareId).toBe("existing_share");
    });

    it("clears the share id when disabled", async () => {
      const site = repo.seed(makeWebsite({ publicShareId: "existing_share" }));
      const result = await service.setPublicSharing(site.id, false);

      expect(result).toBeNull();
      expect((await repo.findById(site.id))?.publicShareId).toBeNull();
    });

    /**
     * The cached view carries `publicShareId`, so toggling sharing without telling the
     * cache leaves the share link resolving against a stale row until the TTL expires.
     */
    it("invalidates the cached website when sharing is toggled", async () => {
      const site = repo.seed(makeWebsite());
      await service.setPublicSharing(site.id, true);

      expect(invalidated).toEqual([site.id]);
    });

  });

  describe("update", () => {
    it("passes the patch through to the repository", async () => {
      const site = repo.seed(makeWebsite());
      await service.update(site.id, { name: "Renamed" });

      expect(repo.updates).toEqual([{ websiteId: site.id, input: { name: "Renamed" } }]);
    });

    // `null` clears a pattern while `undefined` leaves it alone — the service
    // must not normalise one into the other on the way down.
    it("preserves an explicit null for clearing a pattern", async () => {
      const site = repo.seed(makeWebsite({ heatmapIncludePatterns: "/docs/*" }));
      await service.update(site.id, { heatmapIncludePatterns: null });

      expect(repo.updates[0]?.input).toEqual({ heatmapIncludePatterns: null });
    });

    it("returns null for an unknown reference", async () => {
      expect(await service.update("missing", { name: "x" })).toBeNull();
    });
  });
});

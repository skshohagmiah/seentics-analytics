import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import type {
  WebsitePrivacySettings,
  WebsitePrivacySettingsService,
  WebsiteQuery,
  WebsiteRole,
} from "../interfaces";
import {
  getWebsitePrivacy,
  updateWebsitePrivacy,
} from "../controllers/website-privacy.controller";
import type { WebsiteControllerDeps } from "../controllers/website-controller.types";

const WEBSITE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const stored: WebsitePrivacySettings = {
  ipAnonymization: "partial",
  respectDnt: true,
  consentMode: "strict",
  dataRetentionDays: 90,
};

describe("website privacy controller boundary", () => {
  let role: WebsiteRole | null;
  let reads: string[];
  let writes: Array<{
    websiteId: string;
    ownerUserId: string;
    settings: WebsitePrivacySettings;
  }>;
  let app: Hono<{ Variables: AuthVars }>;

  beforeEach(() => {
    role = "owner";
    reads = [];
    writes = [];

    const websites = {
      async getRole(): Promise<WebsiteRole | null> {
        return role;
      },
    } as Pick<WebsiteQuery, "getRole">;
    const privacy: WebsitePrivacySettingsService = {
      async get(websiteId) {
        reads.push(websiteId);
        return stored;
      },
      async save(websiteId, ownerUserId, settings) {
        writes.push({ websiteId, ownerUserId, settings });
        return settings;
      },
    };
    const deps = { websites, privacy } as unknown as WebsiteControllerDeps;

    app = new Hono<{ Variables: AuthVars }>();
    app.use("*", async (c, next) => {
      const userId = c.req.header("X-Test-User");
      if (userId) c.set("userId", userId);
      return next();
    });
    app.get("/:websiteId/privacy", getWebsitePrivacy(deps));
    app.put("/:websiteId/privacy", updateWebsitePrivacy(deps));
  });

  it("rejects an unauthenticated request before calling the service", async () => {
    const response = await app.request(`/${WEBSITE_ID}/privacy`);
    expect(response.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it("requires the owner role before reading settings", async () => {
    role = "admin";
    const response = await app.request(`/${WEBSITE_ID}/privacy`, {
      headers: { "X-Test-User": USER_ID },
    });
    expect(response.status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("calls the privacy service with an already-authorized website id", async () => {
    const response = await app.request(`/${WEBSITE_ID}/privacy`, {
      headers: { "X-Test-User": USER_ID },
    });
    expect(response.status).toBe(200);
    expect(reads).toEqual([WEBSITE_ID]);
    expect(await response.json()).toEqual({ success: true, data: stored });
  });

  it("validates updates in the controller before calling the service", async () => {
    const response = await app.request(`/${WEBSITE_ID}/privacy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_ID },
      body: JSON.stringify({ dataRetentionDays: 0 }),
    });
    expect(response.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it("passes validated settings and the authorized owner to the service", async () => {
    const response = await app.request(`/${WEBSITE_ID}/privacy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_ID },
      body: JSON.stringify({ respectDnt: true }),
    });
    expect(response.status).toBe(200);
    expect(writes).toEqual([{
      websiteId: WEBSITE_ID,
      ownerUserId: USER_ID,
      settings: {
        ipAnonymization: "none",
        respectDnt: true,
        consentMode: "cookieless",
        dataRetentionDays: null,
      },
    }]);
  });
});

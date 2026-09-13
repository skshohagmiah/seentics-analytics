import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context, Next } from "hono";
import type { Website, WebsiteQuery, WebsiteRole } from "../../websites/interfaces";
import type { RecordingDetail, RecordingSummary, SessionListFilters } from "../interfaces";

/**
 * The recordings HTTP surface.
 *
 * Two things here are load-bearing beyond the usual guard checks. `/batch` is registered
 * before `/:session_id`, so the route table's *order* is behaviour — swap them and
 * "batch" becomes a session id. And read access is no longer sufficient to delete: these
 * recordings replay what a real visitor did on screen, and a collaborator invited as a
 * viewer used to be able to destroy them permanently, because the guard only asked
 * whether the caller had any access at all.
 */

mock.module("../../../platform/middleware/auth", () => ({
  authMiddleware: async (c: Context<{ Variables: { userId: string } }>, next: Next) => {
    const userId = c.req.header("X-Test-User");
    if (!userId) return c.json({ error: "Authorization required" }, 401);
    c.set("userId", userId);
    return next();
  },
  requireUser: (c: Context<{ Variables: { userId: string } }>) => c.get("userId") ?? null,
}));

const { createRecordingRoutes } = await import("../routes");

const WEBSITE = "11111111-1111-4111-8111-111111111111";
const SESSION = "sess_1";

/** One user per role the repository can now report. */
const USERS: Record<string, WebsiteRole> = {
  u_owner: "owner",
  u_admin: "admin",
  u_member: "member",
  u_viewer: "viewer",
};

class FakeWebsites implements WebsiteQuery {
  async getById(): Promise<Website | null> {
    return { id: WEBSITE } as Website;
  }
  async listOwnedBy(): Promise<Website[]> {
    return [];
  }
  async getRole(websiteRef: string, userId: string): Promise<WebsiteRole | null> {
    if (websiteRef !== WEBSITE) return null;
    return USERS[userId] ?? null;
  }
}

const summary: RecordingSummary = {
  sessionId: SESSION,
  websiteId: WEBSITE,
  browser: "Chrome",
  device: "Desktop",
  os: "macOS",
  country: "BD",
  entryPage: "https://x.test/",
  startedAt: new Date().toISOString(),
  hasRageClicks: false,
  hasErrors: false,
  durationSeconds: 12,
  pagesViewed: 2,
};

let listCalls: { limit: number; offset: number; filters?: SessionListFilters }[] = [];
let deleteCalls: string[][] = [];
let deleteThrows = false;

const recordings = {
  async listSessions(_ref: string, limit: number, offset: number, filters?: SessionListFilters) {
    listCalls.push({ limit, offset, filters });
    return {
      sessions: [summary],
      limit,
      offset,
      total: 137,
      summary: { total: 137, withErrors: 9, withRageClicks: 4, avgDurationSeconds: 42 },
    };
  },
  async getSessionDetail(): Promise<RecordingDetail> {
    return {
      status: 200,
      body: { session_id: SESSION, meta: null, recording_pending: true },
    } as RecordingDetail;
  },
  async batchDelete(_ref: string, ids: string[]) {
    if (deleteThrows) throw new Error("storage down");
    deleteCalls.push(ids);
  },
};

function app() {
  return createRecordingRoutes({
    recordingList: recordings,
    recordingDetails: recordings,
    recordingDeletion: recordings,
    websites: new FakeWebsites(),
  });
}

function get(path: string, user?: string) {
  return app().request(path, { headers: user ? { "X-Test-User": user } : {} });
}

function del(path: string, user: string | undefined, body: unknown) {
  return app().request(path, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "X-Test-User": user } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("recording routes", () => {
  beforeEach(() => {
    listCalls = [];
    deleteCalls = [];
    deleteThrows = false;
  });

  describe("access", () => {
    it("rejects an unauthenticated read", async () => {
      expect((await get(`/${WEBSITE}`)).status).toBe(401);
    });

    it("rejects a user with no access", async () => {
      expect((await get(`/${WEBSITE}`, "u_stranger")).status).toBe(403);
    });

    /** Same answer for a site that does not exist, so ids cannot be probed. */
    it("answers 403 for an unknown website rather than 404", async () => {
      const res = await get("/33333333-3333-4333-8333-333333333333", "u_owner");
      expect(res.status).toBe(403);
    });

    it.each(["u_owner", "u_admin", "u_member", "u_viewer"])("lets %s read the list", async (user) => {
      expect((await get(`/${WEBSITE}`, user)).status).toBe(200);
    });

    it("lets a viewer watch a recording", async () => {
      expect((await get(`/${WEBSITE}/${SESSION}`, "u_viewer")).status).toBe(200);
    });
  });

  describe("delete permission", () => {
    it.each(["u_owner", "u_admin", "u_member"])("lets %s delete", async (user) => {
      const res = await del(`/${WEBSITE}/batch`, user, { sessionIds: [SESSION] });
      expect(res.status).toBe(200);
      expect(deleteCalls).toEqual([[SESSION]]);
    });

    it("refuses a viewer", async () => {
      const res = await del(`/${WEBSITE}/batch`, "u_viewer", { sessionIds: [SESSION] });
      expect(res.status).toBe(403);
    });

    it("does not reach the service when it refuses a viewer", async () => {
      await del(`/${WEBSITE}/batch`, "u_viewer", { sessionIds: [SESSION] });
      expect(deleteCalls).toEqual([]);
    });

    it("says why, so the refusal is not mistaken for a lost session", async () => {
      const res = await del(`/${WEBSITE}/batch`, "u_viewer", { sessionIds: [SESSION] });
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("role") });
    });

    it("still refuses a stranger before checking the role", async () => {
      const res = await del(`/${WEBSITE}/batch`, "u_stranger", { sessionIds: [SESSION] });
      expect(res.status).toBe(403);
    });

    it("reports a storage failure as a 500 without leaking detail", async () => {
      deleteThrows = true;
      const res = await del(`/${WEBSITE}/batch`, "u_owner", { sessionIds: [SESSION] });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to delete sessions" });
    });

    it("rejects an empty id list", async () => {
      const res = await del(`/${WEBSITE}/batch`, "u_owner", { sessionIds: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("routing order", () => {
    /** `batch` must not be captured as a session id by `/:website_id/:session_id`. */
    it("treats /batch as the batch route, not a session", async () => {
      const res = await del(`/${WEBSITE}/batch`, "u_owner", { sessionIds: [SESSION] });
      expect(res.status).toBe(200);
    });
  });

  describe("list query", () => {
    it("returns the total alongside the page", async () => {
      const res = await get(`/${WEBSITE}?limit=1`, "u_owner");
      expect(await res.json()).toMatchObject({ total: 137, limit: 1 });
    });

    /** The headline figures are aggregates over the filtered set, not over the page. */
    it("returns whole-set totals, not page-derived ones", async () => {
      const res = await get(`/${WEBSITE}?limit=1`, "u_owner");
      expect(await res.json()).toMatchObject({
        summary: { withErrors: 9, withRageClicks: 4, avgDurationSeconds: 42 },
      });
    });

    it("defaults to a bounded page", async () => {
      await get(`/${WEBSITE}`, "u_owner");
      expect(listCalls[0]).toMatchObject({ limit: 20, offset: 0 });
    });

    it("passes paging through", async () => {
      await get(`/${WEBSITE}?limit=50&offset=100`, "u_owner");
      expect(listCalls[0]).toMatchObject({ limit: 50, offset: 100 });
    });

    it("rejects a limit past the cap rather than honouring it", async () => {
      expect((await get(`/${WEBSITE}?limit=5000`, "u_owner")).status).toBe(400);
    });

    it("passes filters to the service instead of leaving them to the client", async () => {
      await get(`/${WEBSITE}?search=chrome&device=mobile&has_errors=1`, "u_owner");
      expect(listCalls[0]!.filters).toMatchObject({
        search: "chrome",
        device: "mobile",
        hasErrors: true,
      });
    });

    it("reads has_rage_clicks=true as well as =1", async () => {
      await get(`/${WEBSITE}?has_rage_clicks=true`, "u_owner");
      expect(listCalls[0]!.filters).toMatchObject({ hasRageClicks: true });
    });

    /** Absent and explicitly-off must both mean "do not filter", not "must be false". */
    it("treats has_errors=0 as no filter at all", async () => {
      await get(`/${WEBSITE}?has_errors=0`, "u_owner");
      expect(listCalls[0]!.filters?.hasErrors).toBeUndefined();
    });

    it("rejects an unknown device class", async () => {
      expect((await get(`/${WEBSITE}?device=fridge`, "u_owner")).status).toBe(400);
    });
  });

  describe("detail", () => {
    it("passes the service's status straight through", async () => {
      const res = await get(`/${WEBSITE}/${SESSION}`, "u_owner");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ recording_pending: true });
    });
  });
});

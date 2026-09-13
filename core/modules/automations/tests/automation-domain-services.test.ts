import { describe, it, expect, beforeEach } from "bun:test";
import type {
  AutomationDailyRuns,
  AutomationExecutionRow,
  AutomationCrud,
  AutomationInsights,
  AutomationListItem,
  AutomationRepository,
  AutomationRow,
  AutomationStats,
  AutomationTrackerSettings,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "../interfaces";
import { AutomationCrudService } from "../services/automation-crud.service";
import { AutomationInsightService } from "../services/automation-insight.service";
import { TrackerAutomationSettingsService } from "../services/tracker-automation-settings.service";

const WEBSITE_UUID = "11111111-1111-4111-8111-111111111111";
function makeRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: "auto_1",
    name: "Welcome",
    isActive: true,
    ...overrides,
  } as AutomationRow;
}

/**
 * In-memory repository that records the website id it was handed for every call.
 *
 * That recording is the point of most tests here: `automations.website_id` is a
 * uuid column, so a `websiteId` reaching it matches zero rows *without erroring* and
 * looks exactly like "this website has no automations".
 */
class FakeAutomationRepository implements AutomationRepository {
  receivedWebsiteIds: string[] = [];
  rows: AutomationRow[] = [];
  deleted: [string, string][] = [];
  executions: AutomationExecutionRow[] = [];

  private record(websiteId: string) {
    this.receivedWebsiteIds.push(websiteId);
  }

  async listWithStats(websiteId: string): Promise<AutomationListItem[]> {
    this.record(websiteId);
    return this.rows as unknown as AutomationListItem[];
  }
  async listActive(websiteId: string): Promise<AutomationRow[]> {
    this.record(websiteId);
    return this.rows.filter((r) => r.isActive);
  }
  async listActiveByPriority(websiteId: string): Promise<AutomationRow[]> {
    this.record(websiteId);
    return this.rows.filter((r) => r.isActive);
  }
  async findById(websiteId: string, automationId: string): Promise<AutomationRow | null> {
    this.record(websiteId);
    return this.rows.find((r) => r.id === automationId) ?? null;
  }
  async create(
    websiteId: string,
    _userId: string,
    input: CreateAutomationInput,
  ): Promise<AutomationRow> {
    this.record(websiteId);
    const row = makeRow({ id: `auto_${this.rows.length + 1}`, name: input.name });
    this.rows.push(row);
    return row;
  }
  async update(
    websiteId: string,
    automationId: string,
    _patch: UpdateAutomationInput,
  ): Promise<AutomationRow | null> {
    this.record(websiteId);
    return this.rows.find((r) => r.id === automationId) ?? null;
  }
  async toggleActive(websiteId: string, automationId: string): Promise<AutomationRow | null> {
    this.record(websiteId);
    const row = this.rows.find((r) => r.id === automationId);
    if (!row) return null;
    row.isActive = !row.isActive;
    return row;
  }
  async delete(websiteId: string, automationId: string): Promise<void> {
    await this.deleteMany(websiteId, [automationId]);
  }
  /** Counts calls, so a test can tell one batched delete from a loop of them. */
  deleteManyCalls = 0;
  async deleteMany(websiteId: string, automationIds: string[]): Promise<void> {
    this.deleteManyCalls += 1;
    this.record(websiteId);
    for (const id of automationIds) this.deleted.push([websiteId, id]);
    // Scoped like the real one: another website's id matches nothing.
    this.rows = this.rows.filter(
      (r) => !(automationIds.includes(r.id) && r.websiteId === websiteId),
    );
  }
  async listExecutions(automationId: string, limit: number): Promise<AutomationExecutionRow[]> {
    return this.executions.filter((e) => e.automationId === automationId).slice(0, limit);
  }
  async getStats(_automationId: string): Promise<AutomationStats> {
    return { totalRuns: 3 } as unknown as AutomationStats;
  }
  async getDailyRuns(_automationId: string): Promise<AutomationDailyRuns[]> {
    return [] as unknown as AutomationDailyRuns[];
  }
}

describe("automation domain services", () => {
  let repo: FakeAutomationRepository;
  let service: AutomationCrud & AutomationInsights & AutomationTrackerSettings;

  beforeEach(() => {
    repo = new FakeAutomationRepository();
    const crud = new AutomationCrudService(repo);
    const insights = new AutomationInsightService(repo);
    const tracker = new TrackerAutomationSettingsService(repo);
    service = {
      list: crud.list.bind(crud),
      create: crud.create.bind(crud),
      get: crud.get.bind(crud),
      update: crud.update.bind(crud),
      remove: crud.remove.bind(crud),
      bulkDelete: crud.bulkDelete.bind(crud),
      toggle: crud.toggle.bind(crud),
      executions: insights.executions.bind(insights),
      stats: insights.stats.bind(insights),
      dailyStats: insights.dailyStats.bind(insights),
      activeFor: tracker.activeFor.bind(tracker),
    };
  });

  /**
   * This block used to assert that a short public id was translated to the UUID before
   * reaching the repository — `automations.website_id` is a uuid column, and the wrong
   * predicate against it silently matched nothing. There is only one identifier now, so
   * what is left to prove is that the service passes it through untouched: no
   * translation, and none needed.
   */
  describe("identifier routing", () => {
    it("passes the caller's website id to the repository unchanged", async () => {
      await service.list(WEBSITE_UUID);
      expect(repo.receivedWebsiteIds).toEqual([WEBSITE_UUID]);
    });

    it("passes it through on a write too", async () => {
      await service.create(WEBSITE_UUID, "owner_1", { name: "New" } as CreateAutomationInput);
      expect(repo.receivedWebsiteIds).toEqual([WEBSITE_UUID]);
    });

    it("scopes a delete to that same id", async () => {
      repo.rows.push(makeRow());
      await service.remove(WEBSITE_UUID, "auto_1");
      expect(repo.deleted).toEqual([[WEBSITE_UUID, "auto_1"]]);
    });
  });

  /**
   * `automation_events` has no website column — it is keyed by `automation_id`
   * alone. Without the ownership check first, anyone able to read one website's
   * automations could read any automation's execution log by guessing a UUID.
   */
  describe("cross-website isolation on insight reads", () => {
    it("refuses executions for an automation that is not this website's", async () => {
      repo.executions.push({ automationId: "someone_elses" } as AutomationExecutionRow);

      expect(await service.executions(WEBSITE_UUID, "someone_elses")).toBeNull();
    });

    it("refuses stats for an automation that is not this website's", async () => {
      expect(await service.stats(WEBSITE_UUID, "someone_elses")).toBeNull();
    });

    it("refuses daily stats for an automation that is not this website's", async () => {
      expect(await service.dailyStats(WEBSITE_UUID, "someone_elses")).toBeNull();
    });

    it("allows them once the automation belongs to the website", async () => {
      repo.rows.push(makeRow());
      expect(await service.stats(WEBSITE_UUID, "auto_1")).not.toBeNull();
    });
  });

  describe("bulkDelete", () => {
    it("deletes every id under the resolved website", async () => {
      repo.rows.push(makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" }));

      await service.bulkDelete(WEBSITE_UUID, ["a", "b", "c"]);

      expect(repo.deleted).toEqual([
        [WEBSITE_UUID, "a"],
        [WEBSITE_UUID, "b"],
        [WEBSITE_UUID, "c"],
      ]);
    });

    /**
     * One repository call for the batch.
     *
     * This used to loop, and each iteration cost two statements — so clearing fifty
     * automations was a hundred round trips. The count is asserted rather than the
     * timing because that is what the loop actually cost.
     */
    it("hands the whole batch to the repository in one call", async () => {
      repo.rows.push(makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" }));

      await service.bulkDelete(WEBSITE_UUID, ["a", "b", "c"]);

      expect(repo.deleteManyCalls).toBe(1);
    });

    it("does not call the repository for an empty list", async () => {
      await service.bulkDelete(WEBSITE_UUID, []);
      expect(repo.deleteManyCalls).toBe(0);
      expect(repo.deleted).toEqual([]);
    });

    /**
     * An id belonging to another website must delete nothing.
     *
     * The route guard checks access to the *website*, not to each automation, so this is
     * the only thing standing between a caller and another tenant's rows. The real
     * enforcement is in `deleteMany`'s SQL, which scopes the event delete through the
     * parent automation rather than by `automation_id` alone — before that, passing a
     * foreign id destroyed that automation's event history while its row survived.
     */
    it("leaves an automation belonging to another website alone", async () => {
      repo.rows.push(
        makeRow({ id: "mine", websiteId: WEBSITE_UUID } as Partial<AutomationRow>),
        makeRow({ id: "theirs", websiteId: "someone-elses-website" } as Partial<AutomationRow>),
      );

      await service.bulkDelete(WEBSITE_UUID, ["mine", "theirs"]);

      expect(repo.rows.map((r) => r.id)).toEqual(["theirs"]);
    });

    // The endpoint answers 204 whether it removed all or none, so one already-gone
    // id must not abort the rest.
    it("continues past an id that no longer exists", async () => {
      repo.rows.push(makeRow({ id: "b" }));

      await service.bulkDelete(WEBSITE_UUID, ["missing", "b"]);

      expect(repo.deleted.map(([, id]) => id)).toEqual(["missing", "b"]);
    });

    it("accepts an empty batch without touching the repository", async () => {
      await service.bulkDelete(WEBSITE_UUID, []);
      expect(repo.deleted).toEqual([]);
    });
  });

  describe("toggle", () => {
    it("flips the active flag", async () => {
      repo.rows.push(makeRow({ isActive: true }));

      const toggled = await service.toggle(WEBSITE_UUID, "auto_1");
      expect(toggled?.isActive).toBe(false);
    });

    it("returns null for an unknown automation", async () => {
      expect(await service.toggle(WEBSITE_UUID, "nope")).toBeNull();
    });
  });

  describe("activeFor", () => {
    it("returns only active automations", async () => {
      repo.rows.push(makeRow({ id: "on", isActive: true }), makeRow({ id: "off", isActive: false }));

      const active = await service.activeFor(WEBSITE_UUID);
      expect(active.map((a) => a.id)).toEqual(["on"]);
    });
  });
});

import { beforeEach, describe, expect, it } from "bun:test";
import { AIDailyLimitError } from "../interfaces";
import { NaturalLanguageQueryService } from "../services/natural-language-query.service";
import type { AiRepository, AiSuccessRecord } from "../interfaces/ai-repository.interface";
import type { LlmClient, LlmCompletion } from "../interfaces/llm-client.interface";
import type { AIHistoryItem } from "../interfaces/ai-query.types";

/**
 * The guarded pipeline around the model.
 *
 * None of this was reachable in a test before `AiRepository` and `LlmClient` existed:
 * the only way in was a real OpenAI call followed by a real database query. What that
 * hid is the interesting half — the response cache, the rolling daily cap, and what
 * happens when the model returns SQL the validator refuses.
 *
 * The last of those is the one that matters most. A refused statement must never reach
 * `runGuarded`, and the attempt must still be recorded as a failure, because the record
 * is what the cap counts.
 */

const SITE = "11111111-1111-1111-1111-111111111111";
const USER = "user-1";

/** A well-formed model response for the analytics domain. */
function goodResponse(sql = "SELECT path FROM analytics_events WHERE website_id = $1 LIMIT 10") {
  return JSON.stringify({
    sql,
    viz_type: "table",
    title: "Top pages",
    insight: "Traffic is concentrated on a few paths.",
    tips: ["• one", "• two"],
    x_key: null,
    y_key: null,
    columns: [{ key: "path", label: "Path" }],
  });
}

class FakeRepo implements AiRepository {
  guardedCalls: Array<{ sql: string; boundId: string }> = [];
  succeeded: Array<{ id: string; record: AiSuccessRecord }> = [];
  failed: Array<{ id: string; errorMessage: string }> = [];
  pendingCreated = 0;

  rows: Record<string, unknown>[] = [{ path: "/pricing" }];
  queriesInWindow = 0;
  guardedThrows: Error | null = null;

  async runGuarded(sql: string, boundId: string) {
    this.guardedCalls.push({ sql, boundId });
    if (this.guardedThrows) throw this.guardedThrows;
    return this.rows;
  }

  async countQueriesSince(): Promise<number> {
    return this.queriesInWindow;
  }

  async createPending(): Promise<string | null> {
    this.pendingCreated++;
    return `query-${this.pendingCreated}`;
  }

  async markSuccess(id: string, record: AiSuccessRecord) {
    this.succeeded.push({ id, record });
  }

  async markFailure(id: string, record: { errorMessage: string; executionTimeMs: number }) {
    this.failed.push({ id, errorMessage: record.errorMessage });
  }

  async history(): Promise<AIHistoryItem[]> {
    return [];
  }

  async countSuccessfulSince(): Promise<number> {
    return 0;
  }
}

class FakeLlm implements LlmClient {
  completeCalls = 0;
  classifyCalls = 0;
  content = goodResponse();
  domain = "analytics";
  completeThrows: Error | null = null;

  async complete(): Promise<LlmCompletion> {
    this.completeCalls++;
    if (this.completeThrows) throw this.completeThrows;
    return { content: this.content, inputTokens: 100, outputTokens: 50 };
  }

  async classify(): Promise<string> {
    this.classifyCalls++;
    return this.domain;
  }
}

let repo: FakeRepo;
let llm: FakeLlm;
let runner: NaturalLanguageQueryService;

beforeEach(() => {
  repo = new FakeRepo();
  llm = new FakeLlm();
  runner = new NaturalLanguageQueryService(repo, llm);
});

describe("a successful question", () => {
  it("returns the rows the statement produced", async () => {
    const result = await runner.run(USER, SITE, "top pages", "analytics");
    expect(result.rows).toEqual([{ path: "/pricing" }]);
    expect(result.title).toBe("Top pages");
  });

  it("records the attempt before answering it", async () => {
    await runner.run(USER, SITE, "top pages", "analytics");
    expect(repo.pendingCreated).toBe(1);
    expect(repo.succeeded).toHaveLength(1);
    expect(repo.failed).toHaveLength(0);
  });

  it("reports token cost", async () => {
    const result = await runner.run(USER, SITE, "top pages", "analytics");
    expect(result.tokens).toEqual({ input: 100, output: 50 });
    expect(result.estimated_cost_usd).toBeGreaterThan(0);
  });

  it("derives columns from the first row when the model names none", async () => {
    llm.content = JSON.stringify({
      sql: "SELECT path FROM analytics_events WHERE website_id = $1 LIMIT 10",
      viz_type: "table",
      title: "T",
      insight: "",
      tips: "",
      x_key: null,
      y_key: null,
      columns: [],
    });
    repo.rows = [{ page_path: "/a" }];

    const result = await runner.run(USER, SITE, "q", "analytics");
    expect(result.columns).toEqual([{ key: "page_path", label: "Page Path" }]);
  });
});

describe("the id bound to the statement", () => {
  /**
   * There is one website id now. This used to be two tests asserting that analytics
   * bound the legacy `website_id` while funnels bound the `uuid` — a branch that chose
   * between two identical strings, left over from a `websites.site_id` column that no
   * longer exists.
   */
  it("binds the resolved website id", async () => {
    await runner.run(USER, SITE, "q", "analytics");
    expect(repo.guardedCalls[0]!.boundId).toBe(SITE);
  });

  it("binds the same id whichever domain answers", async () => {
    llm.content = goodResponse("SELECT name FROM funnels WHERE website_id = $1::uuid LIMIT 10");
    await runner.run(USER, SITE, "q", "funnels");
    expect(repo.guardedCalls[0]!.boundId).toBe(SITE);
  });
});

describe("SQL the validator refuses", () => {
  const REFUSED = "SELECT path FROM analytics_events WHERE website_id != $1 LIMIT 10";

  beforeEach(() => {
    llm.content = goodResponse(REFUSED);
  });

  it("never reaches the database", async () => {
    await runner.run(USER, SITE, "q", "analytics").catch(() => {});
    expect(repo.guardedCalls).toHaveLength(0);
  });

  it("surfaces as an error", async () => {
    expect(runner.run(USER, SITE, "q", "analytics")).rejects.toThrow("Unsafe SQL");
  });

  it("is still recorded, so it counts against the cap", async () => {
    await runner.run(USER, SITE, "q", "analytics").catch(() => {});
    expect(repo.failed).toHaveLength(1);
    expect(repo.failed[0]!.errorMessage).toContain("Unsafe SQL");
  });

  it("is not cached — a refusal must not be replayed as an answer", async () => {
    await runner.run(USER, SITE, "q", "analytics").catch(() => {});
    llm.content = goodResponse();
    const second = await runner.run(USER, SITE, "q", "analytics");
    expect(second.rows).toEqual([{ path: "/pricing" }]);
  });
});

describe("malformed model output", () => {
  it("rejects non-JSON", async () => {
    llm.content = "I am not JSON";
    expect(runner.run(USER, SITE, "q", "analytics")).rejects.toThrow("invalid JSON");
  });

  it("rejects a response with no sql field", async () => {
    llm.content = JSON.stringify({ title: "nope" });
    expect(runner.run(USER, SITE, "q", "analytics")).rejects.toThrow("did not return a SQL query");
  });

  it("records the failure either way", async () => {
    llm.content = "I am not JSON";
    await runner.run(USER, SITE, "q", "analytics").catch(() => {});
    expect(repo.failed).toHaveLength(1);
  });
});

describe("a failing statement", () => {
  it("reports the database error without leaving the attempt pending", async () => {
    repo.guardedThrows = new Error("statement timeout");
    await expect(runner.run(USER, SITE, "q", "analytics")).rejects.toThrow("Query execution failed");
    expect(repo.failed).toHaveLength(1);
  });
});

describe("the response cache", () => {
  it("answers an identical repeat without calling the model", async () => {
    await runner.run(USER, SITE, "top pages", "analytics");
    await runner.run(USER, SITE, "top pages", "analytics");
    expect(llm.completeCalls).toBe(1);
  });

  it("ignores case and surrounding whitespace", async () => {
    await runner.run(USER, SITE, "Top Pages", "analytics");
    await runner.run(USER, SITE, "  top   pages ", "analytics");
    expect(llm.completeCalls).toBe(1);
  });

  it("does not serve one website's answer to another", async () => {
    await runner.run(USER, SITE, "top pages", "analytics");
    await runner.run(USER, "other-site-id", "top pages", "analytics");
    expect(llm.completeCalls).toBe(2);
  });

  it("does not serve one domain's answer to another", async () => {
    llm.content = goodResponse("SELECT name FROM funnels WHERE website_id::text = $1 LIMIT 10");
    await runner.run(USER, SITE, "same question", "funnels");
    llm.content = goodResponse();
    await runner.run(USER, SITE, "same question", "analytics");
    expect(llm.completeCalls).toBe(2);
  });

  it("does not record a second attempt for a cache hit", async () => {
    await runner.run(USER, SITE, "top pages", "analytics");
    await runner.run(USER, SITE, "top pages", "analytics");
    expect(repo.pendingCreated).toBe(1);
  });
});

describe("the daily cap", () => {
  it("refuses once the window is full", async () => {
    repo.queriesInWindow = 200;
    expect(runner.run(USER, SITE, "q", "analytics")).rejects.toThrow(AIDailyLimitError);
  });

  it("does not call the model when refusing", async () => {
    repo.queriesInWindow = 200;
    await runner.run(USER, SITE, "q", "analytics").catch(() => {});
    expect(llm.completeCalls).toBe(0);
  });

  it("does not record an attempt it never made", async () => {
    repo.queriesInWindow = 200;
    await runner.run(USER, SITE, "q", "analytics").catch(() => {});
    expect(repo.pendingCreated).toBe(0);
  });

  /** A cached answer costs nothing, so it must not be refused by a cost guard. */
  it("still serves a cached answer once the cap is reached", async () => {
    await runner.run(USER, SITE, "top pages", "analytics");
    repo.queriesInWindow = 200;
    const cached = await runner.run(USER, SITE, "top pages", "analytics");
    expect(cached.rows).toEqual([{ path: "/pricing" }]);
  });
});

describe("domain detection", () => {
  it("classifies when the caller says auto", async () => {
    await runner.run(USER, SITE, "how much revenue", "auto");
    expect(llm.classifyCalls).toBe(1);
  });

  it("does not classify when the caller names a domain", async () => {
    await runner.run(USER, SITE, "q", "analytics");
    expect(llm.classifyCalls).toBe(0);
  });

  it("falls back to analytics when the classifier returns nonsense", async () => {
    llm.domain = "not-a-domain";
    await runner.run(USER, SITE, "q", "auto");
    // Analytics binds the legacy id — the observable consequence of the fallback.
    expect(repo.guardedCalls[0]!.boundId).toBe(SITE);
  });

  it("falls back to analytics when the classifier fails outright", async () => {
    llm.classify = async () => {
      throw new Error("upstream down");
    };
    await runner.run(USER, SITE, "q", "auto");
    expect(repo.guardedCalls[0]!.boundId).toBe(SITE);
  });
});

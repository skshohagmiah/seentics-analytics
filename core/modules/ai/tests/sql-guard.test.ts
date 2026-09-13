import { describe, expect, it } from "bun:test";
import { validateAndSanitizeSQL } from "../services/ai-generated-sql-guard.service";

/**
 * The guard on LLM-authored SQL.
 *
 * This is the only thing standing between a hallucinated (or prompt-injected) query and
 * a live multi-tenant database, so it is tested as an adversary rather than as a
 * function: most of what follows is a table of queries that must be refused.
 *
 * The read-only transaction in `runAIQuery` is the second half of the defence, and it
 * is worth being precise about what it does and does not cover. It stops every write
 * and bounds runtime. It does nothing at all about *reading the wrong tenant's rows* —
 * a `SELECT` against another customer's data is a perfectly valid read-only statement.
 * Tenant isolation exists here or nowhere, which is why the cross-tenant block below is
 * the longest one.
 */

const ANALYTICS = ["analytics_events"];
const FUNNELS = ["funnels"];
const AUTOMATIONS = ["automations", "automation_events"];

/** The shape the domain prompts actually ask for — a baseline that must keep working. */
const VALID = "SELECT path, COUNT(*) AS views FROM analytics_events WHERE website_id = $1 GROUP BY path LIMIT 50";

function reject(sql: string, tables: string[] = ANALYTICS) {
  const r = validateAndSanitizeSQL(sql, tables);
  expect(r.ok).toBe(false);
  return r as { ok: false; reason: string };
}

function accept(sql: string, tables: string[] = ANALYTICS) {
  const r = validateAndSanitizeSQL(sql, tables);
  if (!r.ok) throw new Error(`expected accept, got: ${r.reason}`);
  return r;
}

describe("validateAndSanitizeSQL", () => {
  describe("cross-tenant reads", () => {
    /**
     * Each of these contains `$1`, names only whitelisted tables, and is a read-only
     * single SELECT — so an earlier version of this guard passed every one of them
     * straight through to the database.
     */
    it("rejects an inverted tenant filter", () => {
      // Returns every website except the caller's.
      reject("SELECT path FROM analytics_events WHERE website_id != $1 LIMIT 10");
      reject("SELECT path FROM analytics_events WHERE website_id <> $1 LIMIT 10");
    });

    it("rejects a neutralised tenant filter", () => {
      reject("SELECT path FROM analytics_events WHERE website_id = $1 OR 1=1 LIMIT 10");
      reject("SELECT path FROM analytics_events WHERE NOT website_id = $1 LIMIT 10");
    });

    it("rejects a range comparison standing in for the filter", () => {
      reject("SELECT path FROM analytics_events WHERE website_id > $1 LIMIT 10");
    });

    it("rejects $1 used somewhere that is not the tenant column", () => {
      // `$1` is present and a tenant predicate exists nowhere — the filter is on a
      // column the caller does not control.
      reject("SELECT path FROM analytics_events WHERE path = $1 LIMIT 10");
    });

    it("rejects a tenant predicate paired with a second, inverted use of $1", () => {
      reject(
        "SELECT path FROM analytics_events WHERE website_id = $1 AND website_id != $1 LIMIT 10",
      );
    });

    it("rejects an unfiltered scalar subquery beside a filtered outer query", () => {
      // The outer query is scoped correctly; the subquery counts every tenant's rows.
      reject(
        "SELECT (SELECT COUNT(*) FROM analytics_events) AS leak FROM analytics_events WHERE website_id = $1 LIMIT 10",
      );
    });

    it("rejects a CTE that reads the table unfiltered", () => {
      reject(
        "WITH everything AS (SELECT website_id, path FROM analytics_events) " +
        "SELECT path FROM everything WHERE website_id = $1 LIMIT 10",
      );
    });

    it("rejects a self-join scoped on only one side", () => {
      reject(
        "SELECT a.path FROM analytics_events a JOIN analytics_events b ON a.session_id = b.session_id " +
        "WHERE a.website_id = $1 LIMIT 10",
      );
    });

    it("accepts a self-join scoped on both sides", () => {
      accept(
        "SELECT a.path FROM analytics_events a JOIN analytics_events b ON a.session_id = b.session_id " +
        "WHERE a.website_id = $1 AND b.website_id = $1 LIMIT 10",
      );
    });

    it("accepts a multi-CTE query that repeats the predicate", () => {
      accept(
        "WITH cur AS (SELECT path FROM analytics_events WHERE website_id = $1), " +
        "prev AS (SELECT path FROM analytics_events WHERE website_id = $1) " +
        "SELECT COUNT(*) AS n FROM cur LIMIT 10",
      );
    });
  });

  describe("tables scoped through a join", () => {
    /**
     * `automation_events` has no `website_id` — it is keyed by `automation_id`, and the
     * automations prompt scopes it by joining `automations`. So it cannot be required to
     * carry its own predicate, and the rule for it is that the scope must be anchored by
     * one somewhere.
     */
    it("accepts the documented join shape", () => {
      accept(
        "SELECT ae.record_type, COUNT(*) AS n FROM automation_events ae " +
        "JOIN automations a ON ae.automation_id = a.id " +
        "WHERE a.website_id::text = $1 GROUP BY ae.record_type LIMIT 50",
        AUTOMATIONS,
      );
    });

    it("rejects reading the join-scoped table on its own", () => {
      // No column to filter and nothing filtered joined to it: every tenant's rows.
      reject(
        "SELECT record_type, COUNT(*) AS n FROM automation_events GROUP BY record_type LIMIT 50",
        AUTOMATIONS,
      );
    });

    it("rejects an unanchored subquery over the join-scoped table", () => {
      reject(
        "SELECT (SELECT COUNT(*) FROM automation_events) AS leak FROM automations WHERE website_id::text = $1 LIMIT 10",
        AUTOMATIONS,
      );
    });
  });

  describe("tenant predicate forms the prompts produce", () => {
    it("accepts a bare equality", () => {
      accept(VALID);
    });

    it("accepts the ::text cast the uuid domains require", () => {
      accept("SELECT name FROM funnels WHERE website_id::text = $1 LIMIT 10", FUNNELS);
    });

    it("accepts a table-qualified predicate", () => {
      accept("SELECT e.path FROM analytics_events e WHERE e.website_id = $1 LIMIT 10");
    });

    it("accepts a qualified-and-cast predicate", () => {
      accept("SELECT f.name FROM funnels f WHERE f.website_id::text = $1 LIMIT 10", FUNNELS);
    });
  });

  describe("ordinary SQL the guard must not refuse", () => {
    /**
     * Both of these were refused by a first draft of the tenant rules, and both appear
     * in the domain prompts — so the model would have been shown a shape that fails.
     */
    it("accepts a derived table", () => {
      // Lifting the subquery out must leave a placeholder, or `FROM (...) AS sessions`
      // reads as a table named `as`.
      accept(
        "SELECT ROUND(AVG(duration), 2) AS value FROM (" +
        "SELECT session_id, EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) AS duration " +
        "FROM analytics_events WHERE website_id = $1 GROUP BY session_id) AS sessions LIMIT 10",
      );
    });

    it("accepts IS NOT NULL", () => {
      accept(
        "SELECT path FROM analytics_events WHERE website_id = $1 AND path IS NOT NULL LIMIT 10",
      );
    });

    it("still rejects a negated tenant predicate", () => {
      reject("SELECT path FROM analytics_events WHERE NOT (website_id = $1) LIMIT 10");
    });
  });

  describe("statement shape", () => {
    it("rejects anything that is not SELECT or WITH", () => {
      expect(reject("DELETE FROM analytics_events WHERE website_id = $1").reason).toContain(
        "Only SELECT",
      );
    });

    it("rejects statement chaining", () => {
      reject("SELECT path FROM analytics_events WHERE website_id = $1; SELECT 1");
    });

    it("rejects comments, which can hide a payload", () => {
      reject("SELECT path FROM analytics_events WHERE website_id = $1 -- AND 1=1");
      reject("SELECT path FROM analytics_events /* x */ WHERE website_id = $1");
    });

    it("rejects a query with no $1 at all", () => {
      reject("SELECT path FROM analytics_events LIMIT 10");
    });

    it("rejects parameters other than $1", () => {
      reject("SELECT path FROM analytics_events WHERE website_id = $1 AND path = $2 LIMIT 10");
    });
  });

  describe("write and admin keywords", () => {
    const cases = [
      "INSERT", "UPDATE", "DELETE", "DROP", "CREATE",
      "ALTER", "TRUNCATE", "GRANT", "REVOKE", "MERGE",
    ];
    for (const kw of cases) {
      it(`rejects ${kw} anywhere in the statement`, () => {
        expect(
          reject(`SELECT path FROM analytics_events WHERE website_id = $1 AND '${kw}' = x LIMIT 1`)
            .reason,
        ).toContain(kw);
      });
    }

    it("rejects a data-modifying CTE", () => {
      reject(
        "WITH gone AS (DELETE FROM analytics_events WHERE website_id = $1 RETURNING *) " +
        "SELECT * FROM gone",
      );
    });
  });

  describe("set operations", () => {
    /** With a single bound $1, a second branch can hard-code another tenant. */
    for (const op of ["UNION", "INTERSECT", "EXCEPT"]) {
      it(`rejects ${op}`, () => {
        reject(
          `SELECT path FROM analytics_events WHERE website_id = $1 ${op} SELECT path FROM analytics_events`,
        );
      });
    }
  });

  describe("dangerous functions and system catalogs", () => {
    it("rejects pg_sleep", () => {
      reject("SELECT pg_sleep(10) FROM analytics_events WHERE website_id = $1");
    });

    it("rejects file access", () => {
      reject("SELECT pg_read_file('/etc/passwd') FROM analytics_events WHERE website_id = $1");
    });

    it("rejects catalog enumeration", () => {
      reject("SELECT * FROM pg_catalog.pg_tables WHERE website_id = $1");
      reject("SELECT * FROM information_schema.tables WHERE website_id = $1");
    });

    it("rejects current_setting, which leaks connection configuration", () => {
      reject("SELECT current_setting('is_superuser') FROM analytics_events WHERE website_id = $1");
    });
  });

  describe("table whitelist", () => {
    it("rejects a table outside the domain", () => {
      // `users` is auth's, and no AI domain lists it.
      expect(reject("SELECT email FROM users WHERE website_id = $1 LIMIT 10").reason).toContain(
        "not allowed",
      );
    });

    it("rejects a schema-qualified reference", () => {
      reject("SELECT path FROM public.analytics_events WHERE website_id = $1 LIMIT 10");
    });

    it("allows a CTE name that is not a table", () => {
      accept(
        "WITH daily AS (SELECT path FROM analytics_events WHERE website_id = $1) " +
        "SELECT * FROM daily LIMIT 10",
      );
    });
  });

  describe("limit handling", () => {
    it("adds a LIMIT when absent", () => {
      const r = accept("SELECT path FROM analytics_events WHERE website_id = $1");
      expect(r.sql).toEndWith("LIMIT 500");
    });

    it("caps an oversized LIMIT", () => {
      const r = accept("SELECT path FROM analytics_events WHERE website_id = $1 LIMIT 99999");
      expect(r.sql).toContain("LIMIT 1000");
      expect(r.sql).not.toContain("99999");
    });

    it("leaves a reasonable LIMIT alone", () => {
      const r = accept(VALID);
      expect(r.sql).toContain("LIMIT 50");
    });

    it("strips a trailing semicolon", () => {
      const r = accept("SELECT path FROM analytics_events WHERE website_id = $1 LIMIT 10;");
      expect(r.sql).not.toContain(";");
    });
  });
});

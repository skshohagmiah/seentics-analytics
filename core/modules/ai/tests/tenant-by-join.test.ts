import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TENANT_BY_JOIN } from "../services/ai-generated-sql-guard.service";
import { ANALYTICS_TABLES } from "../services/domains/analytics";
import { AUTOMATIONS_TABLES } from "../services/domains/automations";
import { FUNNELS_TABLES } from "../services/domains/funnels";
import { HEATMAPS_TABLES } from "../services/domains/heatmaps";
import { REPLAYS_TABLES } from "../services/domains/replays";
import { REVENUE_TABLES } from "../services/domains/revenue";

/**
 * `TENANT_BY_JOIN` must keep matching the schema.
 *
 * The set names tables with no `website_id` column of their own, and membership *weakens*
 * the tenant check: a listed table is not required to carry its own `website_id = $1`,
 * because it cannot. That is correct for `automation_events`, which is keyed by
 * `automation_id` and reached by joining `automations`.
 *
 * It is silently wrong for anything else. Add a table here that does have the column and
 * it stops being individually scoped — an unfiltered read of it would pass the guard as
 * long as some *other* table in the same scope was filtered. Nothing about that failure
 * is visible at the call site, and the AI module is where model-authored SQL meets a live
 * multi-tenant database.
 *
 * So the schema is the authority, and this test asks it directly rather than trusting the
 * comment above the set.
 */

const SCHEMA = readFileSync(
  resolve(import.meta.dir, "..", "..", "..", "db", "schema.ts"),
  "utf8",
);

/** Every table in `db/schema.ts`, mapped to whether it declares a `website_id` column. */
function tablesWithTenantColumn(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  // `export const x = pgTable(\n  "table_name",` … up to the closing `);` at column 0.
  const decl = /export const \w+ = pgTable\(\s*\n\s*"(\w+)",/g;

  let m: RegExpExecArray | null;
  while ((m = decl.exec(SCHEMA)) !== null) {
    const table = m[1]!;
    const rest = SCHEMA.slice(m.index);
    const endIdx = rest.indexOf("\n);");
    const body = endIdx === -1 ? rest : rest.slice(0, endIdx);
    out.set(table, /"website_id"/.test(body));
  }
  return out;
}

const SCHEMA_TABLES = tablesWithTenantColumn();

/** Every table any AI domain is allowed to name. */
const AI_TABLES = [
  ...new Set([
    ...ANALYTICS_TABLES,
    ...REVENUE_TABLES,
    ...REPLAYS_TABLES,
    ...HEATMAPS_TABLES,
    ...FUNNELS_TABLES,
    ...AUTOMATIONS_TABLES,
  ]),
];

describe("TENANT_BY_JOIN", () => {
  it("parsed the schema", () => {
    // Guards the regex above: a parser that silently matches nothing would make every
    // assertion below vacuous.
    expect(SCHEMA_TABLES.size).toBeGreaterThan(15);
    expect(SCHEMA_TABLES.get("analytics_events")).toBe(true);
    expect(SCHEMA_TABLES.get("automation_events")).toBe(false);
  });

  it("only lists tables that genuinely have no website_id", () => {
    const wrong = [...TENANT_BY_JOIN].filter((t) => SCHEMA_TABLES.get(t) === true);
    expect(wrong).toEqual([]);
  });

  it("only lists tables that exist", () => {
    const missing = [...TENANT_BY_JOIN].filter((t) => !SCHEMA_TABLES.has(t));
    expect(missing).toEqual([]);
  });

  /**
   * The direction that actually protects tenants: anything queryable that *can* be
   * filtered directly must be required to be.
   */
  it("does not exempt any AI-queryable table that could carry its own filter", () => {
    const exempted = AI_TABLES.filter(
      (t) => TENANT_BY_JOIN.has(t) && SCHEMA_TABLES.get(t) === true,
    );
    expect(exempted).toEqual([]);
  });

  it("covers every AI-queryable table that cannot carry its own filter", () => {
    // The inverse gap: a table with no `website_id` that is *not* listed would be
    // required to carry a filter it has no column for, so every query naming it fails.
    const unlisted = AI_TABLES.filter(
      (t) => SCHEMA_TABLES.get(t) === false && !TENANT_BY_JOIN.has(t),
    );
    expect(unlisted).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import { validateAndSanitizeSQL } from "../services/ai-generated-sql-guard.service";
import { ANALYTICS_PROMPT, ANALYTICS_TABLES } from "../services/domains/analytics";
import { AUTOMATIONS_PROMPT, AUTOMATIONS_TABLES } from "../services/domains/automations";
import { FUNNELS_PROMPT, FUNNELS_TABLES } from "../services/domains/funnels";
import { HEATMAPS_PROMPT, HEATMAPS_TABLES } from "../services/domains/heatmaps";
import { REPLAYS_PROMPT, REPLAYS_TABLES } from "../services/domains/replays";
import { REVENUE_PROMPT, REVENUE_TABLES } from "../services/domains/revenue";

/**
 * Every worked example in a domain prompt must survive the guard that runs on what the
 * model writes.
 *
 * The prompts are few-shot material: an example the validator would refuse teaches the
 * model a shape that fails at execution, and the user sees "Unsafe SQL" for a question
 * the product claims to answer. That failure mode is silent from the prompt's side —
 * nothing links the two files — so it is checked here instead.
 *
 * This is also the regression test for tightening the guard. When a new rule is added,
 * the examples that no longer pass fail this test, which is the list of prompts that
 * need updating in the same change.
 */

const DOMAINS = [
  { name: "analytics", prompt: ANALYTICS_PROMPT, tables: ANALYTICS_TABLES },
  { name: "revenue", prompt: REVENUE_PROMPT, tables: REVENUE_TABLES },
  { name: "replays", prompt: REPLAYS_PROMPT, tables: REPLAYS_TABLES },
  { name: "heatmaps", prompt: HEATMAPS_PROMPT, tables: HEATMAPS_TABLES },
  { name: "funnels", prompt: FUNNELS_PROMPT, tables: FUNNELS_TABLES },
  { name: "automations", prompt: AUTOMATIONS_PROMPT, tables: AUTOMATIONS_TABLES },
];

/**
 * Pull the worked examples out of a prompt.
 *
 * They live under `COMMON QUERY PATTERNS`, each introduced by a `--` comment and
 * terminated by `;`. Anything outside that section is schema notes and rules prose. The
 * `--` lines are stripped: they are annotations in the prompt, not part of the example,
 * and the guard rejects comments outright.
 */
function examplesIn(prompt: string): string[] {
  const start = prompt.indexOf("COMMON QUERY PATTERNS");
  if (start === -1) return [];
  // Stop at the next banner section so the RESPONSE FORMAT block is not scanned.
  const rest = prompt.slice(start);
  const end = rest.indexOf("RESPONSE FORMAT");
  const body = end === -1 ? rest : rest.slice(0, end);

  return body
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((sql) => /^(SELECT|WITH)\b/i.test(sql));
}

describe("domain prompt examples", () => {
  for (const domain of DOMAINS) {
    describe(domain.name, () => {
      const examples = examplesIn(domain.prompt);

      it("has worked examples to check", () => {
        expect(examples.length).toBeGreaterThan(0);
      });

      for (const [i, sql] of examples.entries()) {
        // The first line is the SELECT list, which is enough to identify the example.
        const label = sql.split("\n")[0]!.slice(0, 60);
        it(`example ${i + 1} passes the guard — ${label}`, () => {
          const result = validateAndSanitizeSQL(sql, domain.tables);
          if (!result.ok) {
            throw new Error(
              `${domain.name} example ${i + 1} would be refused: ${result.reason}\n\n${sql}`,
            );
          }
        });
      }
    });
  }

  describe("tenant filters stay index-usable", () => {
    /**
     * Cast the parameter, not the column.
     *
     * `funnels`, `heatmap_points` and `automations` all have btree indexes on a `uuid`
     * `website_id`. Writing `website_id::text = $1` puts an expression on the indexed
     * column, which Postgres cannot match against a plain btree index — so the query
     * sequentially scans. Every worked example in three of the six prompts did exactly
     * that, which meant the model was being taught the slow form.
     *
     * `heatmap_points` is the one that hurts: a row per recorded cell, per page.
     */
    for (const domain of DOMAINS) {
      it(`${domain.name} never casts the website_id column`, () => {
        // The worked examples only — the rules prose quotes the slow form on purpose,
        // to tell the model not to write it.
        const offending = examplesIn(domain.prompt).filter((sql) =>
          /website_id\s*::\s*text\s*=\s*\$1/i.test(sql),
        );

        expect(offending).toEqual([]);
      });
    }

    it("uses the parameter-side cast where the column is a uuid", () => {
      // The three uuid-keyed domains; the others compare against a text column.
      for (const name of ["funnels", "heatmaps", "automations"]) {
        const domain = DOMAINS.find((d) => d.name === name)!;
        expect(domain.prompt).toContain("$1::uuid");
      }
    });
  });
});

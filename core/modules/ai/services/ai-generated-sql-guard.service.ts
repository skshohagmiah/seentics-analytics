/**
 * Validates and sanitises AI-generated SQL. This is defense-in-depth on top of the
 * read-only, statement-timeout transaction the query actually runs in (see runAIQuery).
 *
 * - Only a single SELECT statement is allowed.
 * - SQL comments are stripped-then-rejected (they hide payloads and split scoping).
 * - Extra `;` (statement chaining) is rejected.
 * - Forbidden DML/DDL/admin keywords and dangerous functions are blocked.
 * - Set-operations (UNION/EXCEPT/INTERSECT) are blocked: with a single required $1
 *   they are a cross-tenant graft vector (a second branch can hard-code another
 *   website_id), and analytics questions never need them.
 * - System catalogs (pg_catalog / information_schema / pg_*) are blocked.
 * - Table names after FROM / JOIN must be in the domain whitelist.
 * - Caps LIMIT at 1000; adds LIMIT 500 when absent.
 *
 * Tenant scoping is the part that matters most, and checking that `$1` merely appears
 * is not it. All three of these contain `$1`, name only whitelisted tables, and read
 * another customer's rows:
 *
 *     SELECT ... FROM analytics_events WHERE website_id != $1
 *     SELECT ... FROM analytics_events WHERE website_id = $1 OR 1=1
 *     SELECT (SELECT count(*) FROM analytics_events) AS leak
 *       FROM analytics_events WHERE website_id = $1
 *
 * The domain prompts do instruct the model to filter correctly, but a prompt is not an
 * enforcement boundary — it is a request, and the read-only transaction downstream
 * stops writes, not reads of the wrong tenant. So three positive rules are enforced here:
 *
 * - Every occurrence of `$1` must be an equality against `website_id` (`= $1`), so
 *   `!=`, `<>` and range comparisons cannot invert or widen the filter.
 * - Every reference to a physical (non-CTE) table must be matched by its own tenant
 *   predicate, so a subquery or CTE cannot read a table unfiltered.
 * - `OR` and `NOT` are rejected outright. Either one can neutralise a predicate that
 *   passes the checks above, and neither survives a useful analytics question that
 *   `IN (...)` cannot express — the same trade already made for UNION.
 */
export function validateAndSanitizeSQL(
  rawSql: string,
  allowedTables: string[] = [],
): { ok: true; sql: string } | { ok: false; reason: string } {
  // Reject comments outright — a `--` or `/* */` can smuggle payloads past keyword checks.
  if (/--|\/\*|\*\//.test(rawSql)) {
    return { ok: false, reason: "SQL comments are not allowed" };
  }

  const trimmed = rawSql.trim().replace(/;+\s*$/, "");
  const upper = trimmed.toUpperCase();

  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
    return { ok: false, reason: "Only SELECT statements are allowed" };
  }

  // No statement chaining — a mid-string ';' means a second statement.
  if (trimmed.includes(";")) {
    return { ok: false, reason: "Multiple statements are not allowed" };
  }

  // Data-modifying keywords (dangerous even inside a WITH ... AS (DELETE ... RETURNING)
  // CTE — the read-only tx also blocks those, this is belt-and-suspenders) plus
  // set-operations, which with a single required $1 are a cross-tenant graft vector.
  const forbidden = [
    "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
    "TRUNCATE", "GRANT", "REVOKE", "EXECUTE", "CALL", "MERGE",
    "UNION", "INTERSECT", "EXCEPT",
  ];
  for (const kw of forbidden) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { ok: false, reason: `Forbidden keyword: ${kw}` };
    }
  }

  // Dangerous functions / identifiers (DoS, file access, system catalog enumeration).
  const forbiddenPatterns: [RegExp, string][] = [
    [/\bPG_SLEEP\b/i, "pg_sleep"],
    [/\bPG_READ_FILE\b/i, "pg_read_file"],
    [/\bPG_LS_DIR\b/i, "pg_ls_dir"],
    [/\bLO_\w+/i, "large-object function"],
    [/\bDBLINK\b/i, "dblink"],
    [/\bPG_CATALOG\b/i, "pg_catalog"],
    [/\bINFORMATION_SCHEMA\b/i, "information_schema"],
    [/\bPG_[A-Z_]*\b/i, "pg_* system object"],
    [/\bCURRENT_SETTING\b/i, "current_setting"],
    [/\bSET_CONFIG\b/i, "set_config"],
  ];
  for (const [re, label] of forbiddenPatterns) {
    if (re.test(trimmed)) {
      return { ok: false, reason: `Forbidden reference: ${label}` };
    }
  }

  // `OR`/`NOT` can neutralise an otherwise-correct tenant predicate
  // (`website_id = $1 OR 1=1`), and no analytics question needs either.
  if (/\bOR\b/.test(upper)) {
    return { ok: false, reason: "OR is not allowed — use IN (...) instead" };
  }
  // `IS NOT NULL` (and its TRUE/FALSE/DISTINCT siblings) is ordinary SQL and cannot
  // invert a tenant predicate, so it is exempted before the check. What remains —
  // `NOT (website_id = $1)`, `NOT IN` — is refused.
  const withoutIsNot = upper.replace(/\bIS\s+NOT\s+(NULL|TRUE|FALSE|DISTINCT)\b/g, "IS $1");
  if (/\bNOT\b/.test(withoutIsNot)) {
    return { ok: false, reason: "NOT is not allowed (except IS NOT NULL)" };
  }

  // Ensure website_id parameter placeholder is present (and no other $N params).
  if (!trimmed.includes("$1")) {
    return { ok: false, reason: "Query must include the website_id filter ($1)" };
  }
  if (/\$(?!1\b)\d+/.test(trimmed)) {
    return { ok: false, reason: "Only the $1 (website_id) parameter is allowed" };
  }

  // Every `$1` must be an equality against website_id — optionally table-qualified and
  // optionally cast (`e.website_id::text = $1`). Counting matches rather than testing
  // once is what rejects `website_id = $1 AND website_id != $1`-style mixtures: a `$1`
  // that is not part of a tenant equality leaves the two counts unequal.
  const TENANT_PREDICATE = /\b(?:[A-Za-z_]\w*\s*\.\s*)?website_id\b(?:\s*::\s*\w+)?\s*=\s*\$1\b/gi;
  const tenantPredicates = trimmed.match(TENANT_PREDICATE)?.length ?? 0;
  const paramUses = trimmed.match(/\$1\b/g)?.length ?? 0;
  if (tenantPredicates === 0) {
    return { ok: false, reason: "Query must filter on website_id = $1" };
  }
  if (tenantPredicates !== paramUses) {
    return { ok: false, reason: "$1 may only be used as `website_id = $1`" };
  }

  // Table whitelist — extract tables referenced after FROM and JOIN. CTE names
  // (defined as `<name> AS (`) are local aliases, so add them to the allow-set.
  if (allowedTables.length > 0) {
    const cteNames = new Set<string>();
    const ctePattern = /\b([A-Za-z_]\w*)\s+AS\s*\(/gi;
    let cteMatch: RegExpExecArray | null;
    while ((cteMatch = ctePattern.exec(trimmed)) !== null) {
      cteNames.add((cteMatch[1] ?? "").toLowerCase());
    }
    const allowed = new Set([...allowedTables.map((t) => t.toLowerCase()), ...cteNames]);

    const tablePattern = /\bFROM\s+([A-Za-z_][\w.]*)|\bJOIN\s+([A-Za-z_][\w.]*)/gi;
    let match: RegExpExecArray | null;
    // Physical tables only — a CTE is a local alias over rows already filtered.
    let physicalRefs = 0;
    while ((match = tablePattern.exec(trimmed)) !== null) {
      const table = (match[1] ?? match[2] ?? "").toLowerCase();
      if (!table) continue;
      // Reject any schema-qualified reference (e.g. pg_catalog.x) and anything off-whitelist.
      if (table.includes(".") || !allowed.has(table)) {
        return { ok: false, reason: `Table '${table}' is not allowed in this context` };
      }
      if (!cteNames.has(table)) physicalRefs++;
    }

    // Counting across the whole statement is not enough: the predicates must also be in
    // the right places. `WITH all AS (SELECT * FROM analytics_events) SELECT * FROM all
    // WHERE website_id = $1` has one reference and one predicate, but the CTE still
    // scans every tenant. So each scope is checked on its own — see `unscopedScope`.
    void physicalRefs;
    const offending = unscopedScope(trimmed, cteNames);
    if (offending) {
      return {
        ok: false,
        reason: `Every table reference must be filtered by website_id = $1 (unscoped: ${offending})`,
      };
    }
  }

  // Cap LIMIT at 1000
  const limitMatch = upper.match(/LIMIT\s+(\d+)/);
  if (limitMatch) {
    const val = parseInt(limitMatch[1], 10);
    if (val > 1000) {
      return { ok: true, sql: trimmed.replace(/LIMIT\s+\d+/i, "LIMIT 1000") };
    }
    return { ok: true, sql: trimmed };
  }

  return { ok: true, sql: trimmed + " LIMIT 500" };
}

/**
 * Tables with no `website_id` column of their own.
 *
 * `automation_events` is keyed by `automation_id`; tenancy reaches it by joining
 * `automations`, which is where the domain prompt puts the filter. Requiring a
 * predicate directly on it would reject that domain's own documented query shape, so it
 * is checked differently — see `unscopedScope`. Keep this in step with `db/schema.ts`:
 * a table added here that *does* have the column silently loses its own check.
 */
export const TENANT_BY_JOIN: ReadonlySet<string> = new Set(["automation_events"]);

/**
 * Find a scope that reads a physical table without filtering it by tenant.
 *
 * A "scope" is the statement text with its parenthesised groups lifted out: the outer
 * query is one, every CTE body is one, and so is every subquery — derived table, scalar
 * subquery, `IN (...)`. Each is checked independently, because a tenant predicate only
 * constrains the scope it appears in. Counting predicates across the whole statement
 * misses the CTE case entirely, and that is the shape a model reaches for most often
 * when asked to compare a website against "all sites".
 *
 * Returns the offending table name, or `null` when every scope is filtered.
 */
function unscopedScope(sql: string, cteNames: ReadonlySet<string>): string | null {
  const groups: string[] = [];
  let own = "";
  let depth = 0;
  let start = 0;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") {
      if (depth === 0) {
        own += sql.slice(start, i);
        start = i + 1;
      }
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        groups.push(sql.slice(start, i));
        // Placeholder, so `FROM (subquery) AS x` does not become `FROM  AS x` — which
        // reads as a table called `as`. `()` cannot match an identifier.
        own += "()";
        start = i + 1;
      }
      // A stray ')' would drive depth negative; treat the rest as own text.
      if (depth < 0) return null;
    }
  }
  own += sql.slice(start);

  // Physical tables read directly in this scope (CTE names are local aliases).
  const refs: string[] = [];
  const tablePattern = /\bFROM\s+([A-Za-z_]\w*)|\bJOIN\s+([A-Za-z_]\w*)/gi;
  let m: RegExpExecArray | null;
  while ((m = tablePattern.exec(own)) !== null) {
    const t = (m[1] ?? m[2] ?? "").toLowerCase();
    if (t && !cteNames.has(t)) refs.push(t);
  }

  if (refs.length > 0) {
    const predicates =
      own.match(/\b(?:[A-Za-z_]\w*\s*\.\s*)?website_id\b(?:\s*::\s*\w+)?\s*=\s*\$1\b/gi)
        ?.length ?? 0;

    // Tables that carry `website_id` need one predicate each — a self-join needs both
    // sides scoped. Tables that do not carry it cannot be filtered directly, so they
    // need the scope to be anchored by at least one predicate on the table they join to.
    const direct = refs.filter((t) => !TENANT_BY_JOIN.has(t));
    const byJoin = refs.filter((t) => TENANT_BY_JOIN.has(t));

    if (predicates < direct.length) return direct[predicates] ?? direct[0]!;
    // `SELECT * FROM automation_events` on its own reaches every tenant: no column to
    // filter on and nothing joined that is filtered.
    if (byJoin.length > 0 && predicates === 0) return byJoin[0]!;
  }

  for (const g of groups) {
    const bad = unscopedScope(g, cteNames);
    if (bad) return bad;
  }
  return null;
}

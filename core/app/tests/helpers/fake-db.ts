/**
 * One controllable stand-in for the `db` module, shared by every test file that needs it.
 *
 * Deliberately a single module rather than one per feature. Bun's `mock.module` registry
 * is process-global and a module namespace materialises once, so the first registration
 * to be resolved wins for the whole run — two independent fakes meant whichever module's
 * tests ran second linked against the *other* module's fake and failed on a missing table
 * export. Because every registration returns this module's objects, it does not matter
 * which one wins: they are all the same fake, and each test drives it through `resetDb()`
 * in its own `beforeEach`.
 *
 * It answers three shapes, because the codebase uses three:
 *  - raw tagged-template SQL (`sql\`…\``), which the analytics repositories use
 *  - the Drizzle query builder, which the traffic-summary and impression queries use
 *  - `db.insert(table).values(rows)`, which the write paths use
 */

// ─── Raw tagged-template SQL ──────────────────────────────────────────────────

/** One recorded tagged-template invocation. */
export type SqlCall = {
  /** The literal chunks joined by `?` — enough to assert on clauses without whitespace games. */
  text: string;
  /** Interpolated bind values, in order. */
  values: unknown[];
};

export const sqlCalls: SqlCall[] = [];

let queued: unknown[][] = [];
let cursor = 0;

/**
 * Queue one result set per `sql` call the code under test will make, in call order.
 *
 * Order is deterministic even for `Promise.all([...])`: the tagged templates are
 * evaluated left to right, synchronously, before any of them resolve. A call past the
 * end of the queue yields `[]` rather than throwing.
 */
export function queueRows(...resultSets: unknown[][]): void {
  queued = resultSets;
  cursor = 0;
}

export function sqlCallCount(): number {
  return sqlCalls.length;
}

/** Marker returned by the identifier form `sql(["column_name"])`. */
export type SqlIdentifier = { __ident: string };

export function isIdentifier(v: unknown): v is SqlIdentifier {
  return typeof v === "object" && v !== null && "__ident" in v;
}

/**
 * `postgres`'s dual-purpose export: a tagged template *and* a callable that escapes
 * identifiers. `dimensions.repository` relies on the second form to splice a column
 * name in safely, so the fake answers both shapes.
 */
export const fakeSql = ((first: unknown, ...values: unknown[]) => {
  const raw = (first as { raw?: readonly string[] })?.raw;
  if (!raw) {
    const name = Array.isArray(first) ? String(first[0]) : String(first);
    return { __ident: name } satisfies SqlIdentifier;
  }
  sqlCalls.push({ text: raw.join("?"), values });
  return Promise.resolve(queued[cursor++] ?? []);
}) as unknown as {
  <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  (ident: string[]): SqlIdentifier;
  unsafe(text: string): SqlFragment;
  begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
};

/** What `sql.unsafe(...)` returns: an opaque fragment, spliced into a later template. */
export type SqlFragment = { __fragment: string };

/**
 * `sql.unsafe` and `sql.begin`, which `postgres` hangs off the same callable.
 *
 * Both are attached rather than omitted because a repository can call `sql.unsafe` at
 * **module scope** — `heatmap.repository` builds its path-normalisation expression that
 * way — so a fake without it throws while the module is still loading, from whichever
 * unrelated test file happens to import it first.
 */
(fakeSql as unknown as Record<string, unknown>).unsafe = (text: string): SqlFragment => ({
  __fragment: text,
});
(fakeSql as unknown as Record<string, unknown>).begin = async <T,>(
  fn: (tx: unknown) => Promise<T>,
): Promise<T> => {
  transactions.push(sqlCalls.length);
  return fn(fakeSql);
};

// ─── Writes ───────────────────────────────────────────────────────────────────

export type InsertCall = { table: string; rows: unknown[] };

export const inserts: InsertCall[] = [];
export const transactions: number[] = [];

let insertShouldThrow = false;

/** Make subsequent inserts reject, to exercise the best-effort logging paths. */
export function failInserts(on = true): void {
  insertShouldThrow = on;
}

export function insertsInto(table: string): InsertCall[] {
  return inserts.filter((i) => i.table === table);
}

/** Tables are tagged so an insert can be attributed without importing the real schema. */
function tableName(t: unknown): string {
  return (t as { __name?: string })?.__name ?? "unknown";
}

let idSeq = 0;

/**
 * Stamp the columns a real insert would fill in.
 *
 * `.returning()` has to echo something usable, because a service that reads the row back
 * — to hand the caller its generated id — would otherwise destructure `undefined` and
 * fail for a reason that has nothing to do with what the test is checking.
 */
function withDefaults(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return row;
  const r = row as Record<string, unknown>;
  return {
    id: r.id ?? `row_${++idSeq}`,
    createdAt: r.createdAt ?? new Date(),
    lastUsedAt: r.lastUsedAt ?? null,
    ...r,
  };
}

function insertBuilder(table: unknown) {
  return {
    values(rows: unknown) {
      const list = Array.isArray(rows) ? rows : [rows];
      inserts.push({ table: tableName(table), rows: list });
      if (insertShouldThrow) return Promise.reject(new Error("insert failed"));
      return Object.assign(Promise.resolve(), {
        onConflictDoUpdate: () => Promise.resolve(),
        returning: () => Promise.resolve(list.map(withDefaults)),
      });
    },
  };
}

/** Rows a `.delete(...).returning()` should report as removed. */
let deleteResult: unknown[] = [];

export function queueDeleteRows(rows: unknown[]): void {
  deleteResult = rows;
}

export const deletes: Array<{ table: string; arg: unknown }> = [];

function deleteBuilder(table: unknown) {
  const chain = {
    where(arg: unknown) {
      deletes.push({ table: tableName(table), arg });
      return chain;
    },
    returning: () => Promise.resolve(deleteResult),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(deleteResult).then(resolve),
  };
  return chain;
}

/** Rows an `.update(...)` touched, recorded so a best-effort write can be asserted. */
export const updates: Array<{ table: string; values: unknown }> = [];

function updateBuilder(table: unknown) {
  const chain = {
    set(values: unknown) {
      updates.push({ table: tableName(table), values });
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return chain;
}

// ─── Drizzle query builder ────────────────────────────────────────────────────

/** Recorded builder stages. Exported under both names the existing tests use. */
export const selects: Array<{ stage: string; arg: unknown }> = [];
export const drizzleCalls = selects;

let selectResult: unknown[] = [];

export function queueSelectRows(rows: unknown[]): void {
  selectResult = rows;
}

/** Alias kept for the analytics tests, which name the same queue this way. */
export const queueDrizzleRows = queueSelectRows;

/**
 * A chain that is both continuable and awaitable.
 *
 * Different call sites end on different stages — one finishes at `groupBy`, another at
 * `limit`, another awaits the builder directly — so rather than guessing which stage is
 * terminal, every stage returns the chain and the chain itself is a thenable.
 */
function selectBuilder() {
  const chain: Record<string, unknown> = {};
  for (const stage of [
    "from",
    "where",
    "groupBy",
    "orderBy",
    "having",
    "limit",
    "offset",
    "innerJoin",
    "leftJoin",
  ]) {
    chain[stage] = (arg: unknown) => {
      selects.push({ stage, arg });
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(selectResult).then(resolve, reject);
  return chain;
}

type FakeDb = {
  insert: (table: unknown) => ReturnType<typeof insertBuilder>;
  delete: (table: unknown) => ReturnType<typeof deleteBuilder>;
  update: (table: unknown) => ReturnType<typeof updateBuilder>;
  select: (arg?: unknown) => ReturnType<typeof selectBuilder>;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

export const fakeDb: FakeDb = {
  insert: (table: unknown) => insertBuilder(table),
  delete: (table: unknown) => deleteBuilder(table),
  update: (table: unknown) => updateBuilder(table),
  select: (arg?: unknown) => {
    selects.push({ stage: "select", arg });
    return selectBuilder();
  },
  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    transactions.push(transactions.length + 1);
    return fn(fakeDb);
  },
};

// ─── Reset ────────────────────────────────────────────────────────────────────

export function resetDb(): void {
  sqlCalls.length = 0;
  queued = [];
  cursor = 0;
  inserts.length = 0;
  selects.length = 0;
  deletes.length = 0;
  updates.length = 0;
  deleteResult = [];
  transactions.length = 0;
  selectResult = [];
  insertShouldThrow = false;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * A logger whose `child()` returns itself.
 *
 * Modules call `log.child(...)` at import time, so an incomplete stub does not fail the
 * test that installed it — it fails whichever module happens to load next.
 */
export function fakeLogger() {
  const logger: Record<string, unknown> = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
  };
  logger.child = () => logger;
  return { log: logger };
}

// ─── The module ───────────────────────────────────────────────────────────────

const table = (name: string) => ({ __name: name });

/**
 * Everything `db/index.ts` re-exports that any module under test touches.
 *
 * It re-exports the whole Drizzle schema (`export * from "./schema"`), and an omission
 * here surfaces as a load-time failure in an unrelated module rather than a local one —
 * which is exactly the failure this consolidated fake exists to prevent.
 */
export function fakeDbModule() {
  return {
    db: fakeDb,
    sql: fakeSql,
    // Every table in `db/schema.ts`, in its declaration order — not just the ones some
    // test happens to touch. An omission here does not fail locally; it fails whichever
    // *other* file the runner happens to load next, with a `SyntaxError: Export named …
    // not found` pointing at the real module that does export it. `app/tests/
    // mock-completeness.test.ts` guards inline stubs against exactly this, and cannot see
    // a helper-returned object like this one, so the list is checked below instead.
    users: table("users"),
    websites: table("websites"),
    ingestBatches: table("ingest_batches"),
    websiteMembers: table("website_members"),
    websiteInvitations: table("website_invitations"),
    goals: table("goals"),
    funnels: table("funnels"),
    automations: table("automations"),
    automationEvents: table("automation_events"),
    analyticsEvents: table("analytics_events"),
    apiKeys: table("api_keys"),
    sessionReplays: table("session_replays"),
    heatmapPoints: table("heatmap_points"),
    aiQueries: table("ai_queries"),
    heatmapPageSnapshots: table("heatmap_page_snapshots"),
    automationImpressions: table("automation_impressions"),
    userProfiles: table("user_profiles"),
    webhookDeliveries: table("webhook_deliveries"),
    identityAliases: table("identity_aliases"),
  };
}

import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * A redelivered batch must change nothing.
 *
 * Every retry in the system reduces to the behaviour asserted here. Two of the six write
 * paths accumulate rather than insert — `intensity = intensity + EXCLUDED.intensity` and
 * `visit_count + …` — so a second apply does not duplicate a row, it inflates a number
 * with nothing to distinguish the result from real traffic.
 *
 * The database is faked at the module boundary. What matters is not the SQL but the
 * control flow: whether `write` runs, and whether it runs inside the same transaction as
 * the completion flip.
 */

/** Batch ids already marked completed, i.e. the `completed_at IS NOT NULL` rows. */
const completed = new Set<string>();

/** Transactions opened, so a test can assert the write shared one with the marker. */
let txCount = 0;

/** The transaction object handed to the last `write`. */
let writeTx: unknown = null;

const fakeTx = {
  /** Models `UPDATE … WHERE completed_at IS NULL RETURNING batch_id`. */
  execute: async (query: unknown) => {
    const batchId = (query as { __batchId?: string }).__batchId ?? "";
    if (completed.has(batchId)) return [];
    completed.add(batchId);
    return [{ batch_id: batchId }];
  },
};

mock.module("drizzle-orm", () => ({
  // The tagged template only has to carry the batch id through to the fake `execute`.
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({
    __batchId: String(values[0] ?? ""),
  }),
}));

mock.module("../../../db", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      txCount += 1;
      return fn(fakeTx);
    },
  },
  sql: { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx) },
}));

const { applyBatchOnce } = await import("../apply-once");

beforeEach(() => {
  completed.clear();
  txCount = 0;
  writeTx = null;
});

describe("applyBatchOnce", () => {
  it("runs the write on a first delivery and reports what it wrote", async () => {
    const result = await applyBatchOnce("batch_1", async (tx) => {
      writeTx = tx;
      return 7;
    });

    expect(result).toEqual({ applied: true, rowCount: 7 });
  });

  it("skips the write entirely on a redelivery", async () => {
    let calls = 0;
    const write = async () => {
      calls += 1;
      return 3;
    };

    const first = await applyBatchOnce("batch_1", write);
    const second = await applyBatchOnce("batch_1", write);

    expect(first.applied).toBe(true);
    expect(second).toEqual({ applied: false, rowCount: 0 });
    expect(calls).toBe(1);
  });

  it("hands the write the same transaction the completion flip ran in", async () => {
    // The whole guarantee rests on this: a write that reaches for the ambient `db`
    // instead commits independently of the marker, which is the double-write the marker
    // exists to prevent.
    await applyBatchOnce("batch_1", async (tx) => {
      writeTx = tx;
      return 1;
    });

    expect(txCount).toBe(1);
    expect(writeTx).toBe(fakeTx);
  });

  it("treats an unqueued batch id as already applied rather than writing blind", async () => {
    // A caller that invents a batch id has no queue row to complete, so there is nothing
    // to make the write exactly-once — refusing is safer than writing unguarded.
    completed.add("never_queued");
    let called = false;

    const result = await applyBatchOnce("never_queued", async () => {
      called = true;
      return 1;
    });

    expect(result.applied).toBe(false);
    expect(called).toBe(false);
  });

  it("lets a write failure roll the completion back with it", async () => {
    // Same transaction, so a throw discards the flip too and the batch is retried.
    await expect(
      applyBatchOnce("batch_1", async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
  });
});

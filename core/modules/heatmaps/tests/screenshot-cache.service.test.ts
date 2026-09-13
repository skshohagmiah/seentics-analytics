import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { getScreenshotCache, initializeScreenshotCache } from "../services/screenshot-cache.service";

/**
 * The in-process snapshot cache — the first and cheapest of the three dedup layers in
 * `SnapshotIngestService`.
 *
 * Worth its own file because a cache that silently stops caching does not fail anything:
 * it just costs a database read per ingested screenshot, on the hottest path in the
 * product, and the only symptom is load. Two of its rules are easy to break by accident:
 *
 * - **Expiry is checked on read, not swept.** An expired entry has to count as a *miss*
 *   and be deleted, so a stale hash never suppresses a real upload.
 * - **Eviction skips keys already present.** Overwriting an existing entry at capacity
 *   must not evict a different one, or a hot page can push itself out.
 *
 * `setSystemTime` drives expiry rather than a real wait — the TTL floor is 10 seconds,
 * which is not a thing to sleep for in a unit test.
 */

const SITE = "11111111-1111-4111-8111-111111111111";

const SNAPSHOT = {
  s3Key: "heatmap-screenshots/site/slot.jpg",
  hash: "abc123",
  docWidth: 1440,
  docHeight: 3000,
};

/** A fixed start point, so every expiry assertion is relative to a known now. */
const T0 = new Date("2026-09-01T00:00:00.000Z");

beforeEach(() => {
  setSystemTime(T0);
});

afterEach(() => {
  // Restores the real clock; a leaked fake time breaks every later file in the run.
  setSystemTime();
});

describe("hits and misses", () => {
  it("reports a miss for a key it has never seen", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();

    expect(cache.get(SITE, "/pricing")).toBeNull();
  });

  it("returns what was stored", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();

    cache.set(SITE, "/pricing", SNAPSHOT);

    expect(cache.get(SITE, "/pricing")).toMatchObject(SNAPSHOT);
  });

  it("keys by page path, so one page's hash cannot answer for another", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();

    cache.set(SITE, "/pricing", SNAPSHOT);

    expect(cache.get(SITE, "/features")).toBeNull();
  });

  it("keys by website, so one site's hash cannot answer for another", () => {
    // The comment on `cacheKey` calls this out: keying by the wrong identifier is a
    // permanent miss rather than an error, so nothing would report it.
    initializeScreenshotCache();
    const cache = getScreenshotCache();

    cache.set(SITE, "/pricing", SNAPSHOT);

    expect(cache.get("another-site", "/pricing")).toBeNull();
  });

  it("overwrites an existing entry rather than keeping the first", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();

    cache.set(SITE, "/pricing", SNAPSHOT);
    cache.set(SITE, "/pricing", { ...SNAPSHOT, hash: "def456" });

    expect(cache.get(SITE, "/pricing")?.hash).toBe("def456");
  });
});

describe("expiry", () => {
  it("keeps an entry inside its TTL", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 59_000));

    expect(cache.get(SITE, "/pricing")).not.toBeNull();
  });

  it("reports an expired entry as a miss", () => {
    // A hit here would hand back a stale hash, which suppresses the upload of an image
    // that really did change — the cache turning into a correctness bug rather than
    // just a cost one.
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 60_001));

    expect(cache.get(SITE, "/pricing")).toBeNull();
  });

  it("drops the expired entry rather than re-checking it forever", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 60_001));
    cache.get(SITE, "/pricing");

    expect(cache.getStats().size).toBe(0);
  });

  it("counts an expired read as a miss in the stats", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 60_001));
    cache.get(SITE, "/pricing");

    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);
  });

  it("dates the TTL from the write, not from the first read", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 30_000));
    expect(cache.get(SITE, "/pricing")).not.toBeNull();

    // Reading at +30s must not extend the entry to +90s.
    setSystemTime(new Date(T0.getTime() + 61_000));
    expect(cache.get(SITE, "/pricing")).toBeNull();
  });

  it("re-writing an entry restarts its TTL", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 50_000));
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 100_000));
    expect(cache.get(SITE, "/pricing")).not.toBeNull();
  });

  it("clamps a TTL below the ten-second floor", () => {
    // A one-millisecond TTL is a cache that never hits, which is worse than no cache:
    // the same cost plus the bookkeeping.
    initializeScreenshotCache(1);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 9_000));

    expect(cache.get(SITE, "/pricing")).not.toBeNull();
  });

  it("uses the default TTL when none is given", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 59 * 60_000));
    expect(cache.get(SITE, "/pricing")).not.toBeNull();

    setSystemTime(new Date(T0.getTime() + 61 * 60_000));
    expect(cache.get(SITE, "/pricing")).toBeNull();
  });
});

describe("eviction", () => {
  it("evicts the oldest entry at capacity", () => {
    initializeScreenshotCache(undefined, 10);
    const cache = getScreenshotCache();

    for (let i = 0; i < 10; i++) cache.set(SITE, `/p${i}`, SNAPSHOT);
    cache.set(SITE, "/p10", SNAPSHOT);

    expect(cache.get(SITE, "/p0")).toBeNull();
    expect(cache.get(SITE, "/p10")).not.toBeNull();
  });

  it("holds the cache at its capacity rather than growing past it", () => {
    initializeScreenshotCache(undefined, 10);
    const cache = getScreenshotCache();

    for (let i = 0; i < 50; i++) cache.set(SITE, `/p${i}`, SNAPSHOT);

    expect(cache.getStats().size).toBe(10);
  });

  it("counts what it evicted", () => {
    initializeScreenshotCache(undefined, 10);
    const cache = getScreenshotCache();

    for (let i = 0; i < 13; i++) cache.set(SITE, `/p${i}`, SNAPSHOT);

    expect(cache.getStats().evictions).toBe(3);
  });

  it("does not evict when overwriting a key it already holds", () => {
    // The `!this.cache.has(key)` guard. Without it, re-writing a hot page at capacity
    // evicts an unrelated one every time — so the hottest path does the most damage.
    initializeScreenshotCache(undefined, 10);
    const cache = getScreenshotCache();
    for (let i = 0; i < 10; i++) cache.set(SITE, `/p${i}`, SNAPSHOT);

    cache.set(SITE, "/p5", { ...SNAPSHOT, hash: "updated" });

    expect(cache.getStats().evictions).toBe(0);
    expect(cache.get(SITE, "/p0")).not.toBeNull();
    expect(cache.get(SITE, "/p5")?.hash).toBe("updated");
  });

  it("clamps a capacity below the ten-entry floor", () => {
    initializeScreenshotCache(undefined, 1);
    const cache = getScreenshotCache();

    for (let i = 0; i < 10; i++) cache.set(SITE, `/p${i}`, SNAPSHOT);

    expect(cache.getStats().size).toBe(10);
  });
});

describe("invalidation", () => {
  it("drops one entry", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    cache.invalidate(SITE, "/pricing");

    expect(cache.get(SITE, "/pricing")).toBeNull();
  });

  it("leaves the site's other pages alone", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);
    cache.set(SITE, "/features", SNAPSHOT);

    cache.invalidate(SITE, "/pricing");

    expect(cache.get(SITE, "/features")).not.toBeNull();
  });

  it("is a no-op for a key it does not hold", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    cache.invalidate(SITE, "/never-cached");

    expect(cache.getStats().size).toBe(1);
  });

  it("drops every page for one website", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);
    cache.set(SITE, "/features", SNAPSHOT);
    cache.set("other-site", "/pricing", SNAPSHOT);

    cache.invalidateWebsite(SITE);

    expect(cache.get(SITE, "/pricing")).toBeNull();
    expect(cache.get(SITE, "/features")).toBeNull();
    expect(cache.get("other-site", "/pricing")).not.toBeNull();
  });

  it("matches the website prefix exactly, not by string prefix", () => {
    // `invalidateWebsite` filters on `${websiteId}:`, so an id that is a prefix of
    // another must not take its entries with it.
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set("site", "/pricing", SNAPSHOT);
    cache.set("site-two", "/pricing", SNAPSHOT);

    cache.invalidateWebsite("site");

    expect(cache.get("site", "/pricing")).toBeNull();
    expect(cache.get("site-two", "/pricing")).not.toBeNull();
  });

  it("reports the size after a website-wide invalidation", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/a", SNAPSHOT);
    cache.set(SITE, "/b", SNAPSHOT);
    cache.set("other", "/a", SNAPSHOT);

    cache.invalidateWebsite(SITE);

    expect(cache.getStats().size).toBe(1);
  });

  it("clears everything", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/a", SNAPSHOT);
    cache.set("other", "/b", SNAPSHOT);

    cache.clear();

    expect(cache.getStats().size).toBe(0);
    expect(cache.get(SITE, "/a")).toBeNull();
  });
});

describe("stats", () => {
  it("reports a zero hit rate before any read", () => {
    initializeScreenshotCache();

    expect(getScreenshotCache().getStats().hitRate).toBe(0);
  });

  it("counts hits and misses separately", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    cache.get(SITE, "/pricing");
    cache.get(SITE, "/pricing");
    cache.get(SITE, "/missing");

    expect(cache.getStats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it("reports the hit rate as a percentage", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    cache.get(SITE, "/pricing");
    cache.get(SITE, "/missing");

    expect(cache.getStats().hitRate).toBe(50);
  });

  it("rounds the hit rate to two decimals", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    cache.get(SITE, "/pricing");
    cache.get(SITE, "/a");
    cache.get(SITE, "/b");

    // 1/3 — a percentage, so 33.33 rather than 0.3333.
    expect(cache.getStats().hitRate).toBe(33.33);
  });
});

describe("the singleton", () => {
  it("hands out the same instance to every caller", () => {
    // `lib/playwright-screenshots` reads this cache and `SnapshotIngestService` writes
    // it. Two instances would mean the write layer and the capture layer dedup against
    // separate state.
    initializeScreenshotCache();

    getScreenshotCache().set(SITE, "/pricing", SNAPSHOT);

    expect(getScreenshotCache().get(SITE, "/pricing")).not.toBeNull();
  });

  it("replaces the instance on re-initialisation", () => {
    initializeScreenshotCache();
    getScreenshotCache().set(SITE, "/pricing", SNAPSHOT);

    initializeScreenshotCache(30_000, 20);

    expect(getScreenshotCache().get(SITE, "/pricing")).toBeNull();
  });

  it("creates one on first use without an explicit init", () => {
    initializeScreenshotCache();
    const cache = getScreenshotCache();

    expect(cache).toBeDefined();
    expect(cache.getStats().size).toBe(0);
  });
});

describe("configure", () => {
  it("applies a new TTL to subsequent writes", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();

    cache.configure(120_000);
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 90_000));
    expect(cache.get(SITE, "/pricing")).not.toBeNull();
  });

  it("does not retroactively extend entries written under the old TTL", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();
    cache.set(SITE, "/pricing", SNAPSHOT);

    cache.configure(600_000);

    setSystemTime(new Date(T0.getTime() + 61_000));
    expect(cache.get(SITE, "/pricing")).toBeNull();
  });

  it("clamps a configured TTL to the floor", () => {
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();

    cache.configure(1);
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 9_000));
    expect(cache.get(SITE, "/pricing")).not.toBeNull();
  });

  it("ignores a zero TTL rather than treating it as immediate expiry", () => {
    // `if (ttlMs)` — zero is falsy, so it means "leave it alone". Pinned because
    // `Math.max(10_000, 0)` would have been a plausible alternative reading.
    initializeScreenshotCache(60_000);
    const cache = getScreenshotCache();

    cache.configure(0);
    cache.set(SITE, "/pricing", SNAPSHOT);

    setSystemTime(new Date(T0.getTime() + 30_000));
    expect(cache.get(SITE, "/pricing")).not.toBeNull();
  });

  it("applies a new capacity", () => {
    initializeScreenshotCache(undefined, 1000);
    const cache = getScreenshotCache();

    cache.configure(undefined, 10);
    for (let i = 0; i < 20; i++) cache.set(SITE, `/p${i}`, SNAPSHOT);

    expect(cache.getStats().size).toBe(10);
  });
});

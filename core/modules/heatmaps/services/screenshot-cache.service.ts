/**
 * In-memory cache for heatmap page screenshots to avoid redundant DB lookups.
 * Caches layout snapshot metadata with TTL-based expiration.
 *
 * Cache key: `${websiteId}:${normalizedPagePath}` — the website UUID, because
 * that is what `heatmap_page_snapshots` is keyed by. A `websiteId` here would produce
 * a permanent miss rather than an error.
 *
 * Still reached through a module-level singleton rather than injected, because
 * `lib/playwright-browser.ts`'s capture helper (`lib/playwright-screenshots.ts`)
 * reads it and is shared infrastructure that recordings and retention also use.
 * `initHeatmapsModule().start` is what calls it.
 */

import type { AppConfig } from "../../../config";

interface CachedScreenshot {
  s3Key: string;
  hash: string;
  docWidth: number;
  docHeight: number;
  expiresAt: number; // Timestamp when cache entry expires
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

class ScreenshotCache {
  private cache = new Map<string, CachedScreenshot>();
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, size: 0 };
  private ttlMs: number = 60 * 60 * 1000; // Default 1 hour (60 minutes)
  private maxEntries: number = 1000; // Max cached entries

  constructor(ttlMs?: number, maxEntries?: number) {
    if (ttlMs) this.ttlMs = Math.max(10_000, ttlMs); // Min 10 seconds
    if (maxEntries) this.maxEntries = Math.max(10, maxEntries); // Min 10 entries
  }

  /**
   * Generate cache key from website UUID and page path.
   */
  private cacheKey(websiteId: string, pagePath: string): string {
    return `${websiteId}:${pagePath}`;
  }

  /**
   * Get screenshot from cache if it exists and hasn't expired.
   * Updates cache hit/miss stats.
   */
  get(websiteId: string, pagePath: string): CachedScreenshot | null {
    const key = this.cacheKey(websiteId, pagePath);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry;
  }

  /**
   * Store screenshot in cache.
   * Automatically evicts oldest entry if cache is full.
   */
  /**
   * `expiresAt` is omitted from the parameter because this method derives it from
   * the cache's own TTL below. Requiring callers to pass a value it immediately
   * overwrites was the source of three type errors at the call sites.
   */
  set(
    websiteId: string,
    pagePath: string,
    screenshot: Omit<CachedScreenshot, "expiresAt">,
  ): void {
    const key = this.cacheKey(websiteId, pagePath);

    // Update expiration time
    const updated = {
      ...screenshot,
      expiresAt: Date.now() + this.ttlMs,
    };

    // If cache is at capacity, evict oldest entry
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
      }
    }

    this.cache.set(key, updated);
    this.stats.size = this.cache.size;
  }

  /**
   * Invalidate cache entry (call when new screenshot is captured/stored).
   */
  invalidate(websiteId: string, pagePath: string): void {
    const key = this.cacheKey(websiteId, pagePath);
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
    }
  }

  /**
   * Invalidate all cache entries for a website.
   * Useful when website is updated.
   */
  invalidateWebsite(websiteId: string): void {
    const prefix = `${websiteId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    this.stats.size = this.cache.size;
  }

  /**
   * Clear entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.stats.size = 0;
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): CacheStats & { hitRate: number } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;
    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 10000) / 100, // Percentage with 2 decimals
    };
  }

  /**
   * Update cache configuration.
   */
  configure(ttlMs?: number, maxEntries?: number): void {
    if (ttlMs) this.ttlMs = Math.max(10_000, ttlMs);
    if (maxEntries) this.maxEntries = Math.max(10, maxEntries);
  }
}

// Process-local singleton instance.
let _cache: ScreenshotCache | null = null;

/**
 * Get or create the global screenshot cache instance.
 */
export function getScreenshotCache(): ScreenshotCache {
  if (!_cache) {
    _cache = new ScreenshotCache();
  }
  return _cache;
}

/**
 * Initialize cache with custom TTL and max entries.
 * Call this during app startup to configure cache.
 */
export function initializeScreenshotCache(ttlMs?: number, maxEntries?: number): void {
  _cache = new ScreenshotCache(ttlMs, maxEntries);
}

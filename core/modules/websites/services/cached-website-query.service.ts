import type { Website, WebsiteQuery, WebsiteRole } from "../interfaces";

/** How long a resolved website stays cached. */
const TTL_MS = 5 * 60 * 1000;

/** Chance per write of sweeping expired entries, keeping the map bounded. */
const SWEEP_PROBABILITY = 0.05;

type CacheEntry = { website: Website | null; expiresAt: number };

/**
 * TTL cache in front of a `WebsiteQuery`.
 *
 * Every analytics request resolves a website reference before it can query
 * anything, so `getById` sits on the hottest path in the service. The lookup it
 * replaced (`lib/website-resolve`) cached for the same five minutes; without this
 * decorator the module refactor would have quietly turned one cached read into
 * two uncached ones per request.
 *
 * A decorator rather than caching inside the repository, so the caching policy is
 * a composition choice — tests and the outbox path can use the uncached query
 * directly, and nothing in the service layer knows either way.
 *
 * Deliberately not cached: `getRole`. Access decisions must reflect a revoked
 * membership immediately, and a five-minute window where a removed collaborator
 * still has access is not a trade worth making for one indexed lookup.
 */
export class CachedWebsiteQuery implements WebsiteQuery {
  /** Keyed by the caller's reference, which may be the id or another accepted form. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly inner: WebsiteQuery,
    private readonly ttlMs: number = TTL_MS,
  ) {}

  async getById(websiteRef: string): Promise<Website | null> {
    const now = Date.now();
    const hit = this.cache.get(websiteRef);
    if (hit && hit.expiresAt > now) return hit.website;

    const website = await this.inner.getById(websiteRef);

    // Negative results are cached too: a dashboard polling a deleted site would
    // otherwise hit the database on every request forever.
    this.cache.set(websiteRef, { website, expiresAt: now + this.ttlMs });

    // A reference that is not already the id gets the id cached too, so a later lookup
    // by either reaches the same entry. (This used to read `websiteRef === website.id ?
    // website.id : website.id` — both branches identical — left over from when a website
    // had a second `site_id` identifier. That column is gone.)
    if (website && websiteRef !== website.id) {
      this.cache.set(website.id, { website, expiresAt: now + this.ttlMs });
    }

    if (Math.random() < SWEEP_PROBABILITY) this.sweep(now);
    return website;
  }

  /** Not cached — the underlying list changes whenever the user adds a site. */
  async listOwnedBy(ownerId: string): Promise<Website[]> {
    return this.inner.listOwnedBy(ownerId);
  }

  /** Never cached; see the class note on why access checks stay live. */
  async getRole(websiteRef: string, userId: string): Promise<WebsiteRole | null> {
    return this.inner.getRole(websiteRef, userId);
  }

  /**
   * Drop cached entries for a website, by either identifier.
   *
   * Call after a mutation so the next read reflects it. Subscribing to
   * `website.updated` / `website.deleted` on the event bus is the intended wiring
   * — that way a change made anywhere in the process invalidates this cache
   * without the mutating code needing to know the cache exists.
   */
  invalidate(...websiteRefs: string[]): void {
    for (const ref of websiteRefs) this.cache.delete(ref);
  }

  /** Drop everything. */
  clear(): void {
    this.cache.clear();
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}

/**
 * The heatmaps module's public surface.
 *
 * Split by capability rather than exposed as one `IHeatmapsModule`, because the
 * five things that touch heatmaps want five disjoint slices of it:
 *
 * - the dashboard reads aggregates and a page snapshot (`HeatmapQuery`);
 * - the dashboard also deletes pages and uploads its own screenshot
 *   (`HeatmapMutations`), which the read path must not be able to reach;
 * - the tracker's ingest path only ever writes points and snapshots
 *   (`HeatmapIngest`), on the hottest code path in the product;
 * - the routes and the tracker ask for a Playwright capture
 *   (`HeatmapScreenshotCapture`) — the only capability that dials out to the
 *   public internet, with a latency and failure profile nothing else here has;
 * - the scheduler re-captures stale snapshots (`HeatmapScreenshotMaintenance`)
 *   and has no business being able to capture an arbitrary URL on demand.
 *
 * `HeatmapSettings` is separate again: it answers "where do I screenshot, and is
 * layout capture even on for this site" from an already-resolved website, and is
 * read per capture rather than per request.
 *
 * Read models are returned in wire shape (snake_case) because the dashboard
 * consumes them directly and the field names are part of the public contract.
 */

import type {
  HeatmapIngestEvent,
  HeatmapPointOut,
  TrackerEvent,
} from "../../../platform/lib/types";

/** Tracker event plus the request context needed by heatmap ingestion. */
export type HeatmapTrackerEvent = TrackerEvent & {
  clientUa?: string;
  heatmapLayoutEnabled?: boolean;
};

export type { HeatmapPointOut };

/** One page's heatmap totals, after paths differing only by dynamic ids are merged. */
export type HeatmapPageSummary = {
  page_path: string;
  click_count: number;
  scroll_count: number;
  /** Mean scroll depth as a percentage, 0–100. */
  avg_scroll: number;
  /** ISO 8601. */
  last_seen: string;
};

/**
 * The stored page background the dashboard renders points on top of.
 *
 * Both URLs are presigned and short-lived, so `*_expires_at` is part of the
 * contract rather than a hint — the client refetches rather than caching them.
 * `html_url` is the primary form (a DOM snapshot captured at the visitor's real
 * viewport); `image_url` is the JPEG fallback. Either may be absent, which is why
 * neither is required.
 */
export type HeatmapLayout = {
  image_url?: string;
  image_url_expires_at: string;
  html_url?: string;
  html_url_expires_at?: string;
  /**
   * Layout box this background was captured at, in CSS pixels. Authoritative for
   * rendering: points are normalized against these dimensions, so the preview must
   * lay the snapshot out at this width and scale from there. Measuring the rendered
   * iframe instead is circular — its width is whatever the panel gave it, and a
   * responsive page reflows to match.
   */
  doc_width: number;
  doc_height: number;
  /** Bucket this background was captured on — `desktop`, `tablet` or `mobile`. */
  device_type: string;
  /**
   * True when no background exists for the requested bucket and another one is being
   * shown instead. The layout underneath will not match the points exactly, and the
   * dashboard says so rather than presenting it as an accurate overlay.
   */
  device_fallback: boolean;
};

/**
 * A website reference already resolved to every identifier the heatmap queries
 * need. Passed down instead of a loose `websiteRef` so nothing below the service
 * layer resolves anything.
 *
 * The two ids are the subtle part of this domain and both are `string`, so a
 * mix-up is invisible to the compiler:
 * - `websiteId` (`websites.id`) keys `heatmap_points` and
 *   `heatmap_page_snapshots` — both cast it to `uuid` in SQL.
 * - `websiteId` (`websites.website_id`) keys `analytics_events` rows and every S3
 *   object path under `heatmap-screenshots/`.
 */
export type ResolvedWebsite = {
  websiteId: string;
  /** `websites.url` — bare hostname, no scheme. Empty when resolution failed. */
  siteUrl: string;
};

/** Read access to heatmap aggregates, for the dashboard. */
export interface HeatmapQuery {
  /**
   * Every page with heatmap data, busiest first.
   *
   * Paths that normalize to the same shape (`/orders/8213` and `/orders/9902`
   * both become `/orders/:id`) are merged here rather than in SQL, because rows
   * written before a normalization rule existed still carry the raw path.
   */
  listPages(websiteRef: string): Promise<{ pages: HeatmapPageSummary[] }>;

  /**
   * Click or scroll points for one page.
   *
   * Returns the normalized `page_path` it actually matched on, so the client can
   * tell that `/orders/8213` was answered from the `/orders/:id` bucket.
   */
  getPoints(
    websiteRef: string,
    pagePath: string,
    eventType: string,
  ): Promise<{ page_path: string; points: HeatmapPointOut[] }>;

  /**
   * The page background for a heatmap overlay, or `{ layout: null }`.
   *
   * A miss is a routine state, not an error: it triggers a background Playwright
   * capture and the dashboard renders points without a backdrop until the next
   * poll. A stale snapshot is returned as-is while a refresh runs behind it —
   * showing three-day-old pixels beats showing nothing.
   */
  getLayoutSnapshot(
    websiteRef: string,
    pagePath: string,
    device?: string,
  ): Promise<{ layout: HeatmapLayout | null }>;
}

/** Destructive and write operations, kept where the read path cannot reach them. */
export interface HeatmapMutations {
  /**
   * Store a screenshot the dashboard rendered itself (html2canvas).
   *
   * Rejects rather than silently storing garbage: the buffer must be a plausible
   * JPEG within size bounds, and the website must still exist. Callers surface
   * the thrown message to the user, so the messages are part of the contract.
   */
  saveDashboardScreenshot(
    websiteRef: string,
    pagePath: string,
    imageBase64: string,
    docWidth: number,
    docHeight: number,
  ): Promise<void>;

  /** Delete all heatmap points for the given pages. Unknown paths are ignored. */
  bulkDeletePages(websiteRef: string, pagePaths: string[]): Promise<void>;
}

/**
 * The tracker write path.
 *
 * Deliberately the narrowest interface here: it is called once per ingest flush
 * with a mixed batch of clicks, scroll depths, screenshots and DOM snapshots, and
 * must not be able to read or delete anything. Buffering and flushing are the
 * implementation's business — `processEvents` returns as soon as the batch is
 * queued, and `shutdown` is the only way to force a drain.
 */
export interface HeatmapIngest {
  /**
   * Ingest a batch of interaction events.
   *
   * Takes raw tracker events with per-request context attached; this module filters them
   * by type and projects them onto its own row shape. That projection used to live in
   * ingest, which meant ingest knew both this module's column names and which event types
   * are heatmap types.
   *
   * `batchId` must be stable across redeliveries. It is carried through this module's
   * internal buffer and used to guard the upsert, because `heatmap_points` aggregates
   * additively — a replayed batch inflates click counts rather than duplicating rows,
   * which nothing downstream can distinguish from real traffic.
   */
  processEvents(batchId: string, events: readonly HeatmapTrackerEvent[]): Promise<void>;

  /** Flush buffers and stop the timer. Call once, on process shutdown. */
  shutdown(): Promise<void>;
}

/**
 * The tracker-shaped event the ingest queue hands over.
 *
 * Imported and re-exported rather than `export type { … } from`, which would
 * re-export the name without binding it locally — leaving `HeatmapIngest` above
 * unable to reference it.
 */
export type HeatmapIngestEventInput = HeatmapIngestEvent;

/** What a Playwright capture is asked to do. */
export type CaptureScreenshotRequest = {
  /** Target page URL to screenshot. */
  pageUrl: string;

  /** Heatmap page path (usually the pathname of the target URL). */
  pagePath: string;

  /** Viewport width for the capture. Defaults to 1920. */
  viewportWidth?: number;

  /** Viewport height for the capture. Defaults to 1080. */
  viewportHeight?: number;

  /** Wait for this CSS selector before capturing. */
  waitForSelector?: string;

  /** JPEG quality 1–100. Defaults to 85. */
  jpegQuality?: number;

  /**
   * Capture and store even when an identical screenshot already exists.
   * Without it, a matching content hash short-circuits the whole capture.
   */
  force?: boolean;

  /** Report whether a screenshot exists without launching a browser. */
  checkOnly?: boolean;
};

/** Outcome of one capture. `stored: false` means an existing image was reused. */
export type CaptureScreenshotResult = {
  success: boolean;
  s3Key?: string;
  imageHash?: string;
  imageWidth?: number;
  imageHeight?: number;
  sizeBytes?: number;
  stored: boolean;
  message?: string;
};

/** Per-request outcome of a batch capture. One failure never fails the batch. */
export type BatchCaptureScreenshotResult = {
  pagePath: string;
  success: boolean;
  s3Key?: string;
  stored?: boolean;
  message?: string;
  error?: string;
};

/** Raised when a requested capture URL is outside the website's registered domain. */
export class ScreenshotTargetNotAllowedError extends Error {
  constructor(pageUrl: string) {
    super(`page_url not allowed: ${pageUrl}`);
    this.name = "ScreenshotTargetNotAllowedError";
  }
}

/**
 * On-demand page capture via a headless browser.
 *
 * Separate from every other capability because of what it costs: it launches a
 * browser, fetches a third-party page, and uploads to object storage. Anything
 * holding this reference can make the server issue outbound requests, so it is
 * handed out only to the authenticated dashboard routes and the tracker endpoint
 * that already validated the target against the site's registered domain.
 */
export interface HeatmapScreenshotCapture {
  /** Throws when the website is unknown or the capture fails. */
  capture(websiteRef: string, request: CaptureScreenshotRequest): Promise<CaptureScreenshotResult>;

  /**
   * Capture several pages, sequentially.
   *
   * Sequential on purpose — a parallel batch exhausts the browser pool, and this
   * endpoint accepts up to 50 pages. Errors are reported per request rather than
   * thrown, so one dead page does not lose the other 49 results.
   */
  captureBatch(
    websiteRef: string,
    requests: CaptureScreenshotRequest[],
  ): Promise<BatchCaptureScreenshotResult[]>;
}

/**
 * Scheduled upkeep of stored snapshots.
 *
 * Split from `HeatmapScreenshotCapture` so the cron job cannot capture arbitrary
 * URLs: this picks its own targets from rows that already exist, which is a much
 * smaller thing to hand an unattended caller.
 */
export interface HeatmapScreenshotMaintenance {
  /**
   * Queue background re-captures for snapshots older than `staleDays`.
   *
   * Returns how many were queued, not how many succeeded — captures run detached
   * so a slow page cannot stall the cron tick.
   */
  refreshStaleScreenshots(staleDays?: number): Promise<{ queued: number }>;
}

/**
 * Per-website heatmap configuration, read once per capture.
 *
 * Separate from `HeatmapQuery` because the question is different and so is the
 * caller: not "what did visitors do" but "may I capture this site, and at what
 * URL". Returning the resolved identifiers alongside the flag is what lets the
 * capture path avoid re-resolving; returning `null` for an unknown website is why
 * capture refuses instead of silently writing rows under a dangling id.
 *
 * This is also the seam the tracker's `heatmap_enabled` / `heatmap_layout_enabled`
 * read (`lib/website-for-tracker.ts`) belongs behind once the tracker routes are
 * composed rather than imported.
 */
export interface HeatmapSettings {
  /** `null` when the website does not exist. */
  getCaptureTarget(
    websiteRef: string,
  ): Promise<(ResolvedWebsite & { layoutEnabled: boolean }) | null>;
}

/**
 * Reads for the raw API.
 *
 * Separate from `HeatmapQuery` because the raw API returns unmerged, unnormalised rows
 * — it is a data-export surface, not the dashboard's. `platform/public-api` used to import
 * `services/heatmap-page-query.service` directly to get at these.
 */
export interface HeatmapRawReads {
  listPagesRaw(websiteId: string): Promise<{ pages: HeatmapPageSummary[] }>;

  getPointsRaw(
    websiteId: string,
    pagePath: string,
    eventType: string,
  ): Promise<{
    /** The normalised path actually queried — may differ from the one requested. */
    page_path: string;
    /** Defaults to `click` when the caller sends none. */
    event_type: string;
    points: HeatmapPointOut[];
  }>;
}

/**
 * The per-page totals row, as the reads repository returns it.
 *
 * Moved here from `platform/lib/types.ts` for the same reason as
 * `RecordingsModule`'s `SessionMetaRow`: only this module ever read it.
 */
export type PageSummaryRow = {
  page_path: string;
  click_count: number;
  scroll_count: number;
  avg_scroll: number;
  /** ISO 8601; driver may return timestamps as strings instead of `Date`. */
  last_seen: string;
};

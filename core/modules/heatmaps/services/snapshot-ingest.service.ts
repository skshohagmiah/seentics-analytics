import { createHash } from "node:crypto";
import {
  getCachedSnapshotSha256,
  getLayoutSnapshot,
  upsertLayoutSnapshot,
  upsertLayoutHtmlSnapshot,
} from "../lib/layout-db";
import { extractPath, normalizeHeatmapPagePath } from "../lib/paths";
import { heatmapScreenshotKey, heatmapHtmlSnapshotKey, layoutPathSlot } from "../lib/keys";
import { snapshotDeviceBucket, snapshotDeviceBucketForWidth } from "../lib/device";
import { validateScreenshotTargetUrl } from "../../../platform/lib/origin";
import { putJpeg, putHtml } from "../../../platform/lib/s3";
import { captureAndStoreScreenshot } from "../lib/playwright-screenshots";
import type { HeatmapIngestEvent, ScreenshotJob } from "../../../platform/lib/types";
import type { TrackerWebsites } from "../../websites/interfaces";
import { log as baseLog } from "../../../platform/lib/logger";
import { isJpeg } from "./shared";

const log = baseLog.child({ category: "heatmap" });

/** Below this a "JPEG" cannot contain a real page. */
const MIN_JPEG_BYTES = 400;
/** Below this a document dimension is a client bug; render at a sane default instead. */
const MIN_DOC_PX = 200;
const FALLBACK_DOC_W = 1280;
const FALLBACK_DOC_H = 800;
/** Below this an HTML snapshot cannot be a real page. */
const MIN_HTML_BYTES = 100;

/**
 * The page-background half of heatmap ingest.
 *
 * A heatmap is points drawn over a picture of the page, and this is where the picture
 * comes from: the tracker's own html2canvas JPEG, its DOM snapshot, and the higher-quality
 * Playwright re-capture triggered off the back of them.
 *
 * Split from `HeatmapIngestService` because the two halves share nothing but a bucket name. The
 * engine buffers points and drains them on a timer against Postgres; this talks to object
 * storage and the layout tables, one item at a time, and is where every deduplication
 * decision lives. Keeping them together meant the engine could not be exercised without
 * S3, and the storage paths could not be exercised without starting a timer.
 *
 * Deduplication is layered on purpose — an in-process cache, then the stored row, then
 * the upload — because the tracker re-sends the same page image on every session and the
 * upload is the expensive part.
 */
export class SnapshotIngestService {
  /** Paths already given a Playwright capture this lifecycle. Prevents re-capture spam. */
  private readonly playwrightTriggered = new Set<string>();

  constructor(
    private readonly bucket: string,
    /**
     * `null` on a bus-less engine — see `heatmapIngestService`. Publishing is best-effort
     * there rather than a failure.
     */
    /**
     * Resolves the website so the SSRF guard can check a capture target against the
     * site's registered domain. `null` means auto-capture is skipped rather than
     * performed unguarded.
     */
    private readonly websites: TrackerWebsites | null,
  ) {}

  /**
   * Store one tracker-supplied page image.
   *
   * Three chances to avoid the upload, cheapest first: the in-process hash cache, then
   * the stored row's hash on a cold cache or after a restart, then the write itself.
   */
  async storeScreenshot(job: ScreenshotJob): Promise<void> {
    if (
      !job.websiteId ||
      !job.heatmapLayoutEnabled ||
      job.jpeg.length < MIN_JPEG_BYTES ||
      !isJpeg(job.jpeg)
    ) {
      log.info({
        msg: "heatmap_tracker_screenshot_skipped",
        url: job.url,
        website_id: job.websiteId,
        layout_enabled: job.heatmapLayoutEnabled,
        jpeg_bytes: job.jpeg.length,
      });
      return;
    }

    const norm = normalizeHeatmapPagePath(extractPath(job.url));
    log.info({
      msg: "heatmap_tracker_screenshot_received",
      url: job.url,
      norm,
      website_id: job.websiteId,
      jpeg_bytes: job.jpeg.length,
    });

    // The tracker's html2canvas image is a stand-in; Playwright renders the real page.
    // Once per path per lifecycle, off the back of the first image that arrives for it.
    this.triggerPlaywrightCapture(job.websiteId, norm, job.url);

    const sum = createHash("sha256").update(job.jpeg).digest("hex");

    // This job carries no user agent — it is the tracker's own html2canvas render,
    // queued from the page. The document width is the next best signal for which
    // layout was captured, and for a page that does not scroll horizontally it is
    // the viewport width.
    const device = snapshotDeviceBucketForWidth(job.docW);

    const cachedSha256 = getCachedSnapshotSha256(job.websiteId, norm, device);
    if (cachedSha256 === sum) return;
    if (cachedSha256 === null) {
      const existing = await getLayoutSnapshot(job.websiteId, norm, device);
      if (existing?.content_sha256 === sum && existing.device_type === device) return;
    }

    const key = heatmapScreenshotKey(job.websiteId, layoutPathSlot(job.websiteId, norm, device));
    await putJpeg(this.bucket, key, job.jpeg);

    const { w: docW, h: docH } = plausibleDocSize(job.docW, job.docH, job.url);
    await upsertLayoutSnapshot(job.websiteId, norm, device, key, sum, docW, docH);
    log.info({
      msg: "heatmap_tracker_screenshot_stored",
      url: job.url,
      norm,
      website_id: job.websiteId,
      s3_key: key,
      doc_w: docW,
      doc_h: docH,
      device,
    });

  }

  /** Store one tracker DOM snapshot, skipping an unchanged one. */
  async storeDomSnapshot(ev: HeatmapIngestEvent): Promise<void> {
    if (!ev.websiteId || !ev.heatmapLayoutEnabled) return;

    const html = typeof ev.data?.html === "string" ? ev.data.html : null;
    if (!html || html.length < MIN_HTML_BYTES) return;

    const norm = normalizeHeatmapPagePath(extractPath(ev.url ?? ""));
    log.info({
      msg: "heatmap_dom_snapshot_received",
      url: ev.url,
      norm,
      website_id: ev.websiteId,
      html_bytes: html.length,
    });

    // Same bucketing the points get (`point-mapping` calls `deviceTypeFromUA` on this
    // exact field), so a background and the clicks drawn on it always agree on layout.
    const device = snapshotDeviceBucket(ev.clientUa);

    const sum = createHash("sha256").update(html).digest("hex");
    const existing = await getLayoutSnapshot(ev.websiteId, norm, device);
    // Three conditions: a row carrying the same hash but no HTML key is a JPEG-only
    // snapshot and still needs the HTML written, and a row from a *different* bucket
    // is not this bucket's background however identical its bytes are.
    if (existing?.html_s3_key && existing.content_sha256 === sum && existing.device_type === device) {
      return;
    }

    const { w: docW, h: docH } = plausibleDocSize(ev.docW ?? 0, ev.docH ?? 0, ev.url ?? "", false);

    const key = heatmapHtmlSnapshotKey(ev.websiteId, layoutPathSlot(ev.websiteId, norm, device));
    await putHtml(this.bucket, key, html);
    await upsertLayoutHtmlSnapshot(ev.websiteId, norm, device, key, sum, docW, docH);
    log.info({
      msg: "heatmap_dom_snapshot_stored",
      url: ev.url,
      norm,
      website_id: ev.websiteId,
      s3_key: key,
      device,
    });
  }

  /**
   * Ask Playwright for a proper capture of a page, once per path per lifecycle.
   *
   * Fire-and-forget: this runs off an ingest flush, and no visitor's data should wait on
   * a browser launch. The target is checked against the website's registered domain
   * first — this is an unattended path fed by a URL from a public endpoint, so an
   * unguarded capture here would be an SSRF with no user to attribute it to.
   */
  private triggerPlaywrightCapture(websiteId: string, norm: string, url: string): void {
    const key = `${websiteId}:${norm}`;
    if (this.playwrightTriggered.has(key)) return;
    this.playwrightTriggered.add(key);

    if (!this.websites) {
      // No resolver means no way to validate the domain, and capturing unguarded would
      // be the SSRF this check exists to prevent.
      log.warn({ msg: "heatmap_playwright_auto_skipped_no_resolver", norm });
      return;
    }

    this.websites
      .resolve(websiteId)
      .then((website) => {
        if (!website || !validateScreenshotTargetUrl(url, website.url)) return;
        return captureAndStoreScreenshot(url, this.bucket, websiteId, norm, { force: true }).then(
          (r) => {
            if (r?.stored) log.info({ msg: "heatmap_playwright_auto_captured", url, norm });
          },
        );
      })
      .catch((err) =>
        log.warn({ msg: "heatmap_playwright_auto_failed", url, norm, err: String(err) }),
      );
  }
}

/**
 * Document dimensions, with fallbacks for a client that reported nonsense.
 *
 * The numbers matter: heatmap points are fractions of the document, so a zero here would
 * put every point at the origin. `warn` is off for DOM snapshots, where an absent
 * dimension is routine rather than a symptom.
 */
function plausibleDocSize(
  docW: number,
  docH: number,
  url: string,
  warn = true,
): { w: number; h: number } {
  // `!Number.isFinite` is not redundant with the `< MIN` check below: that comparison is
  // *false* for NaN, so without this the fallback is skipped for the one input class that
  // cannot be stored at all. The tracker schema rejects a non-finite `doc_w` today, so
  // this half is defence in depth — but `storeDashboardScreenshot` shares this shape and
  // is reachable with NaN from `/save-screenshot`, so the two stay consistent.
  let w = Math.trunc(docW);
  let h = Math.trunc(docH);
  if (!Number.isFinite(w) || w < MIN_DOC_PX) {
    if (warn) log.warn({ msg: "heatmap_screenshot_missing_doc_w", url, fallback: FALLBACK_DOC_W });
    w = FALLBACK_DOC_W;
  }
  if (!Number.isFinite(h) || h < MIN_DOC_PX) {
    if (warn) log.warn({ msg: "heatmap_screenshot_missing_doc_h", url, fallback: FALLBACK_DOC_H });
    h = FALLBACK_DOC_H;
  }
  return { w, h };
}

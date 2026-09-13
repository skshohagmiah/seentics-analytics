import { env } from "../../../config";
import { validateScreenshotTargetUrl } from "../../../platform/lib/origin";
import { upsertLayoutSnapshot } from "../lib/layout-db";
import { snapshotDeviceBucketForWidth } from "../lib/device";
import { normalizeHeatmapPagePath } from "../lib/paths";
import { captureAndStoreScreenshot } from "../lib/playwright-screenshots";
import type {
  BatchCaptureScreenshotResult,
  CaptureScreenshotRequest,
  CaptureScreenshotResult,
  HeatmapScreenshotCapture,
  HeatmapSettings,
  ResolvedWebsite,
} from "../interfaces";

/** Hard ceiling on one page load. Playwright's own default would hang the request. */
const CAPTURE_TIMEOUT_MS = 30_000;

/**
 * Capture a page with Playwright and record the result as the page's layout
 * snapshot.
 *
 * Takes already-resolved identifiers: `websiteId` namespaces the S3 object, the
 * website UUID keys the snapshot row, and the two are not interchangeable. The
 * caller is responsible for having established that the website exists — this
 * function would otherwise happily write a snapshot row under a dangling id.
 *
 * Deduplication lives in `captureAndStoreScreenshot`: a matching content hash
 * skips the browser launch entirely, which is why `force` exists and why
 * `stored: false` is a success rather than a failure.
 */
async function captureAndUpsert(
  resolved: ResolvedWebsite,
  request: CaptureScreenshotRequest,
): Promise<CaptureScreenshotResult> {
  const normalizedPagePath = normalizeHeatmapPagePath(request.pagePath);
  const config = env();

  const result = await captureAndStoreScreenshot(
    request.pageUrl,
    config.s3.heatmapBucket,
    resolved.websiteId,
    normalizedPagePath,
    {
      viewportWidth: request.viewportWidth,
      viewportHeight: request.viewportHeight,
      waitForSelector: request.waitForSelector,
      jpegQuality: request.jpegQuality,
      force: request.force,
      checkOnly: request.checkOnly,
      timeoutMs: CAPTURE_TIMEOUT_MS,
    },
  );

  // `null` means check-only mode found nothing — a legitimate answer, not an error.
  if (!result) {
    return {
      success: true,
      stored: false,
      message: "No existing screenshot found",
    };
  }

  // Idempotent: re-running a capture for the same page rewrites the same row.
  if (result.s3Key) {
    await upsertLayoutSnapshot(
      resolved.websiteId,
      normalizedPagePath,
      // The capture rendered at this width, so that is the layout it depicts.
      snapshotDeviceBucketForWidth(request.viewportWidth ?? 1920),
      result.s3Key,
      result.hash,
      result.width,
      result.height,
    );
  }

  return {
    success: true,
    s3Key: result.s3Key,
    imageHash: result.hash,
    imageWidth: result.width,
    imageHeight: result.height,
    sizeBytes: result.sizeBytes,
    stored: result.stored,
    message: result.stored
      ? "Screenshot captured and stored"
      : "Using existing identical screenshot (deduplication)",
  };
}

/**
 * Thrown when a capture target is not on the website's own domain.
 *
 * Its own type so the routes can answer 403 rather than the generic 400 they give an
 * unreachable page — a refused target is a different fact from a broken one.
 */
export class ScreenshotTargetNotAllowedError extends Error {
  constructor(pageUrl: string) {
    super(`page_url not allowed: ${pageUrl}`);
    this.name = "ScreenshotTargetNotAllowedError";
  }
}

/**
 * On-demand page capture for the dashboard.
 *
 * Resolves the website reference once, through the `HeatmapSettings` port, and
 * hands resolved identifiers down. The functions this replaced each called
 * `resolveWebsiteIdsLenient` and then looked the same website up a *second* time
 * via `getWebsiteBySiteId` purely to obtain the UUID they had already resolved.
 */
export class HeatmapScreenshotService implements HeatmapScreenshotCapture {
  constructor(
    private readonly settings: HeatmapSettings,
  ) {
    // Bound up front so it can be handed to `HeatmapAutoCapture` as a plain
    // function without the caller having to remember to bind it.
    this.captureForResolved = this.captureForResolved.bind(this);
  }

  async capture(
    websiteRef: string,
    request: CaptureScreenshotRequest,
  ): Promise<CaptureScreenshotResult> {
    const target = await this.settings.getCaptureTarget(websiteRef);
    // Message preserved verbatim — the route returns it to the client as-is.
    if (!target) throw new Error("Website not found");
    return this.captureForResolved(target, request);
  }

  /**
   * The capture entry point for callers that already resolved the website —
   * `HeatmapAutoCapture` in particular, which is invoked from a request that has
   * done the resolution work.
   */
  async captureForResolved(
    resolved: ResolvedWebsite,
    request: CaptureScreenshotRequest,
  ): Promise<CaptureScreenshotResult> {
    /*
     * SSRF guard, here rather than at the routes.
     *
     * Capture is the one capability in the product that makes the server fetch a URL a
     * caller supplied, and the result is stored and readable afterwards through
     * `/layout-snapshot` — so an unchecked target is not just a request, it is
     * exfiltration. `validateScreenshotTargetUrl` existed and was correct, but only two
     * of the three entry points called it: the anonymous tracker route and the engine's
     * auto-trigger. The two authenticated dashboard routes passed `page_url` straight
     * through, and registration is open, so an account was the only prerequisite.
     *
     * Every path reaches capture through this method, which is why the check belongs
     * here. The callers that already check keep theirs — they can answer with a proper
     * status code before doing any work, and a guard that only exists at the edge is
     * exactly what failed.
     *
     * `lib/playwright-screenshots` rewrites localhost to `host.docker.internal` for local
     * development, so without this the loopback case actively reached the Docker host.
     */
    if (!validateScreenshotTargetUrl(request.pageUrl, resolved.siteUrl)) {
      throw new ScreenshotTargetNotAllowedError(request.pageUrl);
    }

    const result = await captureAndUpsert(resolved, request);

    // Announced only when an image was actually written. A deduplicated or
    // check-only call changed nothing, and an event saying otherwise would make
    // any consumer counting captures wrong.
    if (result.stored && result.s3Key) {
    }

    return result;
  }

  /**
   * Capture several pages for one website, resolving it once for the whole batch.
   *
   * Sequential: the batch endpoint accepts up to 50 pages and a parallel run
   * exhausts the browser pool. Per-request errors are returned rather than thrown
   * so one unreachable page does not discard the other results.
   */
  async captureBatch(
    websiteRef: string,
    requests: CaptureScreenshotRequest[],
  ): Promise<BatchCaptureScreenshotResult[]> {
    const target = await this.settings.getCaptureTarget(websiteRef);
    if (!target) throw new Error("Website not found");

    const results: BatchCaptureScreenshotResult[] = [];
    for (const request of requests) {
      try {
        const result = await this.captureForResolved(target, request);
        results.push({
          pagePath: request.pagePath,
          success: true,
          s3Key: result.s3Key,
          stored: result.stored,
          message: result.message,
        });
      } catch (error) {
        results.push({
          pagePath: request.pagePath,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
}

export type { CaptureScreenshotRequest, CaptureScreenshotResult };

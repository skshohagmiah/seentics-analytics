import { createHash } from "node:crypto";
import { env } from "../../../config";
import { heatmapScreenshotKey, layoutPathSlot } from "../lib/keys";
import { coerceSnapshotDeviceBucket, type SnapshotDeviceBucket } from "../lib/device";
import { getLayoutSnapshot, upsertLayoutSnapshot } from "../lib/layout-db";
import { presignGet, putJpeg } from "../../../platform/lib/s3";
import type { HeatmapLayout, ResolvedWebsite } from "../interfaces";
import { isJpeg } from "./shared";

/**
 * How old a stored snapshot may be before a background re-capture is triggered.
 * Sites get redesigned; three-day-old pixels are still worth rendering while the
 * fresh capture runs.
 */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** Upper bound on a dashboard-rendered screenshot. Anything larger is a bug or an attack. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Below this a "JPEG" cannot contain a real page. */
const MIN_UPLOAD_BYTES = 400;

/** Fallbacks when the client reports implausible document dimensions. */
const FALLBACK_DOC_WIDTH = 1280;
const FALLBACK_DOC_HEIGHT = 800;
const MIN_PLAUSIBLE_DOC_PX = 200;

/**
 * The stored snapshot for a page, with presigned URLs.
 *
 * `missing` and `stale` are reported rather than acted on, so the decision to
 * trigger a capture stays with `HeatmapService` — this function does no I/O beyond
 * the read and the presign.
 */
export async function readLayoutSnapshot(
  websiteId: string,
  normalizedPath: string,
  device: SnapshotDeviceBucket = "desktop",
): Promise<{ layout: HeatmapLayout | null; missing: boolean; stale: boolean }> {
  const row = await getLayoutSnapshot(websiteId, normalizedPath, device);

  // A row counts as present if either a JPEG (`s3_key`) or a DOM HTML snapshot
  // (`html_s3_key`) is stored. `upsertLayoutHtmlSnapshot` inserts with `s3_key=''`,
  // so checking only `s3_key` would treat a perfectly good DOM snapshot as a miss
  // and hide it behind an unnecessary Playwright capture.
  if (!row?.s3_key && !row?.html_s3_key) {
    return { layout: null, missing: true, stale: false };
  }

  const stale =
    !!row.updated_at && Date.now() - new Date(row.updated_at).getTime() > STALE_MS;

  const cfg = env();
  const expMs = cfg.presignTtlMs;
  const deadline = new Date(Date.now() + expMs).toISOString();

  // The DOM snapshot is the primary form; the JPEG is the fallback for pages
  // captured before DOM snapshots existed or where the DOM upload failed.
  const htmlUrl = row.html_s3_key
    ? await presignGet(cfg.s3.heatmapBucket, row.html_s3_key, expMs)
    : undefined;
  const imageUrl = row.s3_key ? await presignGet(cfg.s3.heatmapBucket, row.s3_key, expMs) : undefined;

  return {
    layout: {
      image_url: imageUrl,
      image_url_expires_at: deadline,
      html_url: htmlUrl,
      html_url_expires_at: htmlUrl ? deadline : undefined,
      doc_width: row.doc_width,
      doc_height: row.doc_height,
      device_type: row.device_type,
      device_fallback: row.device_type !== device,
    },
    missing: false,
    stale,
  };
}

/**
 * Decode a dashboard-supplied JPEG, rejecting anything implausible.
 *
 * Throws rather than returning null because each rejection reason is surfaced to
 * the user by the route, and "why was my screenshot refused" is only answerable
 * with the specific reason.
 */
export function decodeJpegUpload(imageBase64: string): Buffer {
  let imgStr = (imageBase64 ?? "").trim();
  // Browsers send `data:image/jpeg;base64,…`; strip the prefix if present.
  const dataUrlIdx = imgStr.indexOf("base64,");
  if (dataUrlIdx >= 0) imgStr = imgStr.slice(dataUrlIdx + 7);

  let buf: Buffer;
  try {
    buf = Buffer.from(imgStr, "base64");
  } catch {
    throw new Error("invalid base64 image data");
  }

  if (buf.length < MIN_UPLOAD_BYTES || buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`screenshot size out of range: ${buf.length} bytes`);
  }
  if (!isJpeg(buf)) {
    throw new Error("image is not a valid JPEG");
  }
  return buf;
}

/**
 * Store a screenshot and point the page's snapshot row at it.
 *
 * Both identifiers are needed and they are not interchangeable: the S3 key is
 * namespaced by `websiteId`, the snapshot row is keyed by the website UUID. Returns
 * the key so the caller can report what it wrote.
 */
export async function storeDashboardScreenshot(
  resolved: ResolvedWebsite,
  normalizedPath: string,
  jpeg: Buffer,
  docWidth: number,
  docHeight: number,
): Promise<string> {
  const cfg = env();
  const sum = createHash("sha256").update(jpeg).digest("hex");

  // html2canvas occasionally reports 0 for a page it could not measure. Storing
  // that would make the overlay render at zero size, so fall back to a common
  // desktop viewport instead of refusing the screenshot.
  // Non-finite is checked separately because a `< MIN` comparison is *false* for NaN,
  // so the fallback was skipped for exactly the input that needed it most. `/save-screenshot`
  // reaches this with `Number(body.doc_width)`, which is NaN for any non-numeric field,
  // and the value lands in an integer column.
  let dW = Math.trunc(docWidth ?? 0);
  let dH = Math.trunc(docHeight ?? 0);
  if (!Number.isFinite(dW) || dW < MIN_PLAUSIBLE_DOC_PX) dW = FALLBACK_DOC_WIDTH;
  if (!Number.isFinite(dH) || dH < MIN_PLAUSIBLE_DOC_PX) dH = FALLBACK_DOC_HEIGHT;

  // The dashboard renders its own capture at a desktop width; if a caller ever
  // renders narrower it should pass the bucket through rather than defaulting here.
  const device = coerceSnapshotDeviceBucket("desktop");
  const key = heatmapScreenshotKey(
    resolved.websiteId,
    layoutPathSlot(resolved.websiteId, normalizedPath, device),
  );
  await putJpeg(cfg.s3.heatmapBucket, key, jpeg);
  await upsertLayoutSnapshot(resolved.websiteId, normalizedPath, device, key, sum, dW, dH);
  return key;
}

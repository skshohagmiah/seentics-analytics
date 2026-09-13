import { deviceTypeFromUA } from "../lib/device";
import { extractPath, normalizeHeatmapPagePath } from "../lib/paths";
import type { HeatmapIngestEvent, HeatmapPointRow, ScreenshotJob } from "../../../platform/lib/types";
import { isJpeg } from "./heatmap-data-normalization.service";

/**
 * Tracker events to storable rows.
 *
 * Split out of `heatmap-ingest.service` because none of it touches the engine's state:
 * these are total functions from an event to a row, and every hostile input the tracker
 * can send — a coordinate that is a string, a viewport of zero, an image that is not a
 * JPEG — is decided here. That made them the part of the engine most worth testing and
 * the part hardest to reach, sitting behind a class that opens a timer in its
 * constructor and needs a bucket, a bus and a website resolver to exist at all.
 *
 * The two scale factors below are a wire contract the dashboard divides by; see
 * `HeatmapPointOut` and `tests/point-scaling.test.ts`.
 */

/** Largest tracker-supplied screenshot accepted. Beyond this it is a bug or an attack. */
const maxScreenshotBytes = 4 << 20;

function toFloat(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function stringVal(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function viewportCap(m: Record<string, unknown> | undefined, key: string): number | null {
  if (!m) return null;
  const v = m[key];
  const f =
    typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : null;
  if (f == null || !Number.isFinite(f)) return null;
  const i = Math.round(f);
  if (i < 100 || i > 10_000) return null; // realistic CSS viewport range
  return i;
}

function decodeScreenshotImage(data: Record<string, unknown> | undefined): Uint8Array | null {
  if (!data) return null;
  let imgStr = stringVal(data.image).trim();
  if (!imgStr) return null;
  const i = imgStr.indexOf("base64,");
  if (i >= 0) imgStr = imgStr.slice(i + 7);
  let buf: Buffer;
  try {
    buf = Buffer.from(imgStr, "base64");
  } catch {
    return null;
  }
  if (buf.length < 400 || buf.length > maxScreenshotBytes || !isJpeg(buf)) return null;
  return buf;
}

/**
 * Turn tracker events into storable cells.
 *
 * The two event types share `x_percent`/`y_percent` but not their scale: a click is
 * stored at 10000× (so the heatmap does not band at 1% granularity) and a scroll depth
 * at 100×. Readers must divide by the matching factor — see `HeatmapPointOut`.
 *
 * The two factors are a wire contract the dashboard divides by, written down nowhere the
 * compiler can check, so a change here has to fail `tests/point-scaling.test.ts` rather
 * than a rendered heatmap.
 */
export function eventsToPoints(events: HeatmapIngestEvent[]): HeatmapPointRow[] {
  const points: HeatmapPointRow[] = [];
  for (const ev of events) {
    const ua = ev.clientUa ?? "";
    const device = deviceTypeFromUA(ua);
    const data = ev.data ?? {};
    const pagePath = normalizeHeatmapPagePath(extractPath(ev.url ?? ""));

    if (ev.type === "heatmap_click") {
      const nx = Math.min(1, Math.max(0, toFloat(data.nx)));
      const ny = Math.min(1, Math.max(0, toFloat(data.ny)));
      points.push({
        websiteId: ev.websiteId,
        pagePath,
        eventType: "click",
        deviceType: device,
        xPercent: Math.round(nx * 10000),
        yPercent: Math.round(ny * 10000),
        targetSelector: stringVal(data.target),
        capVw: viewportCap(data, "vw"),
        capVh: viewportCap(data, "vh"),
      });
    } else if (ev.type === "heatmap_scroll") {
      const depth = Math.min(1, Math.max(0, toFloat(data.depth)));
      points.push({
        websiteId: ev.websiteId,
        pagePath,
        eventType: "scroll",
        deviceType: device,
        xPercent: 0,
        yPercent: Math.round(depth * 100),
        targetSelector: "",
        capVw: viewportCap(data, "vw"),
        capVh: viewportCap(data, "vh"),
      });
    }
  }
  return points;
}

export function eventsToScreenshotJobs(websiteId: string, events: HeatmapIngestEvent[]): ScreenshotJob[] {
  const jobs: ScreenshotJob[] = [];
  for (const ev of events) {
    if (ev.type !== "heatmap_screenshot") continue;
    const raw = decodeScreenshotImage(ev.data);
    if (!raw) continue;
    const dm = ev.data ?? {};
    let dw = Math.trunc(ev.docW ?? 0);
    let dh = Math.trunc(ev.docH ?? 0);
    const dwData = toInt(dm.doc_w);
    const dhData = toInt(dm.doc_h);
    if (dwData > 0) dw = dwData;
    if (dhData > 0) dh = dhData;
    jobs.push({
      websiteId: ev.websiteId,
      heatmapLayoutEnabled: ev.heatmapLayoutEnabled ?? false,
      url: ev.url ?? "",
      jpeg: raw,
      docW: dw,
      docH: dh,
    });
  }
  return jobs;
}

function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

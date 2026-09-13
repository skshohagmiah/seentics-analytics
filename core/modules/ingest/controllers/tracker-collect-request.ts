import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import type { TrackerCollectBody } from "../../../platform/lib/api-types";

const maxBodyBytes = 8 * 1024 * 1024;
const maxGunzipBytes = 50 * 1024 * 1024;
const gunzip = promisify(gunzipCallback);

/** Parse the tracker transport body while enforcing compressed and expanded limits. */
export async function readTrackerCollectBody(request: Request): Promise<unknown> {
  const contentLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new Error("body too large");
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length > maxBodyBytes) throw new Error("body too large");

  const raw = request.headers.get("Content-Encoding")?.toLowerCase().includes("gzip")
    ? await gunzip(buffer, { maxOutputLength: maxGunzipBytes })
    : buffer;
  return JSON.parse(raw.toString("utf8")) as unknown;
}

export function trackerCollectRequestItemCount(body: TrackerCollectBody): number {
  const lengthOf = (value: unknown) => Array.isArray(value) ? value.length : 0;
  return lengthOf(body.events) + lengthOf(body.session) + lengthOf(body.heatmaps) +
    lengthOf(body.heatmap_screenshot) + lengthOf(body.funnels) + lengthOf(body.automations);
}

import { createHash } from "node:crypto";

/**
 * Object-key slot for one page background.
 *
 * The device bucket is part of the slot: backgrounds are stored per (path, device),
 * and without it a mobile capture would overwrite the desktop object while the two
 * rows pointed at the same key. `desktop` keeps its historical slot so snapshots
 * captured before device bucketing keep resolving.
 */
export function layoutPathSlot(
  websiteId: string,
  normPath: string,
  deviceType: string = "desktop",
): string {
  const h = createHash("sha256").update(normPath).digest();
  const slot = `${websiteId}_${h.subarray(0, 12).toString("hex")}`;
  return deviceType === "desktop" ? slot : `${slot}_${deviceType}`;
}

export function heatmapScreenshotKey(websiteId: string, pathSlot: string): string {
  return `heatmap-screenshots/${websiteId}/${pathSlot}.jpg`;
}

export function heatmapHtmlSnapshotKey(websiteId: string, pathSlot: string): string {
  return `heatmap-screenshots/${websiteId}/${pathSlot}.html`;
}

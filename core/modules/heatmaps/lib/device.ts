/** Mirrors Go `ParseUserAgent` device bucket: mobile | tablet | desktop | Unknown */
export function deviceTypeFromUA(ua: string): string {
  const s = (ua ?? "").trim();
  if (!s) return "Unknown";
  const lower = s.toLowerCase();
  if (/mobile|iphone|ipod|android.*mobile|webos|blackberry|opera mini|iemobile/i.test(lower)) {
    if (/tablet|ipad/i.test(lower)) return "tablet";
    return "mobile";
  }
  if (/tablet|ipad/i.test(lower)) return "tablet";
  return "desktop";
}

/** The device buckets a page background can be stored under, widest first. */
export const SNAPSHOT_DEVICE_BUCKETS = ["desktop", "tablet", "mobile"] as const;

export type SnapshotDeviceBucket = (typeof SNAPSHOT_DEVICE_BUCKETS)[number];

/**
 * Device bucket a stored background is filed under.
 *
 * `deviceTypeFromUA` answers "Unknown" for a missing or unparseable agent, and points
 * carry that value through. Backgrounds cannot: an Unknown bucket would collect
 * captures of every width and render one of them under all of them. Unknown lands in
 * `desktop`, which is also what a Playwright capture produces.
 */
export function snapshotDeviceBucket(ua: string | null | undefined): SnapshotDeviceBucket {
  const d = deviceTypeFromUA(ua ?? "");
  return d === "mobile" || d === "tablet" ? d : "desktop";
}

/**
 * Device bucket implied by a viewport width, for capture paths that choose a width
 * instead of carrying a user agent (Playwright, the dashboard's own re-capture).
 * Thresholds match the CSS breakpoints sites overwhelmingly use.
 */
export function snapshotDeviceBucketForWidth(viewportWidth: number): SnapshotDeviceBucket {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return "desktop";
  if (viewportWidth < 768) return "mobile";
  if (viewportWidth < 1024) return "tablet";
  return "desktop";
}

/** Normalize an arbitrary caller-supplied device string onto a storage bucket. */
export function coerceSnapshotDeviceBucket(value: string | null | undefined): SnapshotDeviceBucket {
  const v = (value ?? "").trim().toLowerCase();
  return v === "mobile" || v === "tablet" ? v : "desktop";
}

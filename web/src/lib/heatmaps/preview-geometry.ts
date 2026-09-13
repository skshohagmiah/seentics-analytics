/**
 * Geometry for the heatmap preview: which box the page background is laid out in, and
 * how it is fitted into the panel.
 *
 * Extracted from the preview component because this is where the overlay was wrong, and
 * the rule it encodes is not obvious from the call site: **the layout box is the capture
 * box, and nothing else is allowed to change it.**
 *
 * Points are stored normalized — the tracker divides each click's page coordinates by the
 * document it measured, and that same document is stored as `doc_width`/`doc_height`
 * beside the snapshot. So `nx * layoutWidth` only lands on the element that was clicked
 * when the layout width *is* the captured width. Fit the box to the panel with a CSS
 * transform, which scales without reflowing; shrink the layout width instead and a
 * responsive page rearranges itself out from under every dot.
 */

/** Floor for a stored capture dimension — below this the client failed to measure itself. */
export const MIN_CAPTURE_PX = 200;

/** Absolute bound on a layout dimension, for a client that reported something absurd. */
export const HEATMAP_DIM_CAP = 32_000;

/** Smallest scale worth rendering: below this the page is unreadable anyway. */
export const MIN_PREVIEW_SCALE = 0.2;

export type Box = { w: number; h: number };

function usable(n: number | null | undefined): boolean {
  return typeof n === "number" && Number.isFinite(n) && n > MIN_CAPTURE_PX;
}

/**
 * The box the stored background was captured at, or null when nothing usable is stored.
 *
 * `measured` — the iframe's own `scrollWidth`/`scrollHeight` — is a last resort, never a
 * preference. That measurement is circular: the iframe is laid out at whatever width the
 * panel gives it, the page inside reflows to match, and it reports the reflowed size back
 * as though it were intrinsic. Preferring it rendered the same page at 849x4096 on one
 * load and 1048x1272 on the next, against a page captured at 1470x1256.
 */
export function heatmapCaptureBox(
  stored: { doc_width?: number | null; doc_height?: number | null } | null | undefined,
  measured?: Box | null,
): Box | null {
  if (usable(stored?.doc_width) && usable(stored?.doc_height)) {
    return { w: Math.round(stored!.doc_width!), h: Math.round(stored!.doc_height!) };
  }
  // Snapshots written before dimensions were recorded carry zeroes; a measured box beats
  // refusing to draw the page at all.
  if (measured && usable(measured.w) && usable(measured.h)) {
    return { w: Math.round(measured.w), h: Math.round(measured.h) };
  }
  return null;
}

/** Clamp a layout dimension into the renderable range without changing its meaning. */
export function clampLayoutPx(px: number): number {
  if (!Number.isFinite(px)) return MIN_CAPTURE_PX;
  return Math.min(HEATMAP_DIM_CAP, Math.max(MIN_CAPTURE_PX, Math.round(px)));
}

/**
 * How much to shrink the layout box so it fits the panel. 1 when it already fits —
 * previews are never enlarged, because upscaling a snapshot only blurs it.
 */
export function heatmapPreviewScale(layoutWidth: number, panelWidth: number): number {
  if (!(layoutWidth > 0) || !(panelWidth > 0)) return 1;
  if (layoutWidth <= panelWidth) return 1;
  return Math.max(MIN_PREVIEW_SCALE, Math.min(1, panelWidth / layoutWidth));
}

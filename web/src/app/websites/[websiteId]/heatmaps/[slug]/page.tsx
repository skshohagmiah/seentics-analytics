'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft, MousePointer,
  RefreshCw, Image as ImageIcon,
  TrendingDown, Layers, Link2,
  MoreHorizontal,
  ChevronLeft, ChevronRight,
  Lock, ExternalLink,
  Camera,
} from 'lucide-react';
import { DemoHeatmapPage } from '@/components/heatmaps/DemoHeatmapPage';
import { isDemo } from '@/lib/demo';
import { demoHeatmapPages, demoHeatmapPoints } from '@/lib/demo/heatmaps';
import {
  getHeatmapData,
  getHeatmapPageScreenshot,
  triggerPlaywrightScreenshot,
  heatmapPageSlug,
  normalizeHeatmapPagePath,
  weightedHeatmapCaptureViewportWidth,
  weightedHeatmapCaptureViewportHeight,
  type HeatmapPageScreenshot,
  type HeatmapPoint as ApiHeatmapPoint,
} from '@/lib/heatmaps-api';
import {
  clampLayoutPx,
  heatmapCaptureBox,
  heatmapPreviewScale,
  HEATMAP_DIM_CAP,
  MIN_CAPTURE_PX,
} from '@/lib/heatmaps/preview-geometry';
import { normalizeWebsiteOriginForPreview } from '@/lib/website-preview-url';
import { getWebsiteByAnyId } from '@/lib/websites-api';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type HeatType   = 'click' | 'scroll';
type DeviceType = 'all' | 'desktop' | 'mobile' | 'tablet';

function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface HeatPoint {
  /** 0–1: click `pageX` ÷ document scroll width (same idea as `ny` horizontally). */
  nx:        number;
  /** 0–1: click `pageY` ÷ document scroll height. */
  ny:        number;
  intensity: number;
  selector?: string;
  device?:   string;
  cap_vw?:   number | null;
  cap_vh?:   number | null;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatPathSegment(seg: string): string {
  if (/^s[-_]?/i.test(seg) || /^session[-_]/i.test(seg)) {
    return seg.length > 14 ? `Session · ${seg.slice(-8)}` : 'Session';
  }
  if (seg.length > 40) return `${seg.slice(0, 16)}…`;
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ');
}

/** Title skips `websites`, site UUID, and noise; subtitle is the short logical path. */
function heatmapPageHeading(path: string, websiteId?: string): { title: string; subtitle: string } {
  const segs = path.split('/').filter(Boolean);
  const meaningful = segs.filter(s => {
    if (s === 'websites') return false;
    if (websiteId && s === websiteId) return false;
    if (UUID_SEGMENT.test(s)) return false;
    return true;
  });
  if (!meaningful.length) {
    return { title: 'Heatmap', subtitle: path.startsWith('/') ? path : `/${path}` };
  }
  const title = meaningful.map(formatPathSegment).join(' · ');
  const subtitle = `/${meaningful.join('/')}`;
  return { title, subtitle };
}

/** Logical doc bounds for nx/ny math (keeps coordinates consistent). */

/** Hard cap for canvas + preview layers — larger sizes freeze the tab (multi‑Mpx canvases). */
const HEATMAP_PREVIEW_MAX_EDGE = 4096;
const HEATMAP_PREVIEW_MAX_AREA = 10_000_000;

function clampHeatmapPreviewDimensions(w: number, h: number): { w: number; h: number } {
  let ww = Math.max(1, Math.round(w));
  let hh = Math.max(1, Math.round(h));
  if (ww > HEATMAP_PREVIEW_MAX_EDGE || hh > HEATMAP_PREVIEW_MAX_EDGE) {
    const s = Math.min(HEATMAP_PREVIEW_MAX_EDGE / ww, HEATMAP_PREVIEW_MAX_EDGE / hh);
    ww = Math.max(1, Math.round(ww * s));
    hh = Math.max(1, Math.round(hh * s));
  }
  if (ww * hh > HEATMAP_PREVIEW_MAX_AREA) {
    const s = Math.sqrt(HEATMAP_PREVIEW_MAX_AREA / (ww * hh));
    ww = Math.max(1, Math.round(ww * s));
    hh = Math.max(1, Math.round(hh * s));
  }
  return { w: ww, h: hh };
}

/**
 * Lower bound for preview height from click/scroll spread before a DOM snapshot size is known.
 * Clicks alone only imply height up to max(ny); real pages are often several viewports tall.
 */
function heatmapDocHeightHintPx(
  points: HeatPoint[],
  heatType: HeatType,
  portWidth: number,
): number {
  const dataH = documentPixelHeightForHeatmap(points, heatType, portWidth, null);
  const wh = weightedHeatmapCaptureViewportHeight(points);
  let vhRef = wh;
  if (vhRef == null || vhRef < 200) {
    let maxVh = 0;
    for (const p of points) {
      const v = p.cap_vh;
      if (typeof v === 'number' && Number.isFinite(v) && v > maxVh) maxVh = v;
    }
    vhRef = maxVh >= 200 ? maxVh : 900;
  }
  const stacks = heatType === 'scroll' ? 6 : 5;
  const fromVh = Math.round(vhRef * stacks);
  let maxDepth = 0;
  if (heatType === 'scroll' && points.length) {
    maxDepth = Math.max(...points.map(p => p.ny), 0);
  }
  const scrollGrow =
    heatType === 'scroll' && maxDepth > 0.01
      ? Math.round(vhRef / Math.max(0.08, 1 - maxDepth))
      : 0;
  return Math.min(
    HEATMAP_DIM_CAP,
    Math.max(dataH, fromVh, scrollGrow, Math.round(Math.max(320, portWidth) * 1.05)),
  );
}

/**
 * Pixel height for the heat layer. Clicks use ny ∈ [0,1] over the *full* document; height must
 * represent that full range for dots to line up (not just max(ny)).
 */
function documentPixelHeightForHeatmap(
  points: HeatPoint[],
  heatType: HeatType,
  portWidth: number,
  snapshotDocPx: number | null,
): number {
  const w = Math.max(320, portWidth);
  const minH = 200;
  if (snapshotDocPx != null && snapshotDocPx >= minH) {
    return Math.round(snapshotDocPx);
  }
  if (!points.length) {
    return Math.max(minH, Math.round(Math.min(w * 2, 1600)));
  }
  const pad = heatType === 'scroll' ? 0.04 : 0.1;
  const maxNyRaw = Math.max(...points.map(p => p.ny), heatType === 'scroll' ? 0.05 : 0.08);
  // Don't force bottom ≥ 1 before we have snapshot/doc metrics — avoids inflated shells on sparse data.
  const bottom = heatType === 'click'
    ? Math.min(1.55, Math.max(0.08, maxNyRaw + pad))
    : Math.min(1.55, Math.max(0.1, maxNyRaw + pad));
  const scale = Math.max(480, Math.min(1400, w * 1.85));
  return Math.min(HEATMAP_DIM_CAP, Math.max(minH, Math.ceil(bottom * scale)));
}

/** Floor width from click spread when document width is otherwise underestimated. */
function documentPixelWidthForHeatmap(points: HeatPoint[], portWidth: number): number {
  const w = Math.max(320, portWidth);
  if (!points.length) return w;
  const pad = 0.1;
  const maxNxRaw = Math.max(...points.map(p => p.nx), 0.08);
  const right = Math.min(1.55, Math.max(0.1, maxNxRaw + pad));
  const scale = Math.max(480, Math.min(1400, w * 1.85));
  return Math.min(HEATMAP_DIM_CAP, Math.max(w, Math.ceil(right * scale)));
}

// ─── Heatmap canvas renderer ──────────────────────────────────────────────────
// Two-pass: draw grayscale intensity map then apply colour ramp.
function drawClickHeatmap(canvas: HTMLCanvasElement, points: HeatPoint[], w: number, h: number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;

  // Offscreen canvas for intensity pass
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  octx.globalCompositeOperation = 'lighter';

  const maxI = Math.max(...points.map(p => p.intensity), 1);
  // Tight spots: radius scales with canvas size only — not intensity (high counts were “bomb” sized).
  const ref  = Math.min(w, h);
  const rSpot = Math.max(4, Math.min(22, ref * 0.014));

  for (const p of points) {
    const cx = Math.min(w, Math.max(0, p.nx * w));
    const cy = Math.min(h, Math.max(0, p.ny * h));
    const norm = p.intensity / maxI;
    const alpha = 0.055 + Math.sqrt(norm) * 0.34;

    const g = octx.createRadialGradient(cx, cy, 0, cx, cy, rSpot);
    g.addColorStop(0,   `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.25})`);
    g.addColorStop(1,   'rgba(255,255,255,0)');
    octx.beginPath();
    octx.arc(cx, cy, rSpot, 0, Math.PI * 2);
    octx.fillStyle = g;
    octx.fill();
  }

  // Colour ramp: transparent → blue → cyan → green → yellow → orange → red
  const ramp: [number, [number, number, number, number]][] = [
    [0,   [  0,   0,   0,   0]],
    [20,  [  0,  50, 255,  40]],
    [70,  [  0, 180, 255, 130]],
    [120, [  0, 255, 180, 190]],
    [170, [100, 255,   0, 210]],
    [210, [255, 230,   0, 230]],
    [240, [255, 100,   0, 245]],
    [255, [255,   0,   0, 255]],
  ];

  const imgData = octx.getImageData(0, 0, w, h);
  const px = imgData.data;

  for (let i = 0; i < px.length; i += 4) {
    const v = px[i + 3];
    if (v === 0) continue;
    const c = rampAt(ramp, Math.min(v, 255));
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  }

  ctx.putImageData(imgData, 0, 0);
}

// Draw scroll-depth heatmap: horizontal translucent bands at each depth milestone.
function drawScrollHeatmap(canvas: HTMLCanvasElement, points: HeatPoint[], w: number, h: number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;

  const maxI = Math.max(...points.map(p => p.intensity), 1);

  // Sort by ny ascending (top to bottom)
  const sorted = [...points].sort((a, b) => a.ny - b.ny);

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const yPx = p.ny * h;
    const norm = p.intensity / maxI;

    // Gradient fill from previous depth to this one
    const prevY = i === 0 ? 0 : sorted[i - 1].ny * h;
    const bandH = yPx - prevY;
    if (bandH > 0) {
      const alpha = 0.06 + norm * 0.2;
      // warm at top (high coverage), cool at bottom
      const heat = 1 - p.ny; // 1 at top, 0 at bottom
      const r = Math.round(heat * 200 + 50);
      const g = Math.round((1 - heat) * 200 + 50);
      const b = Math.round((1 - heat) * 255);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(0, prevY, w, bandH);
    }

    // Horizontal fold line
    const lineAlpha = 0.25 + norm * 0.55;
    const heat2 = 1 - p.ny;
    const lr = Math.round(heat2 * 230 + 20);
    const lg = Math.round((1 - heat2) * 230 + 20);
    const lb = Math.round((1 - heat2) * 255);
    ctx.beginPath();
    ctx.moveTo(0, yPx);
    ctx.lineTo(w, yPx);
    ctx.strokeStyle = `rgba(${lr},${lg},${lb},${lineAlpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Depth label
    const pctLabel = `${Math.round(p.ny * 100)}% — ${p.intensity.toLocaleString()} users`;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = `rgba(255,255,255,0.75)`;
    ctx.fillText(pctLabel, 8, yPx - 5);
  }
}

function rampAt(ramp: [number, [number, number, number, number]][], v: number): [number, number, number, number] {
  for (let i = 1; i < ramp.length; i++) {
    if (v <= ramp[i][0]) {
      const [v0, c0] = ramp[i - 1];
      const [v1, c1] = ramp[i];
      const t = (v - v0) / (v1 - v0);
      return c0.map((c, idx) => Math.round(c + (c1[idx] - c) * t)) as [number, number, number, number];
    }
  }
  return ramp[ramp.length - 1][1];
}

/** Neutral underlay when the live page cannot be embedded (faster + clearer than a page wireframe). */
function HeatOnlyUnderlay() {
  return (
    <div
      className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-muted/30 to-muted/50"
      aria-hidden
    >
      <div
        className="absolute inset-0 opacity-[0.45] dark:opacity-[0.35]"
        style={{
          backgroundImage: `
            radial-gradient(ellipse 90% 45% at 50% 0%, hsl(var(--primary) / 0.07), transparent 55%),
            linear-gradient(hsl(var(--border) / 0.45) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--border) / 0.45) 1px, transparent 1px)
          `,
          backgroundSize: '100% 100%, 40px 40px, 40px 40px',
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div className="max-w-sm rounded-lg border border-border bg-card/95 px-4 py-4 text-center">
          <p className="text-sm font-medium text-foreground">Heat layer only</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Neutral grid under the heatmap. Open the live page in another tab to compare layout.
          </p>
        </div>
      </div>
    </div>
  );
}

type PreviewUnderlay = 'screenshot' | 'heat-only';

/** Single-row browser-style chrome (traffic dots, nav, omnibox, open). */
function HeatmapPreviewBrowserChrome({
  pageUrl,
  underlay,
  loadState,
  usingPageVisual = false,
  capturedOn = null,
  requestedDevice = 'all',
}: {
  pageUrl: string;
  underlay: PreviewUnderlay;
  loadState: 'idle' | 'loading' | 'loaded' | 'error';
  /** True when showing a captured screenshot or live page under the heat layer. */
  usingPageVisual?: boolean;
  /**
   * Bucket the shown background was captured on, when it is not the one asked for.
   * A responsive page reflows between buckets, so the dots sit on a layout that is
   * close but not the one those visitors saw — worth saying out loud rather than
   * presenting an approximate overlay as exact.
   */
  capturedOn?: string | null;
  requestedDevice?: string;
}) {
  const displayUrl = pageUrl.trim() || '—';
  const secure     = /^https:\/\//i.test(pageUrl);
  const showFallbackNote =
    usingPageVisual && !!capturedOn && requestedDevice !== 'all' && loadState !== 'loading';
  const statusLead =
    underlay === 'heat-only'
      ? 'Heat only · '
      : usingPageVisual
        ? loadState === 'loading'
          ? 'Loading screenshot · '
          : showFallbackNote
            ? `${capturedOn} screenshot · `
            : 'Captured screenshot · '
        : 'No screenshot yet · ';
  const barTitle = showFallbackNote
    ? `No ${requestedDevice} capture yet — showing the ${capturedOn} one, so the layout under the points is approximate. ${displayUrl}`
    : `${statusLead}${displayUrl}`;

  const openExternal = () => {
    if (!pageUrl.trim()) return;
    window.open(pageUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800/90 bg-zinc-900 px-1.5">
      <div className="flex shrink-0 gap-1 px-0.5" aria-hidden>
        <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
        <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
        <span className="h-2 w-2 rounded-full bg-[#28c840]" />
      </div>
      <button
        type="button"
        disabled
        className="shrink-0 rounded-lg p-1 text-zinc-600 opacity-60"
        aria-hidden
        tabIndex={-1}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled
        className="shrink-0 rounded-lg p-1 text-zinc-600 opacity-60"
        aria-hidden
        tabIndex={-1}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-950/90 px-2 py-0.5">
        {secure ? (
          <Lock className="h-3 w-3 shrink-0 text-emerald-500/90" aria-hidden />
        ) : (
          <span className="w-3 shrink-0 text-center text-[9px] text-zinc-500" aria-hidden>
            ··
          </span>
        )}
        <p className="min-w-0 truncate font-mono text-[11px] leading-snug text-zinc-400" title={barTitle}>
          {statusLead ? <span className="text-zinc-500">{statusLead}</span> : null}
          <span className="text-zinc-400">{displayUrl}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={openExternal}
        disabled={!pageUrl.trim()}
        className="shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-35"
        title="Open in new tab"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── Canvas overlay ───────────────────────────────────────────────────────────
/**
 * The stage, in demo mode.
 *
 * Deliberately not `HeatmapViewer`. That component's whole job is to line recorded
 * points up with a captured snapshot — it measures the snapshot's natural size, picks
 * a document height from stored `doc_height`, and paints two canvas passes at those
 * dimensions. Demo mode has no snapshot and no real points, so every one of those
 * inputs would be a guess, and the guess is what produced the old screen: blobs
 * scattered over an empty grid under the words "No screenshot yet".
 *
 * Here the page is a component of known size carrying its own heat, so there is
 * nothing to align and no canvas to paint. The Clicks/Scroll toggle still works — it
 * swaps the layer inside `DemoHeatmapPage` — while the device selector does not,
 * since there is only one rendering of the page.
 */
function DemoHeatmapStage({ pageUrl, heatType }: { pageUrl: string; heatType: HeatType }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-muted dark:bg-[#09090b]">
      <HeatmapPreviewBrowserChrome
        pageUrl={pageUrl}
        underlay="screenshot"
        loadState="loaded"
        usingPageVisual
      />
      <div className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto p-5">
        <div className="mx-auto w-full max-w-[860px] overflow-hidden rounded-lg border border-border shadow-[0_20px_50px_-15px_rgba(0,0,0,0.45)]">
          <DemoHeatmapPage heat={heatType === 'scroll' ? 'scroll' : 'click'} />
        </div>
      </div>
    </div>
  );
}

function HeatmapViewer({
  pageUrl,
  points,
  heatType,
  overlayOpacity = 1,
  underlay,
  preferredViewportWidth = null,
  pageScreenshot = null,
  requestedDevice = 'all',
}: {
  pageUrl: string;
  points: HeatPoint[];
  heatType: HeatType;
  overlayOpacity?: number;
  underlay: PreviewUnderlay;
  /** Device bucket the viewer asked for, so the chrome can flag a fallback background. */
  requestedDevice?: string;
  preferredViewportWidth?: number | null;
  pageScreenshot?: HeatmapPageScreenshot | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [viewPort, setViewPort] = useState<{ w: number; h: number }>({ w: 1280, h: 0 });
  /** Natural size when loaded — from JPEG naturalWidth/Height or HTML iframe scrollWidth/Height. */
  const [shotNatural, setShotNatural] = useState<{ w: number; h: number } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const hasHtmlSnapshot = !!pageScreenshot?.html_url?.trim();
  const hasJpegSnapshot = !!pageScreenshot?.image_url?.trim();
  const screenshotActive =
    underlay === 'screenshot' && (hasHtmlSnapshot || hasJpegSnapshot);

  const docHeightHint = useMemo(
    () => heatmapDocHeightHintPx(points, heatType, viewPort.w),
    [points, heatType, viewPort.w],
  );

  /**
   * The layout box the stored background was captured at, in CSS pixels.
   *
   * This is the coordinate system the points live in: the tracker divides each click's
   * page position by the document it measured, and stores that same document as
   * `doc_width`/`doc_height` alongside the snapshot. Rendering at this box is what makes
   * `nx * width` land on the element that was clicked.
   *
   * Deliberately *not* derived from the rendered iframe. That measurement is circular —
   * the iframe is laid out at whatever width the panel happens to give it, a responsive
   * page reflows to match, and it then reports that reflowed size back as if it were
   * intrinsic. Trusting it produced a different canvas on every load of the same page
   * (849x4096 one render, 1048x1272 the next, against a page captured at 1470x1256),
   * which no fixed offset could correct.
   */
  const captureBox = useMemo(
    () => heatmapCaptureBox(pageScreenshot, shotNatural),
    [pageScreenshot, shotNatural],
  );

  const docPx = useMemo(() => {
    if (captureBox) return Math.min(HEATMAP_DIM_CAP, captureBox.h);
    // No snapshot at all — heat-only mode. Nothing constrains the canvas but the data,
    // so estimate the page height from how far down the clicks and scrolls reach.
    const dataH = documentPixelHeightForHeatmap(points, heatType, viewPort.w, null);
    return Math.min(HEATMAP_DIM_CAP, Math.max(dataH, docHeightHint));
  }, [captureBox, points, heatType, viewPort.w, docHeightHint]);

  /**
   * The layout box everything is positioned in: the iframe's CSS width, the canvas's CSS
   * size, and the space `nx * w, ny * h` maps into. It is the capture box exactly —
   * never clamped. Clamping this is what a memory cap must not do, because shrinking the
   * width reflows the responsive page inside the iframe and moves every element out from
   * under its dots. Oversized previews are handled by `previewScale` (a CSS transform,
   * which scales without reflowing) and by `canvasRes` (fewer pixels, same box).
   */
  const dims = useMemo(() => {
    if (captureBox) {
      return { w: clampLayoutPx(captureBox.w), h: clampLayoutPx(docPx) };
    }
    const dataW = documentPixelWidthForHeatmap(points, viewPort.w);
    const captureW =
      preferredViewportWidth != null &&
      preferredViewportWidth >= MIN_CAPTURE_PX &&
      preferredViewportWidth <= HEATMAP_DIM_CAP
        ? preferredViewportWidth
        : 0;
    const w = Math.max(MIN_CAPTURE_PX, viewPort.w, dataW, captureW);
    return { w: clampLayoutPx(w), h: clampLayoutPx(docPx) };
  }, [captureBox, docPx, viewPort.w, points, preferredViewportWidth]);

  /**
   * Backing-store resolution for the heat canvas, capped so a tall page cannot allocate a
   * multi-megapixel surface and freeze the tab. The canvas is still *displayed* at
   * `dims`, so a lower resolution costs sharpness and nothing else — the layer is soft
   * radial gradients, which survive downscaling without a visible seam.
   */
  const canvasRes = useMemo(() => clampHeatmapPreviewDimensions(dims.w, dims.h), [dims]);

  const previewScale = useMemo(
    () => heatmapPreviewScale(dims.w, viewPort.w),
    [viewPort.w, dims.w],
  );

  const scaledOuterW = Math.max(1, Math.round(dims.w * previewScale));
  const scaledOuterH = Math.max(1, Math.round(dims.h * previewScale));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setViewPort({
        w: Math.max(1, Math.round(width)),
        h: Math.max(0, Math.round(height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (underlay === 'heat-only') {
      setLoadState('idle');
      return;
    }
    if (screenshotActive && (pageScreenshot?.html_url || pageScreenshot?.image_url)) {
      setLoadState('loading');
    } else {
      setLoadState('idle');
    }
  }, [underlay, screenshotActive, pageScreenshot?.html_url, pageScreenshot?.image_url, pageUrl]);

  useEffect(() => {
    setShotNatural(null);
  }, [pageScreenshot?.image_url, pageScreenshot?.html_url, underlay, screenshotActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (heatType === 'scroll') {
      drawScrollHeatmap(canvas, points, canvasRes.w, canvasRes.h);
    } else {
      drawClickHeatmap(canvas, points, canvasRes.w, canvasRes.h);
    }
  }, [points, canvasRes, heatType]);

  // Listen for the postMessage sent by the injected measurement script inside the HTML
  // snapshot iframe. The snapshot is served from S3 (cross-origin), so contentDocument
  // is inaccessible — postMessage is the only way to get the actual rendered height.
  useEffect(() => {
    if (!hasHtmlSnapshot) return;
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current) return;
      if (e.source !== iframeRef.current.contentWindow) return;
      if (!e.data || typeof e.data !== 'object' || e.data.type !== 'snc_snap_dims') return;
      const h = typeof e.data.h === 'number' && Number.isFinite(e.data.h) ? Math.round(e.data.h) : 0;
      const w = typeof e.data.w === 'number' && Number.isFinite(e.data.w) ? Math.round(e.data.w) : 0;
      if (h > 100) setShotNatural({ w: w > 200 ? w : dims.w, h });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [hasHtmlSnapshot, dims.w]);

  const showHeatOnlyFallback = underlay === 'heat-only' || !screenshotActive;
  const showLoadingOverlay = screenshotActive && loadState === 'loading';

  return (
    /*
      The stage the preview sits on follows the theme.

      It was `bg-[#09090b] dark:bg-[#09090b]` — the same near-black in both themes,
      which meant the one surface on the page that ignored the theme entirely. The
      intent was sound: the visitor's own page is rendered inside this, and a darker
      surround makes a white page read as a distinct artifact rather than blending
      into the dashboard. But that only needs the stage to be *darker than the page
      inside it*, which a neutral grey achieves in light mode without dropping a
      black rectangle into a light UI.
    */
    <div className="flex h-full min-h-0 w-full flex-col bg-muted dark:bg-[#09090b]">
      <HeatmapPreviewBrowserChrome
        pageUrl={pageUrl}
        underlay={underlay}
        loadState={loadState}
        usingPageVisual={screenshotActive}
        capturedOn={pageScreenshot?.device_fallback ? (pageScreenshot.device_type ?? null) : null}
        requestedDevice={requestedDevice}
      />
      <div
        ref={scrollRef}
        className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div
          className="relative mx-auto shrink-0 overflow-hidden"
          style={{
            width: scaledOuterW,
            minWidth: scaledOuterW,
            height: scaledOuterH,
            minHeight: scaledOuterH,
          }}
        >
          <div
            className="relative"
            style={{
              width: dims.w,
              minWidth: dims.w,
              height: dims.h,
              minHeight: dims.h,
              transform: `scale(${previewScale})`,
              transformOrigin: 'top left',
            }}
          >
            {screenshotActive && pageScreenshot ? (
              <div
                className="absolute left-0 top-0 z-0 overflow-hidden bg-white"
                style={{
                  width: dims.w,
                  minWidth: dims.w,
                  height: dims.h,
                  minHeight: dims.h,
                }}
              >
                {hasHtmlSnapshot && pageScreenshot.html_url ? (
                  <iframe
                    ref={iframeRef}
                    src={pageScreenshot.html_url}
                    title="Page snapshot"
                    sandbox="allow-same-origin allow-scripts"
                    scrolling="no"
                    className="pointer-events-none block border-0"
                    style={{ width: dims.w, height: dims.h }}
                    onLoad={() => {
                      setLoadState('loaded');
                      try {
                        const doc = iframeRef.current?.contentDocument;
                        if (!doc) return;
                        const h = doc.documentElement.scrollHeight;
                        const w = doc.documentElement.scrollWidth;
                        if (h > 100) setShotNatural({ w: w > 200 ? w : dims.w, h });
                      } catch { /* cross-origin guard */ }
                    }}
                    onError={() => setLoadState('error')}
                  />
                ) : pageScreenshot.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={pageScreenshot.image_url}
                    alt=""
                    className="pointer-events-none block h-full w-full object-fill"
                    onLoad={e => {
                      const im = e.currentTarget;
                      setShotNatural({
                        w: Math.max(1, im.naturalWidth),
                        h: Math.max(1, im.naturalHeight),
                      });
                      setLoadState('loaded');
                    }}
                    onError={() => setLoadState('error')}
                    loading="eager"
                    decoding="async"
                  />
                ) : null}
              </div>
            ) : null}

            {showHeatOnlyFallback ? <HeatOnlyUnderlay /> : null}

            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute left-0 top-0 z-20 transition-opacity duration-150"
              style={{
                mixBlendMode: 'normal',
                opacity: overlayOpacity,
                width: dims.w,
                height: dims.h,
              }}
              width={canvasRes.w}
              height={canvasRes.h}
            />

            {showLoadingOverlay && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/55 backdrop-blur-[1px]">
                <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-lg border border-white/10 bg-zinc-950/75 px-4 py-3 shadow-lg">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/40 border-t-primary" />
                  <p className="text-xs text-white/60">Loading screenshot…</p>
                  <p className="max-w-[220px] text-center text-[10px] leading-relaxed text-white/40">
                    Switch to <span className="text-white/55">Heat only</span> for an instant grid backdrop.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function HeatmapDetailPage() {
  const params     = useParams();
  const router     = useRouter();
  const websiteId  = params?.websiteId as string;
  const slug       = params?.slug as string;
  const isDemoMode = isDemo(websiteId);
  const { toast }  = useToast();

  const queryClient = useQueryClient();

  const [heatType,  setHeatType]  = useState<HeatType>('click');
  const [device,    setDevice]    = useState<DeviceType>('all');
  const [customUrl, setCustomUrl] = useState('');
  const [previewTouched, setPreviewTouched] = useState(false);
  const [previewUnderlay, setPreviewUnderlay] = useState<PreviewUnderlay>('screenshot');
  const [capturing, setCapturing] = useState(false);
  const [previewPopoverOpen, setPreviewPopoverOpen] = useState(false);

  const urlPath = useMemo(() => {
    const raw = slug ? decodeURIComponent(slug).replace(/_/g, '/') : '/';
    return normalizeHeatmapPagePath(raw);
  }, [slug]);

  const isParamPath = urlPath.includes(':id');

  const demoPages = isDemoMode ? demoHeatmapPages() : [];
  const demoPage  = demoPages.find(p => p.url === urlPath) ?? demoPages[0];

  const { data: websiteMeta } = useQuery({
    queryKey:  ['website-meta', websiteId],
    queryFn:   () => getWebsiteByAnyId(websiteId),
    enabled:   !!websiteId && !isDemoMode,
    staleTime: 300_000,
  });

  const sitePreviewBase = useMemo(() => {
    const u = websiteMeta?.url?.trim();
    if (!u) return '';
    const appOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
    return normalizeWebsiteOriginForPreview(u, appOrigin);
  }, [websiteMeta]);

  const suggestedPreviewUrl = useMemo(() => {
    if (!sitePreviewBase) return '';
    // urlPath may contain `:id` placeholders from path normalization (e.g. /replays/:id).
    // A URL with `:id` is not a real page — skip the suggestion so the user enters a specific URL.
    if (urlPath.includes(':id')) return '';
    const p = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    return `${sitePreviewBase}${p}`;
  }, [sitePreviewBase, urlPath]);

  const { data: heatmapData, isLoading, isError, error, refetch } = useQuery({
    queryKey:  ['heatmap-data', websiteId, urlPath, heatType],
    queryFn:   () => getHeatmapData(websiteId, urlPath, heatType === 'scroll' ? 'scroll' : 'click'),
    enabled:   !isDemoMode,
    staleTime: 60_000,
  });

  // Keyed by device: backgrounds are stored per bucket because a responsive page
  // reflows between them, and the points drawn on one cannot be drawn on another.
  const { data: pageScreenshot, isLoading: screenshotLoading } = useQuery({
    queryKey:  ['heatmap-screenshot', websiteId, urlPath, device],
    queryFn:   () => getHeatmapPageScreenshot(websiteId, urlPath, device),
    enabled:   Boolean(websiteId && !isDemoMode),
    staleTime: 180_000,
    refetchOnWindowFocus: false,
    // Poll every 5s while null — server fires auto-capture in background on miss.
    // Stop after ~60s to avoid infinite polling when Playwright is unavailable.
    refetchInterval: (q) => {
      if (q.state.data) return false;
      const age = Date.now() - (q.state.dataUpdatedAt ?? Date.now());
      return age < 60_000 ? 5_000 : false;
    },
  });

  const previewModeOptions = useMemo(() => {
    const pageHint = pageScreenshot
      ? 'Server-side screenshot captured for this page path.'
      : screenshotLoading
        ? 'Capturing screenshot…'
        : 'No screenshot yet. Use “Capture screenshot” from the menu, or enable heatmap layout so the tracker captures it automatically.';
    return [
      ['screenshot', ImageIcon, 'Screenshot', pageHint] as const,
      ['heat-only', Layers, 'Heat only', 'Heat only, no page underlay.'] as const,
    ];
  }, [pageScreenshot, screenshotLoading]);

  const demoPointsNormalized: HeatPoint[] = useMemo(() => {
    const raw = demoHeatmapPoints(heatType === 'scroll' ? 'move' : 'click');
    return raw.map(p => ({
      nx:        p.x / 1280,
      ny:        p.y / 2400,
      intensity: p.intensity,
      device:    'desktop',
    }));
  }, [heatType]);

  const allPoints: HeatPoint[] = isDemoMode
    ? demoPointsNormalized
    : (heatmapData?.points ?? []).map((p: ApiHeatmapPoint) => ({
        nx: p.x_percent / 10000,
        ny:
          (p.event_type || heatType) === 'scroll'
            ? Math.min(1, Math.max(0, (p.y_percent ?? 0) / 100))
            : (p.y_percent ?? 0) / 10000,
        intensity: p.intensity,
        selector:  p.target_selector || undefined,
        device:    p.device_type || 'desktop',
        cap_vw:    p.cap_vw ?? undefined,
        cap_vh:    p.cap_vh ?? undefined,
      }));

  const preferredViewportWidth = useMemo(() => {
    if (isDemoMode) return null;
    const src =
      device === 'all'
        ? (heatmapData?.points ?? [])
        : (heatmapData?.points ?? []).filter(
            p => (p.device_type || 'desktop').toLowerCase() === device,
          );
    return weightedHeatmapCaptureViewportWidth(src);
  }, [heatmapData, device, isDemoMode]);

  const points: HeatPoint[] = device === 'all'
    ? allPoints
    : allPoints.filter(p => (p.device ?? 'desktop').toLowerCase() === device);

  const activePreviewUrl = (customUrl.trim() || suggestedPreviewUrl).trim();

  const captureScreenshot = async () => {
    const url = activePreviewUrl;
    if (!url || capturing) return;
    if (!isAbsoluteHttpUrl(url)) {
      toast({ title: 'No preview URL', description: 'Set an https:// preview URL first.', variant: 'destructive' });
      return;
    }
    setCapturing(true);
    try {
      const result = await triggerPlaywrightScreenshot(websiteId, url, urlPath, { force: true });
      if (!result) throw new Error('Screenshot capture failed — check that the page URL is reachable.');
      await queryClient.invalidateQueries({ queryKey: ['heatmap-screenshot', websiteId, urlPath] });
      setPreviewTouched(true);
      setPreviewUnderlay('screenshot');
      toast({ title: 'Screenshot captured', description: 'Background image saved successfully.' });
    } catch (e) {
      toast({ title: 'Capture failed', description: (e as Error).message ?? String(e), variant: 'destructive' });
    } finally {
      setCapturing(false);
    }
  };

  const applyUrl = () => {
    const t = customUrl.trim();
    if (!t) return;
    setPreviewTouched(true);
    setCustomUrl(t.startsWith('http') ? t : `https://${t}`);
  };

  const resetPreviewUrl = () => {
    setPreviewTouched(false);
    setCustomUrl('');
  };

  const shareHeatmapPath = `/websites/${websiteId}/heatmaps/${heatmapPageSlug(urlPath)}`;

  const pathForHeading = isDemoMode ? (demoPage?.url ?? urlPath) : urlPath;
  const { subtitle: pageSubtitle } = heatmapPageHeading(
    pathForHeading || '/',
    isDemoMode ? undefined : websiteId,
  );
  const heatmapPathLine = (() => {
    const p = (urlPath || '').trim() || pageSubtitle || '/';
    return p.startsWith('/') ? p : `/${p}`;
  })();

  const previewUrlPopoverInner = (
    <>
      {isParamPath && (
        <div className="rounded-lg border border-amber-200/70 bg-amber-50/80 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-400">
          <span className="font-medium">Parameterized path</span> — enter a real example URL
          (e.g. replace <code className="font-mono">{urlPath.replace(/:id/g, 'abc123')}</code>) to capture a screenshot.
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-foreground">Preview URL</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Must match this path so clicks and scroll line up with the captured page.
        </p>
      </div>
      <div className="flex gap-2">
        <Input
          value={customUrl}
          onChange={e => setCustomUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyUrl()}
          placeholder={suggestedPreviewUrl || 'https://…'}
          className="h-9 font-mono text-xs"
        />
        <Button type="button" size="sm" className="h-9 shrink-0" onClick={applyUrl}>
          Apply
        </Button>
      </div>
      <Button type="button" variant="ghost" size="sm" className="h-8 w-full text-xs" onClick={resetPreviewUrl}>
        Reset to suggested
      </Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {isError && !isDemoMode && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {(error as Error)?.message ?? 'Failed to load heatmap data.'}
        </div>
      )}

      <header className="shrink-0 border-b border-border bg-background">
        <div
          className="mx-auto flex max-w-[1800px] items-center gap-2 overflow-x-auto px-2 py-1.5 md:px-4"
          role="toolbar"
          aria-label="Heatmap"
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => router.push(`/websites/${websiteId}/heatmaps`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Heatmaps
          </Button>
          {isDemoMode ? (
            <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px] font-medium">
              Demo
            </Badge>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            {points.length > 0 ? (
              <span className="shrink-0 tabular-nums">{points.length.toLocaleString()} pts</span>
            ) : null}
            {points.length > 0 ? <span className="shrink-0 text-border" aria-hidden>·</span> : null}
            <code className="min-w-0 truncate font-mono text-[10px] sm:text-[11px]" title={heatmapPathLine}>
              {heatmapPathLine}
            </code>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Popover open={previewPopoverOpen} onOpenChange={setPreviewPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" title="Preview URL" aria-label="Preview URL">
                  <Link2 className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(92vw,380px)] space-y-3 p-4" align="end">
                {previewUrlPopoverInner}
              </PopoverContent>
            </Popover>

            <div className="flex rounded-lg border border-border bg-background p-0.5">
              {([
                ['click', MousePointer, 'Clicks', 'Where people click'],
                ['scroll', TrendingDown, 'Scroll', 'How far they scroll'],
              ] as const).map(([type, Icon, label, hint]) => (
                <button
                  key={type}
                  type="button"
                  title={hint}
                  onClick={() => setHeatType(type)}
                  className={cn(
                    'flex items-center gap-1 rounded-[4px] px-1.5 py-1 text-[11px] font-medium transition-colors sm:px-2 sm:text-xs',
                    heatType === type
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3 opacity-80" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            <Select value={device} onValueChange={v => setDevice(v as DeviceType)}>
              <SelectTrigger
                className="h-8 w-[108px] rounded-lg border-border bg-background px-2 text-[11px] font-medium shadow-none sm:w-32 sm:text-xs"
                title="Device"
              >
                <SelectValue placeholder="Device" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All devices</SelectItem>
                <SelectItem value="desktop" className="text-xs">Desktop</SelectItem>
                <SelectItem value="mobile" className="text-xs">Mobile</SelectItem>
                <SelectItem value="tablet" className="text-xs">Tablet</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex rounded-lg border border-border bg-background p-0.5">
              {previewModeOptions.map(([mode, Icon, label, hint]) => (
                <button
                  key={mode}
                  type="button"
                  title={hint}
                  onClick={() => setPreviewUnderlay(mode)}
                  className={cn(
                    'flex items-center gap-1 rounded-[4px] px-1.5 py-1 text-[11px] font-medium transition-colors sm:px-2 sm:text-xs',
                    previewUnderlay === mode
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3 opacity-80" />
                  {mode === 'screenshot' ? (
                    <>
                      <span className="sm:hidden">Shot</span>
                      <span className="hidden sm:inline">{label}</span>
                    </>
                  ) : (
                    <span>{label}</span>
                  )}
                </button>
              ))}
            </div>

            {!isDemoMode && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="More">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {activePreviewUrl ? (
                    <DropdownMenuItem
                      className="text-xs"
                      onClick={() => window.open(activePreviewUrl, '_blank', 'noopener,noreferrer')}
                    >
                      Open preview tab
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    className="text-xs"
                    disabled={capturing || (!activePreviewUrl && !isParamPath)}
                    onClick={isParamPath && !activePreviewUrl ? () => setPreviewPopoverOpen(true) : captureScreenshot}
                  >
                    <Camera className="mr-2 h-3.5 w-3.5" />
                    {capturing ? 'Capturing…' : isParamPath && !activePreviewUrl ? 'Set preview URL…' : 'Capture screenshot'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-xs" onClick={() => refetch()}>
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    Refresh data
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {isParamPath && !pageScreenshot && !isDemoMode && (
        <div className="shrink-0 border-b border-amber-200/60 bg-amber-50/80 px-4 py-2 dark:border-amber-500/20 dark:bg-amber-500/5">
          <p className="text-xs text-amber-800 dark:text-amber-400">
            <span className="font-medium">Parameterized path</span> — <code className="rounded-lg bg-amber-100/80 px-0.5 font-mono dark:bg-amber-500/10">{urlPath}</code> aggregates
            all matching URLs. Screenshots come from real visitors via the tracker, or enter a specific example URL in{' '}
            <button
              type="button"
              className="font-medium underline underline-offset-2 hover:no-underline"
              onClick={() => setPreviewPopoverOpen(true)}
            >
              Preview URL
            </button>{' '}
            and use <span className="font-medium">Capture screenshot</span> from the menu.
          </p>
        </div>
      )}

      <main className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col px-2 pb-2 pt-1.5 md:px-4 md:pb-3 md:pt-2">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {!activePreviewUrl && !isDemoMode && !pageScreenshot?.image_url && points.length === 0 && !isLoading ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <p className="text-sm font-medium text-foreground">Add a page preview URL</p>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                Set your site URL in Settings, or use Preview URL above so the heatmap aligns with your page.
              </p>
            </div>
          ) : (
            <div className="relative min-h-0 flex-1">
              {isDemoMode ? (
                <DemoHeatmapStage pageUrl={heatmapPathLine} heatType={heatType} />
              ) : (
                <HeatmapViewer
                  key={`${websiteId}:${urlPath}`}
                  pageUrl={activePreviewUrl || heatmapPathLine}
                  points={points}
                  heatType={heatType}
                  underlay={previewUnderlay}
                  preferredViewportWidth={preferredViewportWidth}
                  pageScreenshot={pageScreenshot ?? null}
                  requestedDevice={device}
                />
              )}
              {points.length === 0 && !isLoading && !isDemoMode && (
                <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
                  <div className="rounded-lg border border-white/10 bg-zinc-950/80 px-3 py-2 text-center shadow-lg backdrop-blur-sm">
                    <p className="text-xs font-medium text-white/70">
                      {heatType === 'click'
                        ? 'No click data yet — try switching to Scroll'
                        : 'No scroll data yet — try switching to Clicks'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {isLoading && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/50">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                <span className="text-xs font-medium text-foreground">Loading…</span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import {
  clampLayoutPx,
  heatmapCaptureBox,
  heatmapPreviewScale,
  HEATMAP_DIM_CAP,
  MIN_CAPTURE_PX,
  MIN_PREVIEW_SCALE,
} from '@/lib/heatmaps/preview-geometry';

/** The page this pipeline was debugged against: captured at a 1470px viewport. */
const CAPTURED = { doc_width: 1470, doc_height: 1256 };

describe('heatmapCaptureBox', () => {
  it('uses the stored capture box, because that is what the points are normalized against', () => {
    expect(heatmapCaptureBox(CAPTURED)).toEqual({ w: 1470, h: 1256 });
  });

  it('ignores the iframe measurement whenever a stored box exists', () => {
    // The regression: the iframe reflows to whatever width the panel gives it and
    // reports that back. Preferring it rendered this page at 849x4096 on one load and
    // 1048x1272 on the next — two different coordinate systems for identical data.
    expect(heatmapCaptureBox(CAPTURED, { w: 849, h: 4096 })).toEqual({ w: 1470, h: 1256 });
    expect(heatmapCaptureBox(CAPTURED, { w: 1048, h: 1272 })).toEqual({ w: 1470, h: 1256 });
  });

  it('falls back to the measurement only for rows stored without dimensions', () => {
    expect(heatmapCaptureBox({ doc_width: 0, doc_height: 0 }, { w: 900, h: 3000 })).toEqual({
      w: 900,
      h: 3000,
    });
    expect(heatmapCaptureBox(null, { w: 900, h: 3000 })).toEqual({ w: 900, h: 3000 });
  });

  it('reports nothing when neither source is usable', () => {
    expect(heatmapCaptureBox(null)).toBeNull();
    expect(heatmapCaptureBox(null, { w: 10, h: 10 })).toBeNull();
    expect(heatmapCaptureBox({ doc_width: 1470, doc_height: 0 })).toBeNull();
    expect(heatmapCaptureBox({ doc_width: NaN, doc_height: NaN })).toBeNull();
  });
});

describe('heatmapPreviewScale', () => {
  it('shrinks a wide capture to the panel instead of narrowing its layout', () => {
    // 1470 of layout into an 849 panel: the box keeps its width and the transform does
    // the fitting, so the page inside never reflows.
    expect(heatmapPreviewScale(1470, 849)).toBeCloseTo(849 / 1470, 5);
  });

  it('never enlarges a capture narrower than the panel', () => {
    expect(heatmapPreviewScale(800, 1200)).toBe(1);
    expect(heatmapPreviewScale(1200, 1200)).toBe(1);
  });

  it('stops shrinking at the readability floor', () => {
    expect(heatmapPreviewScale(20_000, 400)).toBe(MIN_PREVIEW_SCALE);
  });

  it('degrades to 1 rather than NaN when a dimension is missing', () => {
    expect(heatmapPreviewScale(0, 900)).toBe(1);
    expect(heatmapPreviewScale(900, 0)).toBe(1);
  });
});

describe('clampLayoutPx', () => {
  it('leaves a real dimension alone', () => {
    expect(clampLayoutPx(1256)).toBe(1256);
    expect(clampLayoutPx(1256.4)).toBe(1256);
  });

  it('bounds the absurd without silently rescaling the pair', () => {
    // Width and height are clamped independently and only at the extremes: a
    // proportional shrink here would change what nx/ny mean.
    expect(clampLayoutPx(10)).toBe(MIN_CAPTURE_PX);
    expect(clampLayoutPx(1e9)).toBe(HEATMAP_DIM_CAP);
    expect(clampLayoutPx(NaN)).toBe(MIN_CAPTURE_PX);
  });
});

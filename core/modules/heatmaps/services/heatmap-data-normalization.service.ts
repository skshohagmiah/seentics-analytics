import { normalizeHeatmapPagePath } from "../lib/paths";

/** Normalization shared by heatmap storage, page summaries, and screenshot targets. */

import type { HeatmapPageSummary, PageSummaryRow } from "../interfaces";

/** JPEG SOI marker. Cheap sanity check before we pay to store an "image". */
export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * Collapse page rows that differ only in dynamic id segments.
 *
 * Done here rather than in the `GROUP BY` because normalization rules change over
 * time: rows written before `/orders/:id` existed still carry `/orders/8213`, and
 * the dashboard must show one row for the page rather than one per order.
 *
 * `avg_scroll` is averaged over the *rows* being merged, not weighted by their
 * scroll counts. That is what the endpoint has always returned, and the figure is
 * a rough depth indicator rather than a statistic anyone sums.
 */
export function mergeNormalizedPages(pages: PageSummaryRow[]): HeatmapPageSummary[] {
  type Acc = {
    page_path: string;
    click_count: number;
    scroll_count: number;
    scroll_sum: number;
    scroll_n: number;
    last_seen: string;
  };
  const by = new Map<string, Acc>();
  for (const p of pages) {
    const key = normalizeHeatmapPagePath(p.page_path);
    const e = by.get(key);
    if (e) {
      e.click_count  += p.click_count;
      e.scroll_count += p.scroll_count;
      e.scroll_sum   += p.avg_scroll;
      e.scroll_n     += 1;
      if (p.last_seen > e.last_seen) e.last_seen = p.last_seen;
    } else {
      by.set(key, {
        page_path: key,
        click_count: p.click_count,
        scroll_count: p.scroll_count,
        scroll_sum: p.avg_scroll,
        scroll_n: 1,
        last_seen: p.last_seen,
      });
    }
  }
  return [...by.values()]
    .sort((a, b) => b.click_count - a.click_count)
    .map((e) => ({
      page_path:    e.page_path,
      click_count:  e.click_count,
      scroll_count: e.scroll_count,
      avg_scroll:   e.scroll_n > 0 ? Math.round(e.scroll_sum / e.scroll_n) : 0,
      last_seen:    e.last_seen,
    }));
}

/**
 * Build the absolute URL of a page on a website's registered domain.
 *
 * Stored URLs are bare hostnames (`seentics.com`) as often as not, so the scheme
 * is added when missing — without it `new URL` and Playwright both reject the
 * value. Returns `undefined` when there is no stored domain to build from, which
 * is the caller's signal to fall back to scanning real pageview URLs.
 */
export function pageUrlOnSite(siteUrl: string, normalizedPath: string): string | undefined {
  let stored = siteUrl.trim();
  if (!stored) return undefined;
  if (!/^https?:\/\//i.test(stored)) stored = `https://${stored}`;
  const base = stored.replace(/\/+$/, "");
  return normalizedPath === "/" ? `${base}/` : `${base}${normalizedPath}`;
}

'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';
import { normalizeTrackerApiHost } from '@/lib/config';

/**
 * Self-tracking (dogfood): **only** `NEXT_PUBLIC_*` env — never the URL `/websites/[id]`.
 * Otherwise browsing another customer’s analytics would send events to the wrong site.
 *
 * Set a site UUID via one of:
 * - NEXT_PUBLIC_SEENTICS_SITE_ID
 * - NEXT_PUBLIC_SEENTICS_WEBSITE_ID
 * - NEXT_PUBLIC_DEFAULT_SITE_ID
 *
 * Script `src` (no hardcoding in code — use env):
 * 1. `NEXT_PUBLIC_SEENTICS_TRACKER_URL` — full URL, e.g. `http://localhost:3000/trackers/seentics.min.js`
 * 2. Else `NEXT_PUBLIC_FRONTEND_URL` + `/trackers/seentics.min.js`
 * 3. Else `window.location.origin` + `/trackers/seentics.min.js`
 *
 * Optional: NEXT_PUBLIC_SEENTICS_API_HOST
 *
 * Edit: `public/trackers/seentics.js`  →  build: `public/trackers/seentics.min.js`
 */
function resolveTrackerScriptSrc(): string {
  const explicit = process.env.NEXT_PUBLIC_SEENTICS_TRACKER_URL?.trim();
  if (explicit) return explicit;

  const frontendBase = process.env.NEXT_PUBLIC_FRONTEND_URL?.trim().replace(/\/$/, '') ?? '';
  if (frontendBase) return `${frontendBase}/trackers/seentics.min.js`;

  return `${window.location.origin}/trackers/seentics.min.js`;
}

export default function TrackerScript() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const siteId =
    process.env.NEXT_PUBLIC_SEENTICS_SITE_ID?.trim() ||
    process.env.NEXT_PUBLIC_SEENTICS_WEBSITE_ID?.trim() ||
    process.env.NEXT_PUBLIC_DEFAULT_SITE_ID?.trim() ||
    '';

  const apiHostOverride = process.env.NEXT_PUBLIC_SEENTICS_API_HOST?.trim();

  const trackerUrl = resolveTrackerScriptSrc();
  // `seentics-dom.min.js`, not `rrweb.min.js` — filter lists block the latter by name.
  const rrwebUrl = trackerUrl.replace(/[^/?#]*\.js[^/?#]*$/, 'seentics-dom.min.js');

  if (!siteId) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- intentional dev-only hint when /collect never fires
      console.info(
        '[Seentics] Self-tracking script skipped: set NEXT_PUBLIC_SEENTICS_WEBSITE_ID (or NEXT_PUBLIC_DEFAULT_SITE_ID) in .env.local to your dashboard website UUID, then restart dev.',
      );
    }
    return null;
  }

  return (
    <Script
      id="seentics-tracker"
      src={trackerUrl}
      data-website-id={siteId}
      data-rrweb-src={rrwebUrl}
      {...(apiHostOverride ? { 'data-api-host': normalizeTrackerApiHost(apiHostOverride) } : {})}
      strategy="afterInteractive"
    />
  );
}

/*!
 * Seentics Tracker v2 — analytics, session recording, funnels & automations
 * Recording: rrweb (lazy-loaded after init) + gzip compression + batching
 * Analytics:  batched, sendBeacon, single /collect endpoint
 */

// ─── Config from script tag ───────────────────────────────────────────────────

import { runContinuation } from './automation-runtime.js';

const script = document.currentScript;

/** Website UUID — same value as the dashboard project id (data-website-id). */
const websiteId = script?.getAttribute('data-website-id') ?? '';

/**
 * Strip trailing /api/v1 so COLLECT = origin + '/api/v1/tracker/collect' never
 * doubles the prefix when a customer sets data-api-host to their full API URL.
 */
function normalizeApiBase(raw) {
  let s = raw.trim().replace(/\/+$/, '');
  while (/\/api\/v1$/i.test(s)) {
    s = s.replace(/\/api\/v1$/i, '');
  }
  return s;
}

/**
 * When `data-api-host` is omitted, derive the host from this script's own URL.
 * The same host serves /api/v1/... (e.g. via a Next.js rewrite to the gateway),
 * so pageviews, heatmaps, and session batches all hit the customer's own stack.
 * Falls back to https://api.seentics.com only for inline scripts (no src).
 */
function defaultApiHostFromScript() {
  const src = script?.src?.trim();
  if (!src) return 'https://api.seentics.com';
  try {
    const u = new URL(src);
    if (!u.host) return 'https://api.seentics.com';
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://api.seentics.com';
  }
}

const apiHost   = normalizeApiBase(script?.getAttribute('data-api-host') ?? defaultApiHostFromScript());
const autoTrack = script?.getAttribute('data-auto-track') !== 'false';
const domain    = window.location.hostname;

/**
 * Per-feature opt-outs for the two recording sidecars, set on the script tag.
 *
 *   data-capture-console="off"   stop overriding console.* entirely
 *   data-capture-network="off"   stop wrapping fetch / XMLHttpRequest entirely
 *
 * Off means the patch is never installed, not merely that events are discarded: the
 * override itself is observable to the host page (it changes the source line DevTools
 * attributes every log to), so "disabled" has to mean absent.
 */
const captureConsoleAllowed = script?.getAttribute('data-capture-console') !== 'off';
const captureNetworkAllowed = script?.getAttribute('data-capture-network') !== 'off';

if (!websiteId) {
  console.warn(
    '[Seentics] data-website-id is missing or empty. ' +
    'If the script tag has async or defer, remove it — the tracker must execute ' +
    'synchronously to read its own attributes.',
  );
}

// The DOM-recorder bundle lives next to seentics.min.js; override via data-rrweb-src.
// Named `seentics-dom.min.js`, not `rrweb.min.js`: privacy filter lists match that
// filename exactly, so the request was cancelled in-browser and replay silently
// never started — sidecar events arrived with no DOM stream.
const _scriptSrc = script?.src ?? '';
const rrwebSrc =
  script?.getAttribute('data-rrweb-src') ??
  (_scriptSrc ? _scriptSrc.replace(/[^/?#]*\.js[^/]*$/, 'seentics-dom.min.js') : '');

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECT        = apiHost + '/api/v1/tracker/collect';
const FLUSH_MS       = 5_000;           // periodic flush interval (5 s — shorter window reduces unload data on mobile)
const SESSION_MAX_MS = 30 * 60 * 1000; // hard session cap (30 min)

/**
 * rrweb internal numeric constants used in mirrorHeatmapFromRrweb.
 * Defined here so magic numbers don't appear inline in the logic below.
 * Source: https://github.com/rrweb-io/rrweb/blob/master/packages/types/src/index.ts
 */
const RRWEB_EVENT_TYPE = {
  IncrementalSnapshot: 3,
};
const RRWEB_INCREMENTAL_SOURCE = {
  MouseInteraction: 2,
  Scroll:           3,
};
const RRWEB_MOUSE_INTERACTION = {
  Click: 2,
};

// ─── Runtime state ────────────────────────────────────────────────────────────

/**
 * When the current page view began.
 *
 * Reset on SPA navigation, so `timeOnPage` measures the view rather than the tab's
 * lifetime — a condition like "waited 30s on this page" means the page they are on.
 */
let pageEnterMs = Date.now();

/** Config, funnels, and automations loaded from /tracker/init on boot. */
let cfg         = {};
let funnels     = [];
let automations = [];
let flushInterval = null;

/** A strict site needs an explicit signal from its CMP or script tag before tracking. */
const consentGranted = () =>
  script?.getAttribute('data-consent') === 'granted' || window.seenticsConsent === true;

const trackingAllowed = () => {
  if (cfg.respect_dnt === true && navigator.doNotTrack === '1') return false;
  return cfg.consent_mode !== 'strict' || consentGranted();
};

/**
 * The set of trigger types any loaded automation listens for.
 *
 * Built once when automations load so the hot path — every click, every scroll
 * threshold, every visibility change — answers "is anything listening?" with one Set
 * lookup instead of scanning every automation's every trigger on every event.
 */
let automationTriggerTypes = new Set();

/**
 * Trigger types with an evaluate request already in flight.
 *
 * Rapid triggers (clicks, scroll thresholds) can fire several times before the first
 * response lands. Without this, each one costs a round trip and the actions from all of
 * them render on top of each other.
 */
const automationInFlight = new Set();

/**
 * True only while rrweb is actively recording a session that was sampled in.
 * Console / network / error capture is gated on this so we never ship session
 * annotation events that have no replay to attach to (sampled-out visitors).
 */
let sessionCaptureActive = false;

/**
 * In-memory queues for each event category.
 * All queues are drained together into a single /collect POST every FLUSH_MS.
 */
const queues = {
  events:             [], // pageviews, custom events, performance, identify
  funnels:            [], // funnel_step, funnel_complete
  automations:        [], // automation_trigger
  session:            [], // rrweb eventWithTime wrapped in a TrackerEvent envelope
  heatmaps:           [], // heatmap_click, heatmap_scroll
  heatmap_screenshot:    [], // browser-captured JPEG screenshots (html2canvas, fallback)
  heatmap_dom_snapshot: [], // full DOM HTML snapshots (primary layout capture)
};

// ─── Visitor / Session IDs ────────────────────────────────────────────────────

/** Safe localStorage access — returns null if storage is blocked (e.g. private mode). */
const getStore = () => { try { return localStorage; } catch { return null; } };

/** Cryptographically random token; falls back to Math.random if the crypto API is unavailable. */
const rnd = () => {
  try {
    const arr = new Uint8Array(9);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(36)).join('');
  } catch {
    return Math.random().toString(36).slice(2, 11);
  }
};

/** Persistent visitor ID — set once and stored in localStorage forever. */
let visitorId = (() => {
  const store = getStore();
  if (!store) return 'v-' + rnd();
  let id = store.getItem('snc_vid');
  if (!id) {
    id = 'v-' + rnd() + Date.now().toString(36);
    store.setItem('snc_vid', id);
  }
  return id;
})();

/**
 * In-memory session ID cache.
 * Without caching, getSessionId() would perform 3 synchronous localStorage ops on
 * every pushAnalytics() call. With caching, storage is only re-read after genuine
 * inactivity (when the in-memory expiry has lapsed), and the expiry write is
 * throttled to once per minute while the session is active.
 */
let _cachedSid       = null;
let _cachedSidExpiry = 0;  // absolute ms at which the cached sid should be considered expired
let _cachedSidStart  = 0;  // session start ms — needed to enforce the hard cap on the fast path
let _lastExpiryWrite = 0;  // last time we wrote snc_se to storage

const getSessionId = () => {
  const now = Date.now();

  // Fast path: in-memory cache is still warm AND the hard cap hasn't been hit.
  // Without the hard-cap check here, an always-active tab keeps sliding the
  // expiry forward and the 30-min cap is never enforced.
  if (_cachedSid && now < _cachedSidExpiry && (now - _cachedSidStart) < SESSION_MAX_MS) {
    // Throttle the storage write to once per minute.
    // Other tabs can observe activity at minute granularity; no write on every event.
    if (now - _lastExpiryWrite > 60_000) {
      _lastExpiryWrite = now;
      _cachedSidExpiry = now + SESSION_MAX_MS;
      getStore()?.setItem('snc_se', String(_cachedSidExpiry));
    }
    return _cachedSid;
  }

  // Cache miss — fall back to storage (first call, or after genuine inactivity).
  const store = getStore();
  if (!store) {
    _cachedSid       = 's-' + now.toString(36);
    _cachedSidExpiry = now + SESSION_MAX_MS;
    _cachedSidStart  = now;
    return _cachedSid;
  }

  let id        = store.getItem('snc_sid');
  const expiry  = store.getItem('snc_se');   // inactivity expiry timestamp
  let   started = store.getItem('snc_ss');   // session start time (for hard cap)

  const inactivityExpired = !id || !expiry || now > +expiry;
  const hardCapExceeded   = !!started && (now - +started) >= SESSION_MAX_MS;

  if (inactivityExpired || hardCapExceeded) {
    id = 's-' + rnd() + now.toString(36);
    started = String(now);
    store.setItem('snc_sid', id);
    store.setItem('snc_ss', started);
  }

  _cachedSidExpiry = now + SESSION_MAX_MS;
  store.setItem('snc_se', String(_cachedSidExpiry));
  _cachedSid       = id;
  _cachedSidStart  = started ? +started : now;
  _lastExpiryWrite = now;
  return id;
};

// Keep the in-memory session cache in sync when another tab rotates the session,
// so concurrent tabs don't report overlapping/stale session IDs for up to 30 min.
try {
  window.addEventListener('storage', (e) => {
    if (e.key === 'snc_sid' && e.newValue && e.newValue !== _cachedSid) {
      _cachedSid       = e.newValue;
      _cachedSidStart  = +(getStore()?.getItem('snc_ss') ?? Date.now()) || Date.now();
      _cachedSidExpiry = Date.now() + SESSION_MAX_MS;
    }
  });
} catch { /* ignore */ }

// ─── Queue helpers ────────────────────────────────────────────────────────────

/** Map an event type string to its queue key. */
const categoryOf = (type) => {
  if (type === 'funnel_step' || type === 'funnel_complete') return 'funnels';
  if (type === 'automation_trigger')                        return 'automations';
  if (type === 'heatmap_click' || type === 'heatmap_scroll') return 'heatmaps';
  return 'events';
};

/** Push a typed analytics event onto the appropriate queue. */
const pushAnalytics = (type, data) => {
  queues[categoryOf(type)].push({
    type,
    data,
    ts:  Date.now(),
    url: location.href,
    sid: getSessionId(),
    vid: visitorId,
  });
};

// ─── Network transport ────────────────────────────────────────────────────────

/**
 * Send JSON compressed with gzip via XHR.
 * Used for large payloads (session recording, big heatmap batches) where sendBeacon's
 * ~64 KB limit would be exceeded. Falls back to plain JSON if CompressionStream
 * is unavailable (Firefox < 113, older Safari).
 */
const sendGzip = async (json) => {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(new TextEncoder().encode(json));
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', COLLECT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Content-Encoding', 'gzip');
      xhr.send(buf);
      return;
    } catch (_) { /* fall through to plain JSON */ }
  }
  const xhr = new XMLHttpRequest();
  xhr.open('POST', COLLECT, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(json);
};

/**
 * Build the /collect payload from all non-empty queues and return {payload, json}.
 * Returns null when all queues are empty (nothing to send).
 */
const drainQueues = () => {
  const events      = queues.events.splice(0);
  const funnelEvts  = queues.funnels.splice(0);
  const autoEvts    = queues.automations.splice(0);
  const sessionEvts = queues.session.splice(0);
  const heatmapEvts = queues.heatmaps.splice(0);
  const shotEvts        = queues.heatmap_screenshot.splice(0);
  const domSnapshotEvts = queues.heatmap_dom_snapshot.splice(0);

  if (!events.length && !funnelEvts.length && !autoEvts.length && !sessionEvts.length && !heatmapEvts.length && !shotEvts.length && !domSnapshotEvts.length) {
    return null;
  }

  const payload = { website_id: websiteId, domain, ua: navigator.userAgent, consent: consentGranted() };
  if (events.length)            payload.events               = events;
  if (funnelEvts.length)        payload.funnels              = funnelEvts;
  if (autoEvts.length)          payload.automations          = autoEvts;
  if (sessionEvts.length)       payload.session              = sessionEvts;
  if (heatmapEvts.length)       payload.heatmaps             = heatmapEvts;
  if (shotEvts.length)          payload.heatmap_screenshot   = shotEvts;
  if (domSnapshotEvts.length)   payload.heatmap_dom_snapshot = domSnapshotEvts;

  return { payload, json: JSON.stringify(payload), sessionEvts, heatmapEvts, shotEvts };
};

// ─── Flush functions ──────────────────────────────────────────────────────────

/**
 * Periodic flush — drains all queues and sends to /collect.
 * Also restarts rrweb if the session ID rotated since recording began
 * (so the new session gets a fresh FullSnapshot baseline).
 */
const flush = () => {
  // Restart rrweb if the session rotated (inactivity or hard cap hit).
  if (activeRecordingSessionId !== null) {
    const currentSid = getSessionId();
    if (currentSid !== activeRecordingSessionId) {
      loadRrweb().then(record => {
        if (record) startRrweb(record, currentSid, computeReplaySessionEnabled());
      });
    }
  }

  const drained = drainQueues();
  if (!drained) return;
  const { json, sessionEvts, heatmapEvts, shotEvts } = drained;

  // Session recording, screenshot payloads, or large batches: gzip to stay under the sendBeacon limit.
  if (sessionEvts.length > 0 || shotEvts.length > 0 || heatmapEvts.length > 400 || json.length > 55_000) {
    sendGzip(json);
    return;
  }

  // Analytics-only payload: sendBeacon is fire-and-forget and survives page navigation.
  const blob = new Blob([json], { type: 'application/json' });
  if (navigator.sendBeacon) { navigator.sendBeacon(COLLECT, blob); return; }

  // sendBeacon not available (very old browser): plain async XHR.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', COLLECT, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(json);
};

/**
 * Unload flush — called on visibilitychange:hidden and pagehide.
 * Must use keepalive fetch (or sendBeacon) because the page is closing.
 * Synchronous XHR is deprecated in Chrome 80+ and silently dropped during unload.
 */
const flushBeacon = () => {
  const drained = drainQueues();
  if (!drained) return;
  const { json, heatmapEvts, shotEvts } = drained;

  // Screenshots or very large batches must use keepalive fetch.
  // NOTE: iOS Safari limits keepalive request bodies to 64 KB. Full DOM snapshots
  // are flushed immediately when captured (see emit handler above) so by the time
  // pagehide fires, only incremental events remain — typically well under 64 KB.
  if (shotEvts.length > 0 || heatmapEvts.length > 400 || json.length > 55_000) {
    try {
      fetch(COLLECT, {
        method: 'POST',
        body: json,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
      });
    } catch { /* ignore — page is already closing */ }
    return;
  }

  // Small payload (including incremental session events): sendBeacon is the most
  // reliable delivery mechanism across browsers during page unload.
  const blob = new Blob([json], { type: 'application/json' });
  if (navigator.sendBeacon && navigator.sendBeacon(COLLECT, blob)) return;

  // sendBeacon rejected or unavailable — fall back to keepalive fetch.
  try {
    fetch(COLLECT, {
      method: 'POST',
      body: json,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
  } catch { /* ignore — page is already closing */ }
};

// ─── rrweb lazy loader ────────────────────────────────────────────────────────

// rrweb is loaded on demand — only when session recording is actually enabled.
// After loading, rrweb sets window.__rrweb_record = record.
let _rrwebLoadPromise = null;

/**
 * Inject the DOM-recorder bundle into the page once and return the record function.
 * Subsequent calls return the same promise (guaranteed single load).
 */
const loadRrweb = () => {
  if (_rrwebLoadPromise) return _rrwebLoadPromise;
  _rrwebLoadPromise = new Promise((resolve) => {
    if (window.__rrweb_record) { resolve(window.__rrweb_record); return; }
    if (!rrwebSrc)              { resolve(null); return; }
    const tag   = document.createElement('script');
    tag.src     = rrwebSrc;
    tag.onload  = () => resolve(window.__rrweb_record ?? null);
    tag.onerror = () => resolve(null);
    document.head.appendChild(tag);
  });
  return _rrwebLoadPromise;
};

/**
 * Attach window error and unhandledrejection listeners that push errors into the
 * session queue so they appear as annotations in the replay timeline.
 * Guards against double-installation with a flag on window.
 */
const installSessionClientErrorCapture = () => {
  if (window.__snc_err_cap) return;
  window.__snc_err_cap = true;

  const enqueueError = (data) => {
    if (!sessionCaptureActive) return;
    queues.session.push({
      type: 'session_error',
      data,
      ts:  Date.now(),
      url: location.href,
      sid: getSessionId(),
      vid: visitorId,
    });
  };

  // Messages and stacks routinely quote the value that broke and the URL it came from,
  // so both go through the same scrub as everything else stored in a recording.
  window.addEventListener('error', (ev) => {
    enqueueError({
      message:  redactText(ev.message) || 'Script error',
      filename: ev.filename ? redactUrl(ev.filename) : undefined,
      lineno:   ev.lineno   || undefined,
      colno:    ev.colno    || undefined,
      stack:    ev.error?.stack ? redactText(ev.error.stack) : undefined,
    });
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const isErr  = reason instanceof Error;
    enqueueError({
      message: redactText(isErr ? reason.message : String(reason ?? 'Unhandled rejection')),
      stack:   isErr && reason.stack ? redactText(reason.stack) : undefined,
    });
  });
};

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Query keys whose values never leave the browser intact.
 *
 * Recordings are replayed by whoever can see the dashboard, so a password-reset link or
 * a bearer token in a request URL becomes a durable credential sitting in storage. The
 * match is a substring, case-insensitive, so `X-Api-Key`, `access_token` and
 * `resetPasswordCode` are all covered by the short list below.
 */
const SENSITIVE_KEY_RE =
  /(pass|pwd|secret|token|auth|bearer|session|sid|api[-_]?key|signature|\bsig\b|credential|otp|code|email|phone|ssn)/i;

const REDACTED = '[redacted]';
/** URL-safe, so a scrubbed query parameter reads as `?token=redacted`, not `%5B…%5D`. */
const REDACTED_PARAM = 'redacted';

/** Anything shaped like an address or a long opaque credential, wherever it appears. */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

/** Scrub free text — console arguments, error messages, stack frames. */
const redactText = (text) => {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(JWT_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED)
    .replace(LONG_OPAQUE_RE, REDACTED);
};

/**
 * A URL safe to store: no credentials, no fragment, sensitive query values replaced.
 *
 * Keys are kept because "which parameter" is most of the debugging value and the key
 * itself is rarely the secret. Non-sensitive values are kept but scrubbed for addresses
 * and token-shaped strings, since a `?next=` or `?q=` routinely carries both.
 */
const redactUrl = (raw) => {
  if (typeof raw !== 'string' || !raw) return '';
  let u;
  try {
    u = new URL(raw, location.href);
  } catch {
    // Not parseable (a relative path on a page with an odd base, say) — scrub as text.
    return redactText(raw).slice(0, 1000);
  }
  // `https://user:pass@host` — never worth keeping.
  u.username = '';
  u.password = '';
  // Fragments are client-only and disproportionately carry tokens (implicit OAuth flows).
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (SENSITIVE_KEY_RE.test(key)) {
      u.searchParams.set(key, REDACTED_PARAM);
    } else {
      const value = u.searchParams.get(key);
      const scrubbed = redactText(value);
      if (scrubbed !== value) u.searchParams.set(key, scrubbed);
    }
  }
  return u.toString().slice(0, 1000);
};

// ─── Session console capture ──────────────────────────────────────────────────

/**
 * Override console methods to push log entries into the session queue so they
 * appear in the replay DevTools panel. Originals are still called unchanged.
 * Guards against double-installation with a window flag.
 */
const installSessionConsoleCapture = () => {
  if (window.__snc_con_cap) return;
  window.__snc_con_cap = true;

  // Caps keep console capture cheap even when the host app logs large objects
  // in tight loops (serializing multi-MB objects on every log call is a real
  // main-thread cost, and oversized args bloat every /collect payload).
  const MAX_CONSOLE_ARGS    = 10;
  const MAX_CONSOLE_ARG_LEN = 1_000;

  const enqueueConsole = (level, args) => {
    if (!sessionCaptureActive) return;
    const serialized = args.slice(0, MAX_CONSOLE_ARGS).map(a => {
      let s;
      if (typeof a === 'string') s = a;
      else { try { s = JSON.stringify(a); } catch { s = String(a); } }
      s = String(s ?? '');
      // Applications log user objects, API responses and auth headers as a matter of
      // course. Whatever the reason, none of it should become a durable recording.
      s = redactText(s);
      return s.length > MAX_CONSOLE_ARG_LEN ? s.slice(0, MAX_CONSOLE_ARG_LEN) + '…' : s;
    });
    queues.session.push({
      type: 'console_event',
      data: { level, args: serialized },
      ts:   Date.now(),
      url:  location.href,
      sid:  getSessionId(),
      vid:  visitorId,
    });
  };

  ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
    const orig = console[level];
    console[level] = function() {
      orig.apply(console, arguments);
      try { enqueueConsole(level, Array.prototype.slice.call(arguments)); } catch { /* ignore */ }
    };
  });
};

// ─── Session network capture ──────────────────────────────────────────────────

/**
 * Intercept fetch and XHR to record network requests as session events.
 * Excludes the tracker's own /collect calls to avoid infinite event loops.
 * Guards against double-installation with a window flag.
 */
const installSessionNetworkCapture = () => {
  if (window.__snc_net_cap) return;
  window.__snc_net_cap = true;

  const enqueueNetwork = (data) => {
    if (!sessionCaptureActive) return;
    queues.session.push({
      type: 'network_event',
      // Scrubbed here rather than at each call site, so a new one cannot forget: request
      // URLs carry reset keys, one-time codes and bearer tokens as query parameters.
      data: { ...data, url: redactUrl(data.url), error: redactText(data.error) },
      ts:   data.startTs,
      url:  location.href,
      sid:  getSessionId(),
      vid:  visitorId,
    });
  };

  // ── fetch interception ──
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const method  = ((init && init.method) || 'GET').toUpperCase();
    const reqUrl  = typeof input === 'string' ? input
      : (input instanceof URL ? input.href : (input && typeof input.url === 'string' ? input.url : ''));
    if (!reqUrl || reqUrl === COLLECT || reqUrl.startsWith(COLLECT + '?')) {
      return origFetch.apply(this, arguments);
    }
    const startTs = Date.now();
    const p = origFetch.apply(this, arguments);
    // Observe on a side chain WITHOUT rethrowing: rethrowing here would surface a
    // second, unhandled rejection for every failed fetch the page itself handles.
    p.then(
      function(response) {
        try { enqueueNetwork({ method, url: reqUrl, status: response.status, duration: Date.now() - startTs, startTs }); } catch { /* ignore */ }
      },
      function(err) {
        try { enqueueNetwork({ method, url: reqUrl, status: 0, duration: Date.now() - startTs, startTs, error: String(err) }); } catch { /* ignore */ }
      }
    );
    return p;
  };

  // ── XHR interception ──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._snc_method = String(method || 'GET');
    this._snc_url    = String(url || '');
    this._snc_start  = 0;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const req = this;
    if (req._snc_url && req._snc_url !== COLLECT && !req._snc_url.startsWith(COLLECT + '?')) {
      req._snc_start = Date.now();
      req.addEventListener('loadend', function() {
        try {
          enqueueNetwork({
            method:   (req._snc_method || 'GET').toUpperCase(),
            url:      req._snc_url,
            status:   req.status,
            duration: Date.now() - req._snc_start,
            startTs:  req._snc_start,
          });
        } catch { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };
};

// ─── Heatmap screenshot (server-side Playwright) ──────────────────────────────

/**
 * Per-tab, per-path dedup key stored in sessionStorage.
 * Once a screenshot request succeeds for a path, we don't send another until
 * the user navigates to a different path (or opens a new tab).
 */
const heatmapScreenshotSentKey = () => {
  if (!websiteId) return '';
  try { return `snc_hmshot:${websiteId}:${location.pathname}`; }
  catch { return ''; }
};

const hasSentHeatmapScreenshotForPath = () => {
  const key = heatmapScreenshotSentKey();
  if (!key) return false;
  try { return sessionStorage.getItem(key) === '1'; }
  catch { return false; }
};

const markHeatmapScreenshotSentForPath = () => {
  const key = heatmapScreenshotSentKey();
  if (!key) return;
  try { sessionStorage.setItem(key, '1'); }
  catch { /* ignore */ }
};

/** Timeouts queued after load/navigation to let the page fully render first. */
let screenshotScheduleTimeouts  = [];
let screenshotLongPageInterval  = null;

const clearScreenshotScheduleTimers = () => {
  for (const id of screenshotScheduleTimeouts) window.clearTimeout(id);
  screenshotScheduleTimeouts = [];
};

const clearScreenshotLongPageInterval = () => {
  if (screenshotLongPageInterval != null) {
    window.clearInterval(screenshotLongPageInterval);
    screenshotLongPageInterval = null;
  }
};

/**
 * Fire a lightweight POST to /tracker/request-screenshot.
 * The server handles deduplication (in-memory cache → DB → Playwright), so
 * repeated calls for an unchanged page are fast no-ops on the server side.
 */
const requestPlaywrightScreenshot = () => {
  if (cfg.heatmap_layout_enabled === false) return;
  if (!heatmapAllowed()) return;
  if (hasSentHeatmapScreenshotForPath()) return;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiHost + '/api/v1/tracker/request-screenshot', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 202) markHeatmapScreenshotSentForPath();
    };
    xhr.send(JSON.stringify({
      website_id: websiteId,
      page_url:   location.href,
      page_path:  location.pathname,
    }));
  } catch { /* ignore */ }
};

/**
 * Schedule staggered screenshot requests after a page load or SPA navigation.
 * The two delays (1.5 s, 4 s) give lazy-loaded content time to appear before
 * Playwright fetches the page server-side. The sessionStorage dedup flag ensures
 * only the first successful request per path triggers an actual capture.
 */
const scheduleHeatmapScreenshotAfterAppIdle = () => {
  if (cfg.heatmap_layout_enabled === false) return;
  if (!heatmapAllowed()) return;
  clearScreenshotScheduleTimers();
  clearScreenshotLongPageInterval();
  // Primary: capture DOM snapshot directly from the browser — always works,
  // no authentication or X-Frame-Options issues.
  screenshotScheduleTimeouts.push(window.setTimeout(captureAndQueueDomSnapshot, 2_500));
};

/**
 * Capture the current page as a DOM snapshot (serialized HTML) and push it onto
 * the heatmap_dom_snapshot queue so it's sent on the next flush.
 *
 * Approach (Hotjar/Clarity style):
 * - Clone the live DOM so we don't mutate the page
 * - Insert <base href> so relative asset URLs resolve correctly when rendered
 * - Remove <script> tags so the snapshot is inert and safe to render in a sandboxed iframe
 * - Remove <iframe> to avoid cross-origin complications
 * - Runs once per path per session — deduped via sessionStorage
 */
const captureAndQueueDomSnapshot = () => {
  if (cfg.heatmap_layout_enabled === false) return;
  if (!heatmapAllowed()) return;
  if (hasSentHeatmapScreenshotForPath()) return;
  try {
    const clone = document.documentElement.cloneNode(true);

    // Insert <base href> so relative URLs resolve against the original origin
    const head = clone.querySelector('head');
    if (head) {
      const existingBase = head.querySelector('base');
      if (!existingBase) {
        const base = document.createElement('base');
        base.href = location.origin + '/';
        head.insertBefore(base, head.firstChild);
      }
    }

    // Remove elements that are unsafe or unnecessary in a static snapshot
    clone.querySelectorAll('script, noscript').forEach(el => el.remove());
    // Heatmap snapshots are durable objects, not just a visual preview. Apply the
    // same explicit privacy controls used by replay before serialising the clone:
    // blocked regions retain a harmless placeholder so the page geometry remains
    // useful for coordinate alignment, while masked regions retain only a fixed
    // redaction marker. Never rely on CSS visibility here — hidden text is still
    // present in the uploaded HTML.
    clone.querySelectorAll('[data-seentics-block]').forEach(el => {
      el.replaceChildren('[blocked]');
      el.setAttribute('aria-label', 'Blocked content');
    });
    clone.querySelectorAll('[data-seentics-mask]').forEach(el => {
      el.replaceChildren('••••••');
      el.setAttribute('aria-label', 'Masked content');
    });
    // Form values can be prefilled by the site (for example, profile data) and
    // therefore appear in outerHTML even when the visitor never types. Snapshot
    // layout needs the controls, not their values, so redact every form control.
    clone.querySelectorAll('input, textarea').forEach(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.value = '';
        el.setAttribute('value', '');
      }
    });
    clone.querySelectorAll('select').forEach(el => {
      el.selectedIndex = -1;
      el.querySelectorAll('option[selected]').forEach(option => option.removeAttribute('selected'));
    });
    clone.querySelectorAll('[contenteditable]:not([contenteditable="false"])').forEach(el => {
      el.replaceChildren('••••••');
      el.setAttribute('aria-label', 'Masked editable content');
    });
    // Replace cross-origin iframes with a placeholder (same-origin iframes could be captured,
    // but the added complexity and payload size aren't worth it for a layout snapshot)
    clone.querySelectorAll('iframe').forEach(el => {
      const ph = document.createElement('div');
      ph.style.cssText = 'background:#f3f4f6;border:1px dashed #d1d5db;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px;';
      ph.setAttribute('data-snc-placeholder', 'iframe');
      ph.textContent = '[embedded content]';
      el.replaceWith(ph);
    });

    // Inject a measurement script so the preview iframe can report its actual rendered
    // height via postMessage (works cross-origin). The snapshot HTML is served from S3
    // (different origin), so the viewer cannot read scrollHeight via contentDocument.
    if (head) {
      const measureScript = document.createElement('script');
      measureScript.textContent = '(function(){function m(){var h=Math.max(document.documentElement.scrollHeight||0,(document.body||{}).scrollHeight||0),w=Math.max(document.documentElement.scrollWidth||0,(document.body||{}).scrollWidth||0);try{window.parent.postMessage({type:"snc_snap_dims",w:w,h:h},"*")}catch(e){}}if(document.readyState==="complete"){m()}else{window.addEventListener("load",m)}}());';
      head.appendChild(measureScript);
    }

    const html = '<!DOCTYPE html>' + clone.outerHTML;

    // Skip if snapshot is too large (> 1.2 MB) to avoid oversized payloads
    if (html.length > 1_200_000) return;

    // Measure the document with the SAME logic the click/scroll coordinates are
    // normalized against (heatmapDocumentMetrics scans inner overflow:auto regions),
    // so the stored doc_w/doc_h match the coordinate system. Using a different
    // measurement here (plain scrollHeight) was making the preview the wrong height
    // and pushing every dot off its true position.
    heatmapMetricsCache = null;
    const { dw, dh } = heatmapDocumentMetrics();

    queues.heatmap_dom_snapshot.push({
      type:  'heatmap_dom_snapshot',
      ts:    Date.now(),
      url:   location.href,
      sid:   getSessionId(),
      vid:   visitorId,
      doc_w: dw,
      doc_h: dh,
      vw:    window.innerWidth,
      vh:    window.innerHeight,
      data:  { html },
    });

    markHeatmapScreenshotSentForPath();
    flush();
  } catch { /* non-critical — DOM serialization failures must not break the page */ }
};

// ─── Safe regex ───────────────────────────────────────────────────────────────

/**
 * Test a regex pattern against a subject string.
 * Patterns longer than 500 chars fall back to plain string.includes to guard
 * against ReDoS attacks from malicious pattern data coming from the server.
 */
const safeRegex = (pattern, subject) => {
  if (pattern.length > 500) return subject.includes(pattern);
  try { return new RegExp(pattern).test(subject); }
  catch { return subject.includes(pattern); }
};

// ─── URL pattern matching (for recording/heatmap include/exclude rules) ───────

/** Split a newline-delimited pattern string into trimmed, non-empty lines. */
const patternLines = (patterns) => {
  if (!patterns) return [];
  return patterns.split('\n').map(p => p.trim()).filter(Boolean);
};

/** Returns true when the pattern string contains at least one non-empty line. */
const hasEffectivePatterns = (patterns) => patternLines(patterns).length > 0;

/** Returns true when the current page URL matches any line in the pattern string. */
const matchesPatterns = (patterns) => {
  const lines = patternLines(patterns);
  if (!lines.length) return false;
  return lines.some(p => safeRegex(p, location.href));
};

// ─── Heatmaps (click + scroll depth) ─────────────────────────────────────────

/** Returns true when heatmap capture is enabled and the current URL is not excluded. */
const heatmapAllowed = () => {
  if (cfg.heatmap_enabled === false) return false;
  const includePatterns = cfg.heatmap_include_patterns;
  const excludePatterns = cfg.heatmap_exclude_patterns;
  if (hasEffectivePatterns(includePatterns) && !matchesPatterns(includePatterns)) return false;
  if (hasEffectivePatterns(excludePatterns) && matchesPatterns(excludePatterns))  return false;
  return true;
};

/** Scroll depth as a 0–1 fraction of the scrollable document height. */
const scrollDepth01 = () => {
  const el = document.documentElement;
  const scrollableHeight = el.scrollHeight - el.clientHeight;
  if (scrollableHeight <= 0) return 1;
  return Math.min(1, Math.max(0, el.scrollTop / scrollableHeight));
};

/**
 * CSS layout viewport dimensions in pixels.
 * The dashboard uses these to size the heatmap overlay iframe to the correct breakpoint.
 * Uses visualViewport when available to handle pinch-zoom on mobile correctly.
 */
const heatmapViewportCss = () => {
  const vv   = typeof visualViewport !== 'undefined' && visualViewport ? visualViewport : null;
  const rawW = vv?.width  ?? (typeof innerWidth  === 'number' ? innerWidth  : 0);
  const rawH = vv?.height ?? (typeof innerHeight === 'number' ? innerHeight : 0);
  return {
    vw: Math.max(1, Math.round(rawW)),
    vh: Math.max(1, Math.round(rawH)),
  };
};

/**
 * Cached result of the document dimension scan (1 s TTL).
 * The scan is expensive on large DOMs so we share its result across rapid
 * successive calls (e.g. rrweb emit bursts during a scroll).
 */
let heatmapMetricsCache = null;

/**
 * Compute the full document bounding box (width × height in CSS pixels).
 *
 * documentElement.scrollHeight alone is insufficient for app shells that fix
 * the body height and scroll inside an inner container (e.g. a `main` element
 * with overflow:auto). We walk up to 3 000 body descendant nodes and take the
 * max scrollWidth / scrollHeight of any element that is actually overflowing.
 */
const heatmapDocumentMetrics = () => {
  const now = typeof performance?.now === 'function' ? performance.now() : Date.now();
  if (heatmapMetricsCache && now - heatmapMetricsCache.at < 1_000) {
    return { dw: heatmapMetricsCache.dw, dh: heatmapMetricsCache.dh };
  }

  const docEl = document.documentElement;
  const body  = document.body;
  let dw = Math.max(1, docEl.scrollWidth, body?.scrollWidth ?? 0, docEl.clientWidth  || 1);
  let dh = Math.max(1, docEl.scrollHeight, body?.scrollHeight ?? 0, docEl.clientHeight || 1);

  // Scan descendant elements for overflow scroll regions.
  if (body) {
    try {
      const nodes = body.getElementsByTagName('*');
      const cap   = Math.min(nodes.length, 3_000);
      for (let i = 0; i < cap; i++) {
        const node = nodes[i];
        if (!(node instanceof HTMLElement)) continue;
        // Only expand the bounding box when the node is genuinely overflowing
        // (scrollable content exceeds its layout box by more than 4 px).
        if (node.scrollWidth  > node.clientWidth  + 4) dw = Math.max(dw, node.scrollWidth);
        if (node.scrollHeight > node.clientHeight + 4) dh = Math.max(dh, node.scrollHeight);
      }
    } catch { /* ignore — live NodeList can throw on certain mutations */ }
  }

  heatmapMetricsCache = { at: now, dw, dh };
  return { dw, dh };
};

/**
 * Convert rrweb's viewport-relative (clientX, clientY) coordinates to document
 * (page) coordinates, accounting for both window scroll and any intermediate
 * overflow:auto ancestor scroll offsets (including shadow DOM hosts).
 *
 * rrweb records MouseInteraction and MouseMove positions in viewport space.
 * For apps with scrollable inner regions (dashboards, chat windows, etc.) we
 * need to add the scroll offset of each ancestor element to land on the correct
 * document position.
 */
const rrwebClientToDocumentXY = (clientX, clientY) => {
  const docEl = document.documentElement;
  const body  = document.body;
  let pageX   = clientX + (window.scrollX ?? window.pageXOffset ?? 0);
  let pageY   = clientY + (window.scrollY ?? window.pageYOffset ?? 0);
  try {
    let el = document.elementFromPoint(clientX, clientY);
    while (el && el !== docEl && el !== body) {
      if (el instanceof HTMLElement) {
        pageX += el.scrollLeft;
        pageY += el.scrollTop;
      }
      // Pierce shadow DOM boundaries so positions inside web components are correct.
      const root = el.getRootNode();
      el = (root instanceof ShadowRoot && root.host) ? root.host : el.parentElement;
    }
  } catch { /* ignore — elementFromPoint can throw in sandboxed iframes */ }
  return { pageX, pageY };
};

/** Normalise absolute page coordinates to 0–1 fractions of the document size. */
const heatmapNormFromPageXY = (pageX, pageY) => {
  const { dw, dh } = heatmapDocumentMetrics();
  return {
    nx: Math.min(1, Math.max(0, pageX / dw)),
    ny: Math.min(1, Math.max(0, pageY / dh)),
  };
};

/** Build a short CSS-selector hint for the clicked element (used for element-level reports). */
const heatmapSelectorHint = (el) => {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id.replace(/\s/g, '')}`;
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    if (classes) return `${tag}.${classes}`;
  }
  return tag;
};

let heatmapListenersInstalled     = false;
let heatmapPointerBridgeInstalled = false;

/**
 * The most recent pointerdown's page coordinates.
 * rrweb's MouseInteraction click event carries viewport (client) coordinates, but
 * for accurate heatmap positioning we prefer the page coordinates from the native
 * pointerdown which fired just before rrweb's synthetic click. This bridge captures
 * them and the rrweb mirror reads them back within a 900 ms window.
 */
let lastPointerDocForHeatmap = null;

/**
 * Install a capturing pointerdown listener that records the exact page coordinates
 * of each pointer press. Used as a fallback coordinate source in mirrorHeatmapFromRrweb.
 */
const installHeatmapPointerPageBridge = () => {
  if (heatmapPointerBridgeInstalled) return;
  heatmapPointerBridgeInstalled = true;
  document.addEventListener('pointerdown', (ev) => {
    if (cfg.heatmap_enabled === false) return;
    if (ev.pointerType !== 'mouse' && ev.pointerType !== 'pen' && ev.pointerType !== 'touch') return;
    lastPointerDocForHeatmap = {
      pageX:   ev.pageX,
      pageY:   ev.pageY,
      clientX: ev.clientX,
      clientY: ev.clientY,
      at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    };
  }, true);
};

/** Maximum scroll depth reached on the current page URL (reset on navigation). */
let heatmapScrollMax = 0;
/** Timestamp of the last heatmap_scroll event (shared by DOM scroll and rrweb scroll mirror). */
let heatmapScrollThrottleAt = 0;

/**
 * Inspect each rrweb event emitted during recording and derive heatmap data points.
 * This lets heatmaps work even when session recording is active without adding a
 * second set of separate DOM listeners.
 *
 * NOTE: rrweb MouseMove batches are intentionally NOT mirrored. They used to be
 * queued as `heatmap_click` points, which (a) polluted click heatmaps with hover
 * positions — nothing downstream distinguished them from real clicks — and
 * (b) forced a full document-metrics rescan (~3000 elements, layout reflow)
 * every 350 ms while the mouse moved.
 *
 * rrweb event structure we handle:
 *   type === IncrementalSnapshot (3)
 *     data.source === MouseInteraction (2) → click / tap, data.type === Click (2)
 *     data.source === Scroll (3)           → scroll depth update
 */
const mirrorHeatmapFromRrweb = (ev) => {
  // `heatmapAllowed()`, not just `heatmap_enabled` — this path is the *only* one
  // capturing while replay records, because the DOM listeners below bail out on
  // `recordingStop != null`. Checking the flag alone meant include/exclude patterns
  // were silently ignored on every page where a session was being recorded: a site
  // that excluded /checkout still collected clicks and scroll depth there.
  if (!heatmapAllowed()) return;
  if (Number(ev?.type) !== RRWEB_EVENT_TYPE.IncrementalSnapshot) return;

  const inner = ev.data;
  if (!inner || typeof inner !== 'object') return;
  const source = Number(inner.source);

  // ── MouseInteraction → Click ──────────────────────────────────────────────
  if (
    source === RRWEB_INCREMENTAL_SOURCE.MouseInteraction &&
    Number(inner.type) === RRWEB_MOUSE_INTERACTION.Click
  ) {
    const clientX = Number(inner.x);
    const clientY = Number(inner.y);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

    // Invalidate the metrics cache: page may have scrolled between last sample and this click.
    heatmapMetricsCache = null;

    const now    = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const bridge = lastPointerDocForHeatmap;
    let pageX, pageY;

    // Prefer the page coordinates from the native pointerdown bridge (more accurate for
    // overflow-scroll regions) if it fired within 900 ms and is within 8 px of this click.
    if (
      bridge &&
      now - bridge.at < 900 &&
      Math.abs(bridge.clientX - clientX) <= 8 &&
      Math.abs(bridge.clientY - clientY) <= 8
    ) {
      pageX = bridge.pageX;
      pageY = bridge.pageY;
      lastPointerDocForHeatmap = null;
    } else {
      ({ pageX, pageY } = rrwebClientToDocumentXY(clientX, clientY));
    }

    const { nx, ny } = heatmapNormFromPageXY(pageX, pageY);
    const vp = heatmapViewportCss();
    queues.heatmaps.push({
      type: 'heatmap_click',
      data: { nx, ny, target: 'rrweb', vw: vp.vw, vh: vp.vh },
      ts:  Date.now(),
      url: location.href,
      sid: activeRecordingSessionId ?? getSessionId(),
      vid: visitorId,
    });
    return;
  }

  // ── Scroll: update max depth ──────────────────────────────────────────────
  if (source === RRWEB_INCREMENTAL_SOURCE.Scroll) {
    const depth = scrollDepth01();
    if (depth > heatmapScrollMax) heatmapScrollMax = depth;
    const now = Date.now();
    if (now - heatmapScrollThrottleAt < 450) return;
    heatmapScrollThrottleAt = now;
    const vp = heatmapViewportCss();
    queues.heatmaps.push({
      type: 'heatmap_scroll',
      data: { depth: heatmapScrollMax, vw: vp.vw, vh: vp.vh },
      ts:  now,
      url: location.href,
      sid: activeRecordingSessionId ?? getSessionId(),
      vid: visitorId,
    });
  }
};

/**
 * Attach the heatmap click and scroll DOM listeners.
 * When rrweb is running these listeners are skipped (stopRecording != null) because
 * mirrorHeatmapFromRrweb already derives the same data from the rrweb event stream —
 * avoiding double-counting.
 */
const installHeatmapCapture = () => {
  if (cfg.heatmap_enabled === false) return;
  installHeatmapPointerPageBridge();
  if (heatmapListenersInstalled) return;
  heatmapListenersInstalled = true;

  document.addEventListener('click', (ev) => {
    if (stopRecording != null) return; // rrweb is recording — mirrorHeatmapFromRrweb handles clicks
    if (!heatmapAllowed()) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-seentics-block]')) return;
    const { nx, ny } = heatmapNormFromPageXY(ev.pageX, ev.pageY);
    const vp = heatmapViewportCss();
    queues.heatmaps.push({
      type: 'heatmap_click',
      data: { nx, ny, target: heatmapSelectorHint(target), vw: vp.vw, vh: vp.vh },
      ts:  Date.now(),
      url: location.href,
      sid: getSessionId(),
      vid: visitorId,
    });
  }, true);

  window.addEventListener('scroll', () => {
    if (stopRecording != null) return; // rrweb handles scroll via mirrorHeatmapFromRrweb
    if (!heatmapAllowed()) return;
    const depth = scrollDepth01();
    if (depth > heatmapScrollMax) heatmapScrollMax = depth;
    const now = Date.now();
    if (now - heatmapScrollThrottleAt < 450) return;
    heatmapScrollThrottleAt = now;
    const vp = heatmapViewportCss();
    queues.heatmaps.push({
      type: 'heatmap_scroll',
      data: { depth: heatmapScrollMax, vw: vp.vw, vh: vp.vh },
      ts:  now,
      url: location.href,
      sid: getSessionId(),
      vid: visitorId,
    });
  }, { passive: true });
};

// ─── rrweb recording ──────────────────────────────────────────────────────────

/** Stop function returned by rrweb record(); null when recording is off. */
let stopRecording = null;
/** Session ID that the active rrweb instance is recording under. */
let activeRecordingSessionId = null;

/**
 * rrweb record() options.
 * Tuned for bandwidth efficiency: higher sampling intervals, no canvas / font / inline-CSS capture.
 */
const RRWEB_OPTIONS = {
  recordAfter:      'load',
  checkoutEveryNms: 60_000, // full DOM snapshot every 60 s — shorter helps mobile tab resume recovery
  maskAllInputs:    true,
  /**
   * `maskAllInputs` covers <input>, <textarea> and <select> — not `contenteditable`,
   * which is what every rich-text editor, comment box and in-app chat widget uses. The
   * promise this product makes is that typed input never leaves the browser, so the
   * editors have to be covered too. `data-seentics-mask` is the opt-in for anything
   * else that should render as asterisks rather than be blocked outright.
   */
  maskTextSelector: '[contenteditable]:not([contenteditable="false"]), [data-seentics-mask], [data-seentics-mask] *',
  blockSelector:    '[data-seentics-block]',
  ignoreSelector:   '[data-seentics-ignore]',
  recordShadowDOM:  true,
  sampling: {
    mousemove:  100,    // sample every 100 ms (rrweb default is 50 ms)
    touchmove:  100,    // mobile: throttle touchmove (default is every event — floods queue on scroll)
    scroll:     150,
    media:      800,
    input:      'last', // only send the final input value, not every keystroke
  },
  inlineStylesheet: false, // send stylesheet URLs, not the full CSS text
  collectFonts:     false, // skip base64-embedded fonts (can be several MB per snapshot)
  recordCanvas:     false, // skip canvas frame capture (charts, maps, etc. are too large)
  errorHandler:     (_err) => { /* keep the emit pipeline alive on bad DOM mutations */ },
};

/**
 * Is session recording switched on for this site?
 *
 * Fails closed. This used to read `replay_enabled !== false`, which treats an absent
 * field as consent: a config response that omitted it — a partial payload, a renamed
 * column, an older core — silently started recording every visitor on a site where the
 * feature was off. `/tracker/init` always sends the flag, so requiring it costs nothing.
 *
 * `cfg.recording` stays as an explicit server-side kill switch layered on top.
 */
const replayEnabledForSite = () => cfg.replay_enabled === true && cfg.recording !== false;

/** Returns true when this visitor's session should be shipped as session recording rows. */
const computeReplaySessionEnabled = () => {
  if (!replayEnabledForSite()) return false;
  const samplingRate = typeof cfg.replay_sampling_rate === 'number' ? cfg.replay_sampling_rate : 1.0;
  if (samplingRate < 1.0 && Math.random() > samplingRate) return false;
  if (hasEffectivePatterns(cfg.replay_include_patterns) && !matchesPatterns(cfg.replay_include_patterns)) return false;
  if (hasEffectivePatterns(cfg.replay_exclude_patterns) &&  matchesPatterns(cfg.replay_exclude_patterns)) return false;
  return true;
};

/**
 * Start (or restart) rrweb under the given session ID.
 * Restarts are needed when the session ID rotates (inactivity / hard cap) so the
 * new session begins with a fresh FullSnapshot rather than an orphaned incremental stream.
 */
const startRrweb = (record, sessionId, shouldRecordSession) => {
  if (stopRecording) {
    try { stopRecording(); } catch { /* ignore */ }
    stopRecording = null;
  }
  activeRecordingSessionId = sessionId;
  sessionCaptureActive     = shouldRecordSession;
  const stop = record({
    ...RRWEB_OPTIONS,
    emit(event) {
      // Always mirror into heatmaps (click positions, scroll depth).
      mirrorHeatmapFromRrweb(event);
      // Only queue the raw rrweb event for replay if this session is sampled in.
      if (shouldRecordSession) {
        queues.session.push({
          type: 'rrweb',
          data: event,
          ts:   event.timestamp,
          url:  location.href,
          sid:  activeRecordingSessionId,
          vid:  visitorId,
        });
        // Full snapshots (type 2) can be 50–200 KB. Flush immediately so the data
        // is already sent before the user navigates away — iOS Safari's keepalive
        // fetch hard-cap of 64 KB would otherwise silently drop it on pagehide.
        if (event.type === 2 /* FullSnapshot */) {
          setTimeout(flush, 0);
        }
      }
    },
  });
  if (typeof stop === 'function') stopRecording = stop;
};

/**
 * Start recording, if this visitor is being recorded at all.
 *
 * The console and network sidecars are installed **here**, after the sampling decision,
 * and not at init. They used to go in for every visitor on any site with replay enabled,
 * so at a 5% sampling rate 100% of visitors had `console.*` and `window.fetch`
 * permanently overridden for events that were then discarded — and every log the host
 * application writes is attributed to seentics.js in DevTools for the trouble.
 */
const initRecording = async () => {
  if (!computeReplaySessionEnabled()) return;

  if (captureConsoleAllowed) installSessionConsoleCapture();
  if (captureNetworkAllowed) installSessionNetworkCapture();
  installSessionClientErrorCapture();

  // Open the gate before awaiting rrweb, not after. The sidecars all check this flag,
  // and rrweb is a separate network fetch — everything logged or requested while it
  // loads is exactly the early-page activity worth having. If rrweb never loads, these
  // signals arrive without a DOM stream, which is the case the player already explains.
  sessionCaptureActive = true;

  const record = await loadRrweb();
  if (!record) return;
  startRrweb(record, getSessionId(), true);
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Extract UTM parameters from the current URL, or return null if none are present. */
const utmParams = () => {
  const params = new URLSearchParams(location.search);
  const out    = {};
  for (const key of ['source', 'medium', 'campaign', 'term', 'content']) {
    const val = params.get('utm_' + key);
    if (val) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
};

/** Collect basic device / browser context sent with every pageview. */
const deviceInfo = () => ({
  ua:   navigator.userAgent,
  lang: navigator.language,
  sw:   screen.width,
  sh:   screen.height,
  vw:   innerWidth,
  vh:   innerHeight,
  dpr:  devicePixelRatio ?? 1,
  tz:   Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone ?? '',
});

// ─── Page tracking ────────────────────────────────────────────────────────────

/**
 * Push a pageview event and evaluate funnels/automations for the current URL.
 * Also resets per-page heatmap state (scroll depth, throttle timestamps, pointer bridge).
 */
const trackPage = () => {
  pageEnterMs                = Date.now();
  heatmapScrollMax           = 0;
  heatmapScrollThrottleAt    = 0;
  lastPointerDocForHeatmap   = null;

  const utm = utmParams();
  pushAnalytics('pageview', {
    title:    document.title,
    referrer: document.referrer,
    ...deviceInfo(),
    ...(utm ? {
      utm,
      ...(utm.source   ? { utm_source:   utm.source   } : {}),
      ...(utm.medium   ? { utm_medium:   utm.medium   } : {}),
      ...(utm.campaign ? { utm_campaign: utm.campaign } : {}),
      ...(utm.term     ? { utm_term:     utm.term     } : {}),
      ...(utm.content  ? { utm_content:  utm.content  } : {}),
    } : {}),
  });
  evalFunnels(location.pathname);
  void fireAutomationTrigger('page_view', { path: location.pathname, title: document.title });
};

// ─── Funnels ──────────────────────────────────────────────────────────────────

// Funnel progress is persisted in sessionStorage so a mid-funnel page refresh
// doesn't reset the visitor back to step 0.
const funnelStateKey  = (funnelId) => `snc_fs:${websiteId}:${funnelId}`;

const loadFunnelState = (funnelId) => {
  try {
    const raw = sessionStorage.getItem(funnelStateKey(funnelId));
    return raw != null ? { step: parseInt(raw, 10) || 0 } : null;
  } catch { return null; }
};

const saveFunnelState = (funnelId, step) => {
  try { sessionStorage.setItem(funnelStateKey(funnelId), String(step)); }
  catch { /* ignore */ }
};

/** In-memory funnel progress map, seeded from sessionStorage on first access. */
const funnelState = {};

/**
 * Advance a funnel by one step: emit funnel_step, and if the last step is reached
 * also emit funnel_complete and reset the step counter.
 */
const advanceFunnelStep = (funnel, state, stepName, path) => {
  pushAnalytics('funnel_step', {
    funnel_id: funnel.id,
    name:      funnel.name,
    step:      state.step,
    step_name: stepName,
    path,
  });
  state.step++;
  if (state.step >= (funnel.steps ?? []).length) {
    pushAnalytics('funnel_complete', { funnel_id: funnel.id, name: funnel.name });
    state.step = 0;
  }
  saveFunnelState(funnel.id, state.step);
};

/** Evaluate page_view-type funnel steps on each SPA navigation. */
const evalFunnels = (path) => {
  for (const funnel of funnels) {
    const steps = funnel.steps ?? [];
    if (!steps.length) continue;

    const state   = funnelState[funnel.id] ?? (funnelState[funnel.id] = loadFunnelState(funnel.id) ?? { step: 0 });
    const nextStep = steps[state.step];
    if (!nextStep) continue;

    const stepType = nextStep.step_type ?? nextStep.stepType ?? 'page_view';
    if (stepType !== 'page_view') continue; // event-type steps are handled by evalFunnelsForEvent

    const pagePath  = nextStep.page_path ?? nextStep.path;
    const matchType = nextStep.match_type ?? nextStep.matchType ?? 'exact';
    let matched = false;
    if (pagePath) {
      if (matchType === 'contains')         matched = path.includes(pagePath);
      else if (matchType === 'starts_with') matched = path.startsWith(pagePath);
      else if (matchType === 'regex')       matched = safeRegex(pagePath, path);
      else                                  matched = path === pagePath; // exact
    } else if (nextStep.pattern) {
      matched = safeRegex(nextStep.pattern, path);
    }
    if (matched) advanceFunnelStep(funnel, state, nextStep.name, path);
  }
};

/** Evaluate event-type funnel steps — called from seentics.track(). */
const evalFunnelsForEvent = (eventName) => {
  for (const funnel of funnels) {
    const steps = funnel.steps ?? [];
    if (!steps.length) continue;

    const state    = funnelState[funnel.id] ?? (funnelState[funnel.id] = loadFunnelState(funnel.id) ?? { step: 0 });
    const nextStep = steps[state.step];
    if (!nextStep) continue;

    const stepType   = nextStep.step_type ?? nextStep.stepType ?? 'page_view';
    if (stepType !== 'event') continue;

    const targetEvent = nextStep.event_type ?? nextStep.eventType ?? '';
    if (targetEvent && targetEvent === eventName) {
      advanceFunnelStep(funnel, state, nextStep.name, location.pathname);
    }
  }
};

// ─── Automation engine ────────────────────────────────────────────────────────

/** localStorage key prefix for client-side frequency-cap cache. */
const AUTO_CAP_PREFIX = 'snc_ac:';

/** Read a client-side frequency-cap entry. Returns { count, lastMs } or null. */
const readCapCache = (automationId) => {
  try {
    const raw = localStorage.getItem(AUTO_CAP_PREFIX + automationId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

/** Write / increment the client-side frequency-cap entry. */
const writeCapCache = (automationId) => {
  try {
    const prev = readCapCache(automationId) ?? { count: 0 };
    localStorage.setItem(AUTO_CAP_PREFIX + automationId, JSON.stringify({
      count:  prev.count + 1,
      lastMs: Date.now(),
    }));
  } catch { /* private mode */ }
};

/**
 * The wait/condition runtime lives in its own module so it can be tested; esbuild
 * inlines it, so this is a source-level split rather than an extra request.
 */
const MAX_ACTION_DELAY_MS = 300_000;

/** Perform one action now. Never throws — a broken action must not break the page. */
const performClientAction = (action) => {
  try {
    switch (action.type) {
      case 'show_modal':    renderModal(action);   break;
      case 'show_toast':    renderToast(action);   break;
      case 'show_banner':   renderBanner(action);  break;
      case 'highlight_element': renderHighlight(action); break;
      case 'show_tooltip':  renderTooltip(action); break;
      case 'personalize_content': renderPersonalize(action); break;
      case 'redirect':      renderRedirect(action); break;
      case 'tag_session':
        pushAnalytics('custom', { name: 'session_tag', tag: action.tag, automation_id: action.automation_id });
        break;
      case 'continue_when':
        // Not a visible action: the remainder of the graph, for the page to finish once
        // the wait resolves.
        runContinuation(action.continuation, action.delay_ms, executeClientActions, { pageEnterMs });
        break;
      default: break;
    }
  } catch { /* never crash the page */ }
};

/**
 * Run a batch of client actions, honouring the `delay_ms` a chain's delay steps produced.
 *
 * Actions are grouped by offset rather than scheduled individually: a chain of five
 * actions behind one delay costs one timer, not five, and the actions in a group still
 * run in the order the server sent them. Anything at offset zero runs synchronously, so
 * the common case — no delays at all — allocates nothing and schedules nothing.
 */
const executeClientActions = (actions) => {
  if (!actions || !actions.length) return;

  let deferred = null;

  for (const action of actions) {
    const delay = Math.min(Math.max(0, action.delay_ms | 0), MAX_ACTION_DELAY_MS);
    if (delay === 0) {
      performClientAction(action);
      continue;
    }
    if (!deferred) deferred = new Map();
    const group = deferred.get(delay);
    if (group) group.push(action);
    else deferred.set(delay, [action]);
  }

  if (!deferred) return;
  for (const [delay, group] of deferred) {
    setTimeout(() => {
      for (const action of group) performClientAction(action);
    }, delay);
  }
};

/** Inject minimal shared styles once. */
const ensureAutoStyles = (() => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const s = document.createElement('style');
    s.textContent = `
      .snc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center}
      .snc-modal{background:#fff;border-radius:8px;padding:24px;max-width:480px;width:90%;position:relative;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:inherit}
      .snc-modal h2{margin:0 0 12px;font-size:20px}
      .snc-modal p{margin:0 0 16px;line-height:1.5}
      .snc-modal-close{position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;line-height:1}
      .snc-modal-btn{display:inline-block;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;cursor:pointer;border:none;font-size:14px}
      .snc-toast{position:fixed;z-index:2147483647;padding:12px 20px;border-radius:8px;background:#1a1a1a;color:#fff;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:360px;pointer-events:auto;transition:opacity .3s}
      .snc-toast.top-left{top:20px;left:20px}
      .snc-toast.top-right{top:20px;right:20px}
      .snc-toast.bottom-left{bottom:20px;left:20px}
      .snc-toast.bottom-right{bottom:20px;right:20px}
      .snc-banner{position:fixed;left:0;right:0;z-index:2147483646;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
      .snc-banner.top{top:0} .snc-banner.bottom{bottom:0}
      .snc-banner-close{background:none;border:none;font-size:18px;cursor:pointer;padding:0;line-height:1;opacity:.7}
      .snc-highlight-pulse{outline:3px solid #f59e0b!important;outline-offset:2px;animation:snc-pulse 1.5s infinite}
      @keyframes snc-pulse{0%,100%{outline-color:#f59e0b}50%{outline-color:#ef4444}}
      .snc-tooltip{position:absolute;background:#1a1a1a;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;z-index:2147483647;pointer-events:none;max-width:240px;line-height:1.4}
      .snc-tooltip::before{content:'';position:absolute;border:6px solid transparent}
    `;
    document.head.appendChild(s);
  };
})();

/** Escape a string for safe interpolation into innerHTML (text or attribute position). */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Allow only http(s)/relative URLs in injected href/src — blocks javascript: etc. */
const safeActionUrl = (u) => {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|\/)/i.test(s) ? escapeHtml(s) : '#';
};

/** Allow only plausible CSS color tokens in injected inline styles. */
const safeColor = (c, fallback) => {
  const s = String(c ?? '').trim();
  return /^[#a-zA-Z0-9(),.%\s-]{1,40}$/.test(s) && s ? s : fallback;
};

const renderModal = (action) => {
  ensureAutoStyles();
  const overlay = document.createElement('div');
  overlay.className = 'snc-overlay';
  const bgColor   = safeColor(action.background_color, '#ffffff');
  const textColor = safeColor(action.text_color,       '#000000');
  const btnColor  = safeColor(action.button_color,     '#2563eb');
  const btnText   = safeColor(action.button_text_color, '#ffffff');
  overlay.innerHTML = `
    <div class="snc-modal" style="background:${bgColor};color:${textColor}">
      <button class="snc-modal-close" aria-label="Close">&times;</button>
      ${action.image_url ? `<img src="${safeActionUrl(action.image_url)}" style="width:100%;border-radius:4px;margin-bottom:12px" alt="">` : ''}
      ${action.title   ? `<h2>${escapeHtml(action.title)}</h2>` : ''}
      ${action.body    ? `<p>${escapeHtml(action.body)}</p>`    : ''}
      ${action.button_text ? `<a href="${action.button_url ? safeActionUrl(action.button_url) : '#'}" class="snc-modal-btn" style="background:${btnColor};color:${btnText}" ${action.button_url ? '' : 'onclick="return false"'}>${escapeHtml(action.button_text)}</a>` : ''}
    </div>`;
  overlay.querySelector('.snc-modal-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
};

const renderToast = (action) => {
  ensureAutoStyles();
  const pos   = action.position ?? 'bottom-right';
  const toast = document.createElement('div');
  toast.className = `snc-toast ${pos}`;
  toast.style.background = action.background_color ?? '#1a1a1a';
  toast.style.color       = action.text_color       ?? '#ffffff';
  toast.textContent = action.message ?? '';
  document.body.appendChild(toast);
  const dur = (action.duration_ms ?? 4000);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, dur);
};

const renderBanner = (action) => {
  ensureAutoStyles();
  const pos    = action.position ?? 'top';
  const banner = document.createElement('div');
  banner.className = `snc-banner ${pos}`;
  banner.style.background = action.background_color ?? '#1e40af';
  banner.style.color       = action.text_color       ?? '#ffffff';
  banner.innerHTML = `
    <span>${escapeHtml(action.message ?? '')}</span>
    ${action.button_text ? `<a href="${action.button_url ? safeActionUrl(action.button_url) : '#'}" style="color:inherit;font-weight:600;text-decoration:underline;white-space:nowrap">${escapeHtml(action.button_text)}</a>` : ''}
    <button class="snc-banner-close" aria-label="Close">&times;</button>
  `;
  banner.querySelector('.snc-banner-close').onclick = () => banner.remove();
  document.body.appendChild(banner);
  if (action.duration_ms) setTimeout(() => banner.remove(), action.duration_ms);
};

const renderHighlight = (action) => {
  ensureAutoStyles();
  const el = action.selector ? document.querySelector(action.selector) : null;
  if (!el) return;
  el.classList.add('snc-highlight-pulse');
  if (action.scroll_into_view !== false) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('snc-highlight-pulse'), action.duration_ms ?? 4000);
};

const renderTooltip = (action) => {
  ensureAutoStyles();
  const anchor = action.selector ? document.querySelector(action.selector) : null;
  if (!anchor) return;
  const tip = document.createElement('div');
  tip.className = 'snc-tooltip';
  tip.textContent = action.message ?? '';
  document.body.appendChild(tip);
  const rect = anchor.getBoundingClientRect();
  const top  = rect.top + window.scrollY - tip.offsetHeight - 10;
  tip.style.left = `${rect.left + window.scrollX}px`;
  tip.style.top  = `${top}px`;
  setTimeout(() => tip.remove(), action.duration_ms ?? 5000);
};

const renderPersonalize = (action) => {
  const els = action.selector ? document.querySelectorAll(action.selector) : [];
  for (const el of els) {
    if (action.html) el.innerHTML = action.html;
    else if (action.text != null) el.textContent = action.text;
  }
};

const renderRedirect = (action) => {
  const url = action.url;
  if (!url) return;
  const delay = action.delay_ms ?? 0;
  const open  = () => {
    if (action.new_tab) window.open(url, '_blank');
    else location.href = url;
  };
  if (delay > 0) setTimeout(open, delay);
  else open();
};

/** The triggers an automation listens for. */
const automationTriggers = (a) => (a && Array.isArray(a.triggers) ? a.triggers : []);

/** Rebuild the trigger-type index. Called once per automations load. */
const indexAutomationTriggers = () => {
  const types = new Set();
  for (const auto of automations) {
    for (const t of automationTriggers(auto)) {
      if (t && t.type) types.add(t.type);
    }
  }
  automationTriggerTypes = types;
};

/**
 * Fire an automation trigger: POST to /tracker/automations/evaluate,
 * parse response, execute client-side actions.
 */
const fireAutomationTrigger = async (triggerType, triggerData) => {
  if (!websiteId) return;

  // One Set lookup, not a scan of every automation's every trigger. This runs on the
  // hot path — clicks, scroll thresholds, visibility changes — so the answer for a
  // trigger nobody listens for has to be free.
  if (!automationTriggerTypes.has(triggerType)) return;

  // Collapse a burst into one round trip. Rapid triggers can fire several times before
  // the first response lands; without this each costs a request and the actions from
  // all of them render on top of each other.
  if (automationInFlight.has(triggerType)) return;
  automationInFlight.add(triggerType);

  pushAnalytics('automation_trigger', { event: triggerType, props: triggerData });

  try {
    const res = await fetch(apiHost + '/api/v1/tracker/automations/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        website_id:   websiteId,
        anonymous_id: visitorId,
        session_id:   getSessionId(),
        trigger:      { type: triggerType, ...triggerData },
        context: {
          page:    location.pathname,
          url:     location.href,
          title:   document.title,
          referrer: document.referrer,
        },
      }),
    });
    if (!res.ok) return;
    const { actions } = await res.json();
    if (actions?.length) {
      // Charge the client-side cap once per automation, not once per action — a chain
      // of four actions is still one impression.
      const charged = new Set();
      for (const a of actions) {
        if (charged.has(a.automation_id)) continue;
        charged.add(a.automation_id);
        writeCapCache(a.automation_id);
      }
      executeClientActions(actions);
    }
  } catch { /* best-effort */ }
  finally { automationInFlight.delete(triggerType); }
};

// ─── Exit-intent trigger ──────────────────────────────────────────────────────

let exitIntentCooldown = false;

/** Fire the exit_intent automation trigger when the cursor leaves through the top of the viewport. */
const installExitIntent = () => {
  document.addEventListener('mouseleave', (ev) => {
    if (ev.clientY > 0) return; // only fire when leaving through the top edge
    if (exitIntentCooldown) return;
    exitIntentCooldown = true;
    void fireAutomationTrigger('exit_intent', { path: location.pathname });
    setTimeout(() => { exitIntentCooldown = false; }, 30_000); // 30 s cooldown
  });
};

// ─── Inactivity trigger ───────────────────────────────────────────────────────

const INACTIVITY_TRIGGER_MS = 30_000;
let inactivityTimer     = null;
let inactivityInstalled = false;

const resetInactivityTimer = () => {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    void fireAutomationTrigger('inactivity', { path: location.pathname, inactivity_ms: INACTIVITY_TRIGGER_MS });
    inactivityTimer = null;
  }, INACTIVITY_TRIGGER_MS);
};

/** Listen for any user activity and reset the inactivity timer each time. */
const installInactivity = () => {
  if (inactivityInstalled) return;
  inactivityInstalled = true;
  for (const eventName of ['mousemove', 'keydown', 'scroll', 'click', 'touchstart']) {
    window.addEventListener(eventName, resetInactivityTimer, { passive: true });
  }
  resetInactivityTimer();
};

// ─── Scroll depth trigger ─────────────────────────────────────────────────────

const installScrollDepth = () => {
  const milestones = [25, 50, 75, 90];
  const fired = new Set();
  const check = () => {
    const docH = Math.max(document.documentElement.scrollHeight, 1);
    const pct  = Math.round(((window.scrollY + window.innerHeight) / docH) * 100);
    for (const m of milestones) {
      if (pct >= m && !fired.has(m)) {
        fired.add(m);
        void fireAutomationTrigger('scroll_depth', { depth: m, path: location.pathname });
      }
    }
  };
  window.addEventListener('scroll', check, { passive: true });
};

// ─── Time on page trigger ─────────────────────────────────────────────────────

const installTimeOnPage = () => {
  const thresholds = [15, 30, 60, 120, 300]; // seconds
  const fired = new Set();
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    for (const t of thresholds) {
      if (elapsed >= t && !fired.has(t)) {
        fired.add(t);
        void fireAutomationTrigger('time_on_page', { seconds: t, path: location.pathname });
      }
    }
    // All thresholds fired — nothing left to observe, stop ticking.
    if (fired.size === thresholds.length) clearInterval(timer);
  }, 5_000);
};

// ─── Rage-click trigger ───────────────────────────────────────────────────────

const installRageClick = () => {
  const WINDOW_MS  = 1_000;
  const RADIUS_PX  = 80;
  const MIN_CLICKS = 3;
  let clicks = [];
  let fired = false;
  document.addEventListener('click', (ev) => {
    const now = Date.now();
    clicks = clicks.filter((c) => now - c.t < WINDOW_MS);
    clicks.push({ x: ev.clientX, y: ev.clientY, t: now });
    if (clicks.length < MIN_CLICKS) return;
    const cx = clicks.reduce((s, c) => s + c.x, 0) / clicks.length;
    const cy = clicks.reduce((s, c) => s + c.y, 0) / clicks.length;
    const inRadius = clicks.every((c) => Math.hypot(c.x - cx, c.y - cy) < RADIUS_PX);
    if (inRadius && !fired) {
      fired = true;
      void fireAutomationTrigger('rage_click', {
        path:   location.pathname,
        count:  clicks.length,
        x:      Math.round(cx),
        y:      Math.round(cy),
        target: (ev.target?.tagName ?? '').toLowerCase(),
      });
      setTimeout(() => { fired = false; clicks = []; }, 5_000);
    }
  });
};

// ─── Form abandon trigger ─────────────────────────────────────────────────────

const installFormAbandon = () => {
  const touched = new Set();
  document.addEventListener('focusin', (ev) => {
    if (ev.target?.form) touched.add(ev.target.form);
  }, true);
  // Only the submitted form stops being "abandoned" — other touched forms still count.
  document.addEventListener('submit', (ev) => { if (ev.target) touched.delete(ev.target); }, true);
  const onLeave = () => {
    if (!touched.size) return;
    for (const form of touched) {
      const id = form.id || form.name || form.action || 'unknown';
      void fireAutomationTrigger('form_abandon', { path: location.pathname, form_id: id });
    }
    // Clear so repeated tab switches don't fire duplicate abandon triggers.
    touched.clear();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
  });
};

// ─── JS error trigger ─────────────────────────────────────────────────────────

const installJsErrorTrigger = () => {
  let errorCount = 0;
  const MAX_FIRES = 3;
  const fire = (message, source) => {
    if (++errorCount > MAX_FIRES) return;
    void fireAutomationTrigger('js_error', { path: location.pathname, message: String(message).slice(0, 200), source: String(source ?? '').slice(0, 100) });
  };
  window.addEventListener('error', (ev) => fire(ev.message, ev.filename));
  window.addEventListener('unhandledrejection', (ev) => fire(String(ev.reason), 'promise'));
};

// ─── Tab visibility trigger ───────────────────────────────────────────────────

const installTabVisibility = () => {
  document.addEventListener('visibilitychange', () => {
    const type = document.visibilityState === 'hidden' ? 'tab_hidden' : 'tab_visible';
    void fireAutomationTrigger(type, { path: location.pathname });
  });
};

// ─── Click trigger (delegated, CSS-selector-based) ────────────────────────────

const installClickTrigger = () => {
  // Selectors are collected once at install rather than rebuilt on every click. The
  // listener is delegated to the document, so it runs for every click on the page —
  // walking each automation's triggers there is work paid on the interaction path.
  const selectors = [];
  const seenSelectors = new Set();
  for (const auto of automations) {
    for (const t of automationTriggers(auto)) {
      if (!t || t.type !== 'click' || !t.selector || seenSelectors.has(t.selector)) continue;
      seenSelectors.add(t.selector);
      selectors.push(t.selector);
    }
  }
  if (!selectors.length) return;

  document.addEventListener('click', (ev) => {
    const el = ev.target;
    if (!el) return;
    for (const sel of selectors) {
      try {
        if (el.matches(sel) || el.closest(sel)) {
          void fireAutomationTrigger('click', {
            path:     location.pathname,
            selector: sel,
            text:     (el.textContent ?? '').trim().slice(0, 100),
          });
        }
      } catch { /* invalid selector */ }
    }
  }, { passive: true });
};

// ─── Performance timing ───────────────────────────────────────────────────────

/** Push a performance event with Navigation Timing metrics once the page is fully loaded. */
const trackPerf = () => {
  const entries = performance?.getEntriesByType?.('navigation');
  const timing  = entries?.[0];
  if (!timing?.loadEventEnd) return;
  pushAnalytics('performance', {
    load:    Math.round(timing.loadEventEnd),
    dom:     Math.round(timing.domContentLoadedEventEnd),
    ttfb:    Math.round(timing.responseStart),
    dns:     Math.round(timing.domainLookupEnd - timing.domainLookupStart),
    connect: Math.round(timing.connectEnd      - timing.connectStart),
    render:  Math.round(timing.loadEventEnd    - timing.responseEnd),
  });
};

/**
 * Schedule the performance event. init() runs at/after the load event, so a
 * plain `addEventListener('load', ...)` registered inside init would never fire
 * — the load event has already happened. Check readyState first.
 */
const schedulePerfTracking = () => {
  if (document.readyState === 'complete') setTimeout(trackPerf, 100);
  else window.addEventListener('load', () => setTimeout(trackPerf, 100));
};

// ─── SPA routing ──────────────────────────────────────────────────────────────

/**
 * Detect SPA navigations by patching history.pushState / history.replaceState and
 * listening to popstate. On each navigation: track a new pageview, request a fresh
 * rrweb snapshot for the replay, and schedule a new heatmap screenshot.
 */
const initRouting = () => {
  let lastPath = location.pathname;
  const onNavigation = () => {
    if (location.pathname === lastPath) return;
    clearScreenshotScheduleTimers();
    lastPath = location.pathname;
    if (autoTrack) trackPage();
    // Give the new route 50 ms to mount before asking rrweb for a full snapshot.
    window.setTimeout(requestRrwebFullSnapshotForNavigation, 50);
    if (cfg.heatmap_layout_enabled !== false) {
      scheduleHeatmapScreenshotAfterAppIdle();
    }
  };
  window.addEventListener('popstate', onNavigation);
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = (...args) => { original(...args); onNavigation(); };
  }
};

/** Ask rrweb to take a fresh full snapshot after a navigation (avoids checkout drift). */
const requestRrwebFullSnapshotForNavigation = () => {
  const rec = window.__rrweb_record;
  if (!rec?.takeFullSnapshot) return;
  try { rec.takeFullSnapshot(false); }
  catch { /* not recording yet */ }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

const init = () => {
  if (!websiteId) return;

  initRouting();

  // Flush all queued data when the page is hidden (tab switch, navigation away, close).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });
  window.addEventListener('pagehide', flushBeacon);

  fetch(apiHost + '/api/v1/tracker/init/' + websiteId)
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.warn('[Seentics] tracker init failed:', response.status, response.statusText, text?.slice?.(0, 200) ?? '');
        throw new Error('tracker init failed');
      }
      return response.json();
    })
    .then(async (data) => {
      cfg         = data.config      ?? {};
      funnels     = data.funnels     ?? [];
      automations = data.automations ?? [];
      indexAutomationTriggers();

      if (!trackingAllowed()) {
        console.info('[Seentics] tracking disabled by the site privacy policy.');
        return;
      }

      if (autoTrack) trackPage();

      // Session recording setup. `initRecording` decides whether this visitor is
      // recorded and installs the capture hooks only if so — nothing is patched for a
      // visitor who was sampled out.
      await initRecording();

      // Heatmap screenshot scheduling.
      if (cfg.heatmap_layout_enabled !== false) {
        scheduleHeatmapScreenshotAfterAppIdle();
      }

      installHeatmapCapture();
      installExitIntent();
      installInactivity();
      installScrollDepth();
      installTimeOnPage();
      installRageClick();
      installFormAbandon();
      installJsErrorTrigger();
      installTabVisibility();
      installClickTrigger();
      schedulePerfTracking();

      flush(); // send the initial pageview + rrweb snapshot immediately
      flushInterval = window.setInterval(flush, FLUSH_MS);
    })
    .catch(() => {
      // Init failed (network error, wrong domain, etc.) — run in degraded mode.
      // Analytics and heatmaps still work; session recording is unavailable.
      console.warn(
        '[Seentics] tracker running in degraded mode (no session recording). ' +
        'Fix: data-api-host should point to your API (e.g. same origin as this app in dev).',
      );
      if (autoTrack) trackPage();
      installHeatmapCapture();
      installExitIntent();
      installInactivity();
      installScrollDepth();
      installTimeOnPage();
      installRageClick();
      installFormAbandon();
      installJsErrorTrigger();
      installTabVisibility();
      installClickTrigger();
      schedulePerfTracking();
      flush();
      flushInterval = window.setInterval(flush, FLUSH_MS);
    });
};

// ─── Public API ───────────────────────────────────────────────────────────────

window.seentics = {
  /**
   * Track a custom event.
   * @param {string} name  - Event name (e.g. 'signup', 'add_to_cart').
   * @param {object} props - Optional event properties.
   */
  track(name, props) {
    pushAnalytics('custom', { name, ...(props ?? {}) });
    evalFunnelsForEvent(name);
    void fireAutomationTrigger('custom_event', { name, ...(props ?? {}) });
  },

  /**
   * Identify the current visitor with a known user ID.
   *
   * The anonymous visitor id is deliberately left alone. This used to overwrite it —
   * `snc_vid = userId` — which broke two things at once. It split every identified
   * visitor into two uniques, because the events before the call and the events after
   * it carried different ids for one person. And it wrote a customer-supplied
   * identifier, very often an email address, into `analytics_events.visitor_id`, where
   * it sat in the raw event log and came back out of `/export`.
   *
   * Neither was needed to stitch the identity. The id travels in the event's own
   * payload, ingest reads it there, and `user_profiles.user_id` is the column that
   * links a person's anonymous ids together — indexed for exactly that.
   *
   * @param {string} userId - Your internal user ID.
   * @param {object} traits - Optional user traits (name, email, plan, etc.).
   */
  identify(userId, traits) {
    pushAnalytics('identify', { user_id: userId, traits: traits ?? {} });
  },

  /** Manually push a pageview (useful when auto-tracking is disabled). */
  page: trackPage,

  /** Manually flush all queued events to /collect immediately. */
  flush,
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

if (document.readyState === 'complete') init();
else window.addEventListener('load', init);

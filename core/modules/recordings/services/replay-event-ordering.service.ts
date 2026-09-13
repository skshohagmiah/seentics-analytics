/**
 * Stable ordering for tracker replay envelopes stored in bundles / spool.
 * Prefer rrweb's own `data.timestamp` (replay timeline); envelope `ts` alone mixes
 * relative rrweb time with `session_error`'s `Date.now()` and breaks sort order.
 */
function replayEventOrderingMs(ev: Record<string, unknown>): number {
  if (ev.type === "rrweb" && ev.data && typeof ev.data === "object" && !Array.isArray(ev.data)) {
    const raw = (ev.data as Record<string, unknown>).timestamp;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  const t = ev.ts;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function envelopeKindOrder(ev: Record<string, unknown>): number {
  const ty = ev.type;
  if (ty === "rrweb") return 0;
  if (ty === "console_event" || ty === "network_event") return 1;
  if (ty === "session_error") return 2;
  return 3;
}

export function compareReplayEnvelopeEvents(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const ta = replayEventOrderingMs(a);
  const tb = replayEventOrderingMs(b);
  if (ta !== tb) return ta - tb;
  const ka = envelopeKindOrder(a);
  const kb = envelopeKindOrder(b);
  if (ka !== kb) return ka - kb;
  return 0;
}

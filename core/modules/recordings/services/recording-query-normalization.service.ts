/** Normalize recording query paging and timestamp values. */
export function timestampToIso(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const d = new Date(v as string | number);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date(0).toISOString();
}

export function clampListParams(limit: number, offset: number) {
  let l = limit;
  let o = offset;
  if (!Number.isFinite(l) || l < 1) l = 20;
  if (l > 500) l = 500;
  if (!Number.isFinite(o) || o < 0) o = 0;
  return { limit: l, offset: o };
}

export const replayNotReady = "replay recording is not available yet";

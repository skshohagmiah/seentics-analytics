import type { TrackerCollectBody } from "../../../platform/lib/api-types";
import type { AnalyticsIngestMeta } from "../../../platform/lib/analytics-ingest-meta";
import { clampClientTs } from "../../../platform/lib/client-timestamp";
import type { TrackerEvent } from "../../../platform/lib/types";
import type { WebsiteTrackerRow } from "../../websites/interfaces";
import type { IngestQueue } from "../interfaces";

export type TrackerBatchRoutingContext = {
  body: TrackerCollectBody;
  website: WebsiteTrackerRow;
  userAgent: string;
  ingestMeta: AnalyticsIngestMeta;
  queue: IngestQueue;
};

function clientTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return clampClientTs(Math.trunc(value));
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return clampClientTs(Math.trunc(parsed));
  }
  return Date.now();
}

function dataMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeTrackerEvents(raw: unknown[]): TrackerEvent[] {
  const events: TrackerEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    events.push({
      type: typeof value.type === "string" ? value.type : "",
      data: dataMap(value.data),
      ts: clientTimestamp(value.ts),
      url: typeof value.url === "string" ? value.url : "",
      sid: typeof value.sid === "string" ? value.sid : "",
      vid: typeof value.vid === "string" ? value.vid : undefined,
      websiteId: "",
      doc_w: typeof value.doc_w === "number" && Number.isFinite(value.doc_w) ? value.doc_w : undefined,
      doc_h: typeof value.doc_h === "number" && Number.isFinite(value.doc_h) ? value.doc_h : undefined,
    });
  }
  return events;
}

export function chronological<T extends { ts: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.ts - right.ts);
}

export function attachIngestMetadata(
  rows: TrackerEvent[],
  ingestMeta: AnalyticsIngestMeta,
): TrackerEvent[] {
  return rows.map((event) => ({ ...event, ingestMeta }));
}

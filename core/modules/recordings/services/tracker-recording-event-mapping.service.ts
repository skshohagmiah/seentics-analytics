import type { TrackerEvent } from "../../../platform/lib/types";

/** The recording event types this module claims from a mixed tracker batch. */
const RECORDING_TYPES = new Set(["rrweb", "session_error", "console_event", "network_event"]);

/**
 * The recording events in a raw tracker batch.
 *
 * The filter lived in `modules/ingest/services/collect-handlers.ts`, which meant ingest
 * held the list of event types that make up a session recording. No projection here —
 * `TrackerEvent` is already the engine's input shape — so this is purely the ownership
 * move: which types are ours is this module's answer.
 *
 * Events without a session id are dropped: a recording is keyed by session, and a chunk
 * with no session has nothing to attach to.
 */
export function recordingEventsIn(rows: readonly TrackerEvent[]): TrackerEvent[] {
  return rows.filter((e) => RECORDING_TYPES.has(e.type) && Boolean(e.sid));
}

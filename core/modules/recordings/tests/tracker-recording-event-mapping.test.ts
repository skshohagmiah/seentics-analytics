import { describe, expect, it } from "bun:test";
import type { TrackerEvent } from "../../../platform/lib/types";
import { recordingEventsIn } from "../services/tracker-recording-event-mapping.service";

/**
 * Which event types make up a session recording — this module's answer, not ingest's.
 *
 * No projection to test: `TrackerEvent` is already the engine's input shape, so this file
 * pins the filter and nothing else.
 */

function ev(overrides: Partial<TrackerEvent> = {}): TrackerEvent {
  return {
    type: "rrweb",
    ts: 1_767_225_600_000,
    sid: "sess_1",
    websiteId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

describe("recordingEventsIn", () => {
  it("keeps the four recording types", () => {
    const rows = [
      ev({ type: "rrweb" }),
      ev({ type: "session_error" }),
      ev({ type: "console_event" }),
      ev({ type: "network_event" }),
    ];
    expect(recordingEventsIn(rows).map((e) => e.type)).toEqual([
      "rrweb",
      "session_error",
      "console_event",
      "network_event",
    ]);
  });

  /** A `/collect` body is mixed; anything not ours belongs to another module's table. */
  it("drops every other type", () => {
    const rows = [ev({ type: "pageview" }), ev({ type: "heatmap_click" })];
    expect(recordingEventsIn(rows)).toEqual([]);
  });

  /**
   * A recording is keyed by session, and chunk sequences are assigned per session. An event
   * with no session id has nothing to attach to and would produce an unreadable row.
   */
  it("drops events with no session id", () => {
    expect(recordingEventsIn([ev({ sid: "" })])).toEqual([]);
  });

  it("returns an empty array for an empty batch", () => {
    expect(recordingEventsIn([])).toEqual([]);
  });

  it("preserves order", () => {
    const out = recordingEventsIn([
      ev({ sid: "a", ts: 1 }),
      ev({ type: "pageview", sid: "b", ts: 2 }),
      ev({ sid: "c", ts: 3 }),
    ]);
    expect(out.map((e) => e.sid)).toEqual(["a", "c"]);
  });
});

import { beforeAll, describe, expect, it, mock } from "bun:test";
import { fakeDbModule, fakeLogger } from "./helpers/fake-db";
import type { FrequencyCapSpec, ImpressionStats } from "../services/automation-frequency-cap.service";

// The module reads `db` at import time even though these two helpers are pure, so the
// driver has to be stubbed before it loads.
mock.module("../../../db", fakeDbModule);
mock.module("../../../platform/lib/logger", fakeLogger);

let capsRequireLookup: typeof import("../services/automation-frequency-cap.service").capsRequireLookup;
let isCappedFromStats: typeof import("../services/automation-frequency-cap.service").isCappedFromStats;

beforeAll(async () => {
  ({ capsRequireLookup, isCappedFromStats } = await import("../services/automation-frequency-cap.service"));
});

/**
 * Frequency caps decide whether a visitor sees an automation again.
 *
 * Both directions of an error are user-visible: too loose and a banner follows someone
 * around the site, too tight and a campaign silently never fires. The boundaries are
 * therefore asserted exactly — a cap of N means the Nth impression is the last one, and
 * `>=` versus `>` is the whole difference between showing something twice and once.
 */

function stats(over: Partial<ImpressionStats> = {}): ImpressionStats {
  return { sessionCount: 0, lifetimeCount: 0, lastShownAt: null, ...over };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("capsRequireLookup", () => {
  it("is false for an automation with no caps — no query needed", () => {
    // The batched stats query only runs for automations that need it; a false positive
    // here costs a round trip on every evaluate for every uncapped automation.
    expect(capsRequireLookup({})).toBe(false);
  });

  it("is true when any single cap is set", () => {
    expect(capsRequireLookup({ maxPerSession: 1 })).toBe(true);
    expect(capsRequireLookup({ maxPerUser: 1 })).toBe(true);
    expect(capsRequireLookup({ cooldownDays: 1 })).toBe(true);
  });

  it("is true for a cap of zero, which is a real cap meaning never", () => {
    // `!= null` rather than a truthiness test: 0 is falsy but means "show it no times",
    // which is the most restrictive cap there is.
    expect(capsRequireLookup({ maxPerSession: 0 })).toBe(true);
    expect(capsRequireLookup({ maxPerUser: 0 })).toBe(true);
    expect(capsRequireLookup({ cooldownDays: 0 })).toBe(true);
  });

  it("ignores undefined caps", () => {
    expect(capsRequireLookup({ maxPerSession: undefined } as FrequencyCapSpec)).toBe(false);
  });
});

describe("isCappedFromStats", () => {
  it("does not cap when no caps are configured, whatever the history", () => {
    expect(
      isCappedFromStats(stats({ sessionCount: 99, lifetimeCount: 999, lastShownAt: new Date() }), {}),
    ).toBe(false);
  });

  it("does not cap a visitor with no history", () => {
    expect(isCappedFromStats(stats(), { maxPerSession: 1, maxPerUser: 5, cooldownDays: 7 })).toBe(
      false,
    );
  });

  it("treats missing stats as no history rather than as capped", () => {
    // An automation absent from the batched result had no impressions; defaulting the
    // other way would mean a brand-new automation never fires.
    expect(isCappedFromStats(undefined, { maxPerSession: 1 })).toBe(false);
  });

  describe("maxPerSession", () => {
    it("allows exactly N impressions in a session and blocks the N+1th", () => {
      expect(isCappedFromStats(stats({ sessionCount: 0 }), { maxPerSession: 1 })).toBe(false);
      expect(isCappedFromStats(stats({ sessionCount: 1 }), { maxPerSession: 1 })).toBe(true);

      expect(isCappedFromStats(stats({ sessionCount: 2 }), { maxPerSession: 3 })).toBe(false);
      expect(isCappedFromStats(stats({ sessionCount: 3 }), { maxPerSession: 3 })).toBe(true);
    });

    it("blocks immediately for a cap of zero", () => {
      expect(isCappedFromStats(stats({ sessionCount: 0 }), { maxPerSession: 0 })).toBe(true);
    });

    it("stays capped past the limit", () => {
      expect(isCappedFromStats(stats({ sessionCount: 50 }), { maxPerSession: 3 })).toBe(true);
    });

    it("ignores lifetime history when only a session cap is set", () => {
      expect(
        isCappedFromStats(stats({ sessionCount: 0, lifetimeCount: 500 }), { maxPerSession: 1 }),
      ).toBe(false);
    });
  });

  describe("maxPerUser", () => {
    it("allows exactly N lifetime impressions and blocks the N+1th", () => {
      expect(isCappedFromStats(stats({ lifetimeCount: 4 }), { maxPerUser: 5 })).toBe(false);
      expect(isCappedFromStats(stats({ lifetimeCount: 5 }), { maxPerUser: 5 })).toBe(true);
    });

    it("blocks immediately for a cap of zero", () => {
      expect(isCappedFromStats(stats({ lifetimeCount: 0 }), { maxPerUser: 0 })).toBe(true);
    });

    it("ignores session history when only a lifetime cap is set", () => {
      expect(
        isCappedFromStats(stats({ sessionCount: 50, lifetimeCount: 1 }), { maxPerUser: 5 }),
      ).toBe(false);
    });
  });

  describe("cooldownDays", () => {
    it("blocks while the cooldown is still running", () => {
      expect(
        isCappedFromStats(stats({ lastShownAt: new Date(Date.now() - 3 * DAY) }), {
          cooldownDays: 7,
        }),
      ).toBe(true);
    });

    it("allows once the cooldown has fully elapsed", () => {
      expect(
        isCappedFromStats(stats({ lastShownAt: new Date(Date.now() - 8 * DAY) }), {
          cooldownDays: 7,
        }),
      ).toBe(false);
    });

    it("blocks an impression from one hour ago under a one-day cooldown", () => {
      expect(
        isCappedFromStats(stats({ lastShownAt: new Date(Date.now() - HOUR) }), { cooldownDays: 1 }),
      ).toBe(true);
    });

    it("allows an impression from just over the cooldown boundary", () => {
      expect(
        isCappedFromStats(stats({ lastShownAt: new Date(Date.now() - DAY - 60_000) }), {
          cooldownDays: 1,
        }),
      ).toBe(false);
    });

    it("does not block a visitor who has never seen it, whatever the cooldown", () => {
      expect(isCappedFromStats(stats({ lastShownAt: null }), { cooldownDays: 365 })).toBe(false);
    });

    it("blocks anything shown at all under a zero-day cooldown", () => {
      // A cooldown of 0 means "not again right now"; `lastShownAt >= now` is only true
      // for an impression in this same instant, so a past impression must not block.
      expect(
        isCappedFromStats(stats({ lastShownAt: new Date(Date.now() - 1000) }), { cooldownDays: 0 }),
      ).toBe(false);
    });

    it("blocks a future lastShownAt rather than treating clock skew as expiry", () => {
      expect(
        isCappedFromStats(stats({ lastShownAt: new Date(Date.now() + HOUR) }), { cooldownDays: 1 }),
      ).toBe(true);
    });
  });

  describe("combined caps", () => {
    it("caps when any single cap is exceeded", () => {
      const caps: FrequencyCapSpec = { maxPerSession: 2, maxPerUser: 10, cooldownDays: 7 };

      expect(isCappedFromStats(stats({ sessionCount: 2 }), caps)).toBe(true);
      expect(isCappedFromStats(stats({ lifetimeCount: 10 }), caps)).toBe(true);
      expect(isCappedFromStats(stats({ lastShownAt: new Date() }), caps)).toBe(true);
    });

    it("allows only when every cap passes", () => {
      expect(
        isCappedFromStats(
          stats({ sessionCount: 1, lifetimeCount: 9, lastShownAt: new Date(Date.now() - 8 * DAY) }),
          { maxPerSession: 2, maxPerUser: 10, cooldownDays: 7 },
        ),
      ).toBe(false);
    });
  });
});

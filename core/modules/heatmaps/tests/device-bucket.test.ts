import { describe, expect, it } from "bun:test";
import {
  coerceSnapshotDeviceBucket,
  deviceTypeFromUA,
  snapshotDeviceBucket,
  snapshotDeviceBucketForWidth,
} from "../lib/device";
import { layoutPathSlot } from "../lib/keys";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

describe("snapshotDeviceBucket", () => {
  it("files a background under the same bucket the points get", () => {
    for (const ua of [IPHONE, IPAD, MAC]) {
      expect(String(snapshotDeviceBucket(ua))).toBe(deviceTypeFromUA(ua));
    }
  });

  it("lands an unparseable agent in desktop rather than an Unknown bucket", () => {
    // Points keep "Unknown"; a background cannot — an Unknown bucket would collect
    // captures of every width and render one of them under all of them.
    expect(deviceTypeFromUA("")).toBe("Unknown");
    expect(snapshotDeviceBucket("")).toBe("desktop");
    expect(snapshotDeviceBucket(null)).toBe("desktop");
    expect(snapshotDeviceBucket("not a user agent")).toBe("desktop");
  });
});

describe("snapshotDeviceBucketForWidth", () => {
  it("buckets on the CSS breakpoints sites actually use", () => {
    expect(snapshotDeviceBucketForWidth(390)).toBe("mobile");
    expect(snapshotDeviceBucketForWidth(767)).toBe("mobile");
    expect(snapshotDeviceBucketForWidth(768)).toBe("tablet");
    expect(snapshotDeviceBucketForWidth(1023)).toBe("tablet");
    expect(snapshotDeviceBucketForWidth(1024)).toBe("desktop");
    expect(snapshotDeviceBucketForWidth(1920)).toBe("desktop");
  });

  it("treats a missing or nonsense width as desktop", () => {
    expect(snapshotDeviceBucketForWidth(0)).toBe("desktop");
    expect(snapshotDeviceBucketForWidth(-1)).toBe("desktop");
    expect(snapshotDeviceBucketForWidth(NaN)).toBe("desktop");
  });
});

describe("coerceSnapshotDeviceBucket", () => {
  it("resolves the dashboard's all-devices filter to desktop", () => {
    expect(coerceSnapshotDeviceBucket("all")).toBe("desktop");
    expect(coerceSnapshotDeviceBucket(undefined)).toBe("desktop");
    expect(coerceSnapshotDeviceBucket("Mobile")).toBe("mobile");
    expect(coerceSnapshotDeviceBucket(" tablet ")).toBe("tablet");
  });
});

describe("layoutPathSlot", () => {
  it("keeps the historical slot for desktop so existing captures still resolve", () => {
    expect(layoutPathSlot("site1", "/pricing", "desktop")).toBe(layoutPathSlot("site1", "/pricing"));
  });

  it("gives each bucket its own object so one capture cannot overwrite another", () => {
    const desktop = layoutPathSlot("site1", "/pricing", "desktop");
    const mobile = layoutPathSlot("site1", "/pricing", "mobile");
    const tablet = layoutPathSlot("site1", "/pricing", "tablet");
    expect(new Set([desktop, mobile, tablet]).size).toBe(3);
  });
});

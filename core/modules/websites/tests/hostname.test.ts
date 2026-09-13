import { describe, it, expect } from "bun:test";
import { normalizeHostname } from "../../../modules/websites/lib/hostname";

describe("normalizeHostname", () => {
  it("accepts a bare hostname", () => {
    expect(normalizeHostname("example.com")).toBe("example.com");
  });

  it("strips a scheme", () => {
    expect(normalizeHostname("https://example.com")).toBe("example.com");
    expect(normalizeHostname("http://example.com")).toBe("example.com");
  });

  it("strips path, query and hash", () => {
    expect(normalizeHostname("https://example.com/pricing?ref=x#top")).toBe("example.com");
  });

  it("strips a port", () => {
    expect(normalizeHostname("http://example.com:8080")).toBe("example.com");
  });

  it("lowercases the host", () => {
    expect(normalizeHostname("EXAMPLE.COM")).toBe("example.com");
    expect(normalizeHostname("https://Example.Com/Path")).toBe("example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHostname("  example.com  ")).toBe("example.com");
  });

  // The apex and www must collapse to one identity, or the same visitor counts
  // as two sites depending on which host they landed on.
  it("strips a leading www.", () => {
    expect(normalizeHostname("www.example.com")).toBe("example.com");
    expect(normalizeHostname("https://www.example.com/x")).toBe("example.com");
  });

  it("keeps www inside a longer label", () => {
    expect(normalizeHostname("wwwx.example.com")).toBe("wwwx.example.com");
  });

  it("keeps a non-leading www label", () => {
    expect(normalizeHostname("api.www.example.com")).toBe("api.www.example.com");
  });

  it("preserves subdomains", () => {
    expect(normalizeHostname("app.staging.example.com")).toBe("app.staging.example.com");
  });

  // An uppercase scheme is a valid URL; prepending https:// to it would produce
  // "https://HTTPS://..." and throw on input the user reasonably typed.
  it("handles an uppercase scheme", () => {
    expect(normalizeHostname("HTTPS://Example.com")).toBe("example.com");
  });

  it("rejects an unparseable address", () => {
    expect(() => normalizeHostname("http://")).toThrow("invalid website URL format");
  });

  it("rejects an empty string", () => {
    expect(() => normalizeHostname("")).toThrow("invalid website URL format");
  });

  it("rejects whitespace only", () => {
    expect(() => normalizeHostname("   ")).toThrow("invalid website URL format");
  });
});

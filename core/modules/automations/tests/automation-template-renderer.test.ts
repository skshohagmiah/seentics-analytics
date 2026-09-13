import { describe, it, expect } from "bun:test";
import { renderTemplate, renderTemplateDeep } from "../lib/automation-template-renderer";

// ─── renderTemplate ────────────────────────────────────────────────────────────

describe("renderTemplate – basic interpolation", () => {
  it("replaces a simple token", () => {
    expect(renderTemplate("Hello {{name}}!", { name: "Alice" })).toBe("Hello Alice!");
  });

  it("replaces multiple tokens", () => {
    expect(renderTemplate("{{first}} {{last}}", { first: "John", last: "Doe" })).toBe("John Doe");
  });

  it("leaves template unchanged when no placeholders", () => {
    expect(renderTemplate("no placeholders", {})).toBe("no placeholders");
  });

  it("renders missing path as empty string", () => {
    expect(renderTemplate("Hello {{missing}}!", {})).toBe("Hello !");
  });

  it("handles dot-notation paths", () => {
    expect(renderTemplate("{{user.name}}", { user: { name: "Bob" } })).toBe("Bob");
  });

  it("handles deeply nested path", () => {
    expect(renderTemplate("{{a.b.c}}", { a: { b: { c: "deep" } } })).toBe("deep");
  });

  it("renders missing nested path as empty string", () => {
    expect(renderTemplate("{{a.b.c}}", { a: {} })).toBe("");
  });

  it("renders null value as empty string", () => {
    expect(renderTemplate("{{v}}", { v: null })).toBe("");
  });

  it("renders number values as string", () => {
    expect(renderTemplate("Count: {{n}}", { n: 42 })).toBe("Count: 42");
  });
});

// ─── Filters ──────────────────────────────────────────────────────────────────

describe("filter: uppercase", () => {
  it("converts to uppercase", () => {
    expect(renderTemplate("{{name | uppercase}}", { name: "hello" })).toBe("HELLO");
  });
});

describe("filter: lowercase", () => {
  it("converts to lowercase", () => {
    expect(renderTemplate("{{name | lowercase}}", { name: "HELLO" })).toBe("hello");
  });
});

describe("filter: capitalize", () => {
  it("capitalizes each word", () => {
    expect(renderTemplate("{{name | capitalize}}", { name: "hello world" })).toBe("Hello World");
  });
});

describe("filter: default", () => {
  it("uses default when value is null/undefined", () => {
    expect(renderTemplate("{{v | default:guest}}", {})).toBe("guest");
  });

  it("uses default when value is empty string", () => {
    expect(renderTemplate("{{v | default:fallback}}", { v: "" })).toBe("fallback");
  });

  it("keeps original value when set", () => {
    expect(renderTemplate("{{v | default:fallback}}", { v: "real" })).toBe("real");
  });
});

describe("filter: ordinal", () => {
  it("1 → 1st", () => {
    expect(renderTemplate("{{n | ordinal}}", { n: 1 })).toBe("1st");
  });

  it("2 → 2nd", () => {
    expect(renderTemplate("{{n | ordinal}}", { n: 2 })).toBe("2nd");
  });

  it("3 → 3rd", () => {
    expect(renderTemplate("{{n | ordinal}}", { n: 3 })).toBe("3rd");
  });

  it("4 → 4th", () => {
    expect(renderTemplate("{{n | ordinal}}", { n: 4 })).toBe("4th");
  });

  it("11 → 11th (teen exception)", () => {
    expect(renderTemplate("{{n | ordinal}}", { n: 11 })).toBe("11th");
  });

  it("21 → 21st", () => {
    expect(renderTemplate("{{n | ordinal}}", { n: 21 })).toBe("21st");
  });

  it("non-number → original string", () => {
    expect(renderTemplate("{{v | ordinal}}", { v: "abc" })).toBe("abc");
  });
});

describe("filter: currency", () => {
  it("formats number as USD by default", () => {
    expect(renderTemplate("{{price | currency}}", { price: 9.99 })).toBe("$9.99");
  });

  it("formats with explicit currency code", () => {
    const result = renderTemplate("{{price | currency:EUR}}", { price: 10 });
    expect(result).toContain("10");
    expect(result).toMatch(/EUR|€/);
  });

  it("non-number → original string", () => {
    expect(renderTemplate("{{v | currency}}", { v: "abc" })).toBe("abc");
  });
});

describe("filter: seconds", () => {
  it("< 60s → Xs format", () => {
    expect(renderTemplate("{{t | seconds}}", { t: 45 })).toBe("45s");
  });

  it("exactly 60s → 1m format", () => {
    expect(renderTemplate("{{t | seconds}}", { t: 60 })).toBe("1m");
  });

  it("90s → 1m 30s", () => {
    expect(renderTemplate("{{t | seconds}}", { t: 90 })).toBe("1m 30s");
  });

  it("120s → 2m", () => {
    expect(renderTemplate("{{t | seconds}}", { t: 120 })).toBe("2m");
  });

  it("non-number → original string", () => {
    expect(renderTemplate("{{v | seconds}}", { v: "abc" })).toBe("abc");
  });
});

describe("filter: minutes", () => {
  it("90s → 1m", () => {
    expect(renderTemplate("{{t | minutes}}", { t: 90 })).toBe("1m");
  });

  it("45s → 0m", () => {
    expect(renderTemplate("{{t | minutes}}", { t: 45 })).toBe("0m");
  });

  it("non-number → original string", () => {
    expect(renderTemplate("{{v | minutes}}", { v: "abc" })).toBe("abc");
  });
});

describe("filter: date", () => {
  it("formats a valid date string", () => {
    const result = renderTemplate("{{d | date}}", { d: "2024-01-15" });
    expect(result).toMatch(/1\/15\/2024|January 15, 2024/);
  });

  it("passes dateStyle argument", () => {
    const result = renderTemplate("{{d | date:long}}", { d: "2024-01-15" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("invalid date → returns original string", () => {
    expect(renderTemplate("{{d | date}}", { d: "not-a-date" })).toBe("not-a-date");
  });
});

// ─── Chained filters ──────────────────────────────────────────────────────────

describe("chained filters", () => {
  it("applies filters left-to-right", () => {
    expect(renderTemplate("{{name | uppercase | default:ANON}}", { name: "alice" })).toBe("ALICE");
  });

  it("default after missing → fallback", () => {
    expect(renderTemplate("{{name | uppercase | default:ANON}}", {})).toBe("ANON");
  });
});

// ─── renderTemplateDeep ────────────────────────────────────────────────────────

describe("renderTemplateDeep", () => {
  it("renders a string value", () => {
    expect(renderTemplateDeep("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("renders strings inside an array", () => {
    const result = renderTemplateDeep(["{{a}}", "{{b}}"], { a: "x", b: "y" });
    expect(result).toEqual(["x", "y"]);
  });

  it("renders strings in nested object values", () => {
    const result = renderTemplateDeep({ msg: "Hi {{name}}", code: 42 }, { name: "Alice" });
    expect(result).toEqual({ msg: "Hi Alice", code: 42 });
  });

  it("recursively renders deeply nested structures", () => {
    const obj = { outer: { inner: "{{v}}" } };
    const result = renderTemplateDeep(obj, { v: "deep" });
    expect(result).toEqual({ outer: { inner: "deep" } });
  });

  it("passes through non-string primitives unchanged", () => {
    expect(renderTemplateDeep(42, {})).toBe(42);
    expect(renderTemplateDeep(true, {})).toBe(true);
    expect(renderTemplateDeep(null, {})).toBe(null);
  });

  it("renders strings inside arrays inside objects", () => {
    const obj = { items: ["{{a}}", "{{b}}"] };
    const result = renderTemplateDeep(obj, { a: "1", b: "2" });
    expect(result).toEqual({ items: ["1", "2"] });
  });
});

import { describe, expect, it } from "bun:test";
import {
  evaluateConditions,
  OPERATORS,
  UNARY_OPERATORS,
  type ConditionGroup,
  type Operator,
} from "../lib/automation-condition-evaluator";

/**
 * The condition engine.
 *
 * Two invariants run through every case below, because this decides who sees what and it
 * runs unauthenticated on the tracker edge:
 *
 *  - **Fail closed.** Anything the evaluator cannot judge answers `false`.
 *  - **Compare predictably.** Rule values come from a text input and are always strings;
 *    facts are whatever JSON carried. Coercion is explicit, so `5` matches `"5"` while
 *    the classic `==` surprises (`0 == ''`, `'' == false`) do not.
 */

/** One rule, evaluated against a single-fact context. */
function evalOne(operator: string, fact: unknown, value?: unknown): boolean {
  return evaluateConditions(
    { operator: "AND", rules: [{ fact: "x", operator: operator as Operator, value }] },
    { x: fact },
  );
}

const rule = (fact: string, value: unknown) => ({ fact, operator: "equals" as const, value });

// -- No conditions -----------------------------------------------------------

describe("absent conditions", () => {
  it("passes for null and undefined - an automation with no conditions fires for all", () => {
    expect(evaluateConditions(null, {})).toBe(true);
    expect(evaluateConditions(undefined, {})).toBe(true);
  });

  it("passes for a group with no rules - it constrains nothing", () => {
    for (const operator of ["AND", "OR", "NOT"] as const) {
      expect(evaluateConditions({ operator, rules: [] }, {})).toBe(true);
    }
  });

  it("passes when rules is not an array at all", () => {
    expect(evaluateConditions({ operator: "AND", rules: null } as never, {})).toBe(true);
  });
});

// -- Group operators ---------------------------------------------------------

describe("group operators", () => {
  const ctx = { a: 1, b: 2, c: 3 };

  it("AND requires every branch", () => {
    expect(evaluateConditions({ operator: "AND", rules: [rule("a", 1), rule("b", 2)] }, ctx)).toBe(true);
    expect(evaluateConditions({ operator: "AND", rules: [rule("a", 1), rule("b", 9)] }, ctx)).toBe(false);
  });

  it("OR requires one branch", () => {
    expect(evaluateConditions({ operator: "OR", rules: [rule("a", 9), rule("b", 2)] }, ctx)).toBe(true);
    expect(evaluateConditions({ operator: "OR", rules: [rule("a", 9), rule("b", 9)] }, ctx)).toBe(false);
  });

  it("NOT inverts its first branch", () => {
    expect(evaluateConditions({ operator: "NOT", rules: [rule("a", 9)] }, ctx)).toBe(true);
    expect(evaluateConditions({ operator: "NOT", rules: [rule("a", 1)] }, ctx)).toBe(false);
  });

  it("NOT ignores branches past the first rather than implicitly AND-ing them", () => {
    // "not (a and b)" and "not a" are different claims, and the builder only ever
    // produces the single-branch form. Silently AND-ing would answer a question nobody
    // asked.
    expect(evaluateConditions({ operator: "NOT", rules: [rule("a", 9), rule("b", 2)] }, ctx)).toBe(true);
  });

  it("rejects a group whose operator is not one of the three", () => {
    expect(evaluateConditions({ operator: "XOR", rules: [rule("a", 1)] } as never, ctx)).toBe(false);
  });

  it("nests groups to arbitrary depth", () => {
    const tree: ConditionGroup = {
      operator: "AND",
      rules: [
        rule("a", 1),
        { operator: "OR", rules: [rule("b", 99), { operator: "NOT", rules: [rule("c", 99)] }] },
      ],
    };
    expect(evaluateConditions(tree, ctx)).toBe(true);
  });

  it("propagates a failure from the innermost branch outward", () => {
    const tree: ConditionGroup = {
      operator: "AND",
      rules: [
        rule("a", 1),
        { operator: "OR", rules: [rule("b", 99), { operator: "NOT", rules: [rule("c", 3)] }] },
      ],
    };
    expect(evaluateConditions(tree, ctx)).toBe(false);
  });

  it("mixes bare rules and nested groups in one rules array", () => {
    expect(
      evaluateConditions(
        { operator: "AND", rules: [rule("a", 1), { operator: "OR", rules: [rule("b", 2)] }] },
        ctx,
      ),
    ).toBe(true);
  });

  it("evaluates a five-level tree without stack trouble", () => {
    let tree: ConditionGroup = { operator: "AND", rules: [rule("a", 1)] };
    for (let i = 0; i < 4; i++) tree = { operator: "AND", rules: [tree] };
    expect(evaluateConditions(tree, ctx)).toBe(true);
  });
});

// -- Fact resolution ---------------------------------------------------------

describe("fact resolution", () => {
  it("reads a dotted path into nested context", () => {
    expect(
      evaluateConditions(
        { operator: "AND", rules: [{ fact: "user.plan", operator: "equals", value: "pro" }] },
        { user: { plan: "pro" } },
      ),
    ).toBe(true);
  });

  it("reads several levels deep", () => {
    expect(
      evaluateConditions(
        { operator: "AND", rules: [{ fact: "a.b.c.d", operator: "equals", value: "deep" }] },
        { a: { b: { c: { d: "deep" } } } },
      ),
    ).toBe(true);
  });

  it("treats a path that does not exist as unset rather than throwing", () => {
    expect(evalOne("isNotSet", undefined)).toBe(true);
    expect(
      evaluateConditions(
        { operator: "AND", rules: [{ fact: "nope.nothing.here", operator: "isNotSet" }] },
        {},
      ),
    ).toBe(true);
  });

  it("stops rather than throwing when a path segment is a primitive", () => {
    expect(
      evaluateConditions(
        { operator: "AND", rules: [{ fact: "a.b.c", operator: "isSet" }] },
        { a: { b: "a string" } },
      ),
    ).toBe(false);
  });

  it("rejects a rule with a missing or empty fact", () => {
    // Fail closed: a rule with no fact names nothing, so it cannot be satisfied.
    expect(evaluateConditions({ operator: "AND", rules: [{ operator: "isSet" } as never] }, {})).toBe(false);
    expect(
      evaluateConditions({ operator: "AND", rules: [{ fact: "", operator: "isSet" } as never] }, {}),
    ).toBe(false);
  });
});

// -- Operators ---------------------------------------------------------------

describe("equals / notEquals", () => {
  it("matches identical values of the same type", () => {
    expect(evalOne("equals", "a", "a")).toBe(true);
    expect(evalOne("equals", 5, 5)).toBe(true);
    expect(evalOne("equals", true, true)).toBe(true);
  });

  it("matches a number fact against the string the builder produced", () => {
    // The rule value comes from a text input, so this crossing is the normal case.
    expect(evalOne("equals", 5, "5")).toBe(true);
    expect(evalOne("equals", true, "true")).toBe(true);
  });

  it("does not match different values of the same type", () => {
    expect(evalOne("equals", "a", "b")).toBe(false);
    expect(evalOne("equals", 5, 6)).toBe(false);
  });

  it("does not fall for the classic loose-equality surprises", () => {
    // `0 == ''` and `'' == false` are both true in JavaScript and both wrong here: a
    // visitor with zero page views is not a visitor whose plan is blank.
    expect(evalOne("equals", 0, "")).toBe(false);
    expect(evalOne("equals", "", false)).toBe(false);
  });

  it("treats an unset fact as equal to nothing, including another unset value", () => {
    expect(evalOne("equals", null, null)).toBe(false);
    expect(evalOne("equals", undefined, undefined)).toBe(false);
    expect(evalOne("equals", null, "")).toBe(false);
  });

  it("notEquals is the exact inverse", () => {
    expect(evalOne("notEquals", "a", "b")).toBe(true);
    expect(evalOne("notEquals", 5, "5")).toBe(false);
    expect(evalOne("notEquals", null, null)).toBe(true);
  });
});

describe("numeric comparison", () => {
  const cases: Array<[string, unknown, unknown, boolean]> = [
    ["greaterThan", 5, 3, true],
    ["greaterThan", 3, 5, false],
    ["greaterThan", 5, 5, false],
    ["lessThan", 3, 5, true],
    ["lessThan", 5, 3, false],
    ["greaterThanOrEqual", 5, 5, true],
    ["greaterThanOrEqual", 4, 5, false],
    ["lessThanOrEqual", 5, 5, true],
    ["lessThanOrEqual", 6, 5, false],
  ];

  for (const [op, fact, value, expected] of cases) {
    it(`${op}(${JSON.stringify(fact)}, ${JSON.stringify(value)}) is ${expected}`, () => {
      expect(evalOne(op, fact, value)).toBe(expected);
    });
  }

  it("compares a numeric string against a number", () => {
    expect(evalOne("greaterThan", "10", 5)).toBe(true);
    expect(evalOne("lessThan", 5, "10")).toBe(true);
  });

  it("fails rather than comparing when either side is not numeric", () => {
    // Number('abc') is NaN and every NaN comparison is false, but stating it means a
    // later refactor cannot accidentally make "abc" > 5 true.
    for (const op of ["greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"]) {
      expect(evalOne(op, "abc", 5)).toBe(false);
      expect(evalOne(op, 5, "abc")).toBe(false);
      expect(evalOne(op, null, 5)).toBe(false);
      expect(evalOne(op, undefined, 5)).toBe(false);
    }
  });

  it("compares negative and fractional values", () => {
    expect(evalOne("greaterThan", -1, -5)).toBe(true);
    expect(evalOne("lessThan", 1.5, 1.6)).toBe(true);
  });
});

describe("string matching", () => {
  it("contains is case-insensitive", () => {
    expect(evalOne("contains", "Hello World", "WORLD")).toBe(true);
    expect(evalOne("contains", "hello", "zzz")).toBe(false);
  });

  it("startsWith and endsWith are case-insensitive too", () => {
    // Consistent with `contains`: the whole family behaves the same way, so a user does
    // not have to remember which member cares about case.
    expect(evalOne("startsWith", "/Pricing", "/pri")).toBe(true);
    expect(evalOne("endsWith", "/PRICING", "ing")).toBe(true);
    expect(evalOne("startsWith", "/pricing", "/x")).toBe(false);
    expect(evalOne("endsWith", "/pricing", "xyz")).toBe(false);
  });

  it("matches a number fact as its string form", () => {
    expect(evalOne("contains", 12345, "234")).toBe(true);
  });

  it("fails every positive matcher for an unset fact", () => {
    for (const op of ["contains", "startsWith", "endsWith", "matches"]) {
      expect(evalOne(op, null, "x")).toBe(false);
      expect(evalOne(op, undefined, "x")).toBe(false);
    }
  });

  it("notContains is satisfied by an unset fact - it contains nothing", () => {
    expect(evalOne("notContains", null, "x")).toBe(true);
    expect(evalOne("notContains", "hello", "zzz")).toBe(true);
    expect(evalOne("notContains", "hello world", "world")).toBe(false);
  });
});

describe("matches (regex)", () => {
  it("applies the pattern to the fact", () => {
    expect(evalOne("matches", "abc123", "^abc")).toBe(true);
    expect(evalOne("matches", "abc123", "^zzz")).toBe(false);
    expect(evalOne("matches", "/blog/2026/post", "^/blog/\\d{4}/")).toBe(true);
  });

  it("refuses a pattern with nested quantifiers", () => {
    // Catastrophic backtracking on the request path is a denial-of-service primitive,
    // and the pattern comes from a definition.
    expect(evalOne("matches", "a".repeat(30) + "X", "(a+)+$")).toBe(false);
    expect(evalOne("matches", "aaa", "(a*)*b")).toBe(false);
  });

  it("refuses a pattern longer than 200 characters", () => {
    expect(evalOne("matches", "a", "a".repeat(201))).toBe(false);
    expect(evalOne("matches", "a".repeat(200), "a".repeat(200))).toBe(true);
  });

  it("fails rather than throwing on a syntactically invalid pattern", () => {
    expect(evalOne("matches", "abc", "[")).toBe(false);
    expect(evalOne("matches", "abc", "(")).toBe(false);
  });
});

describe("presence and truthiness", () => {
  it("isSet accepts any non-empty value", () => {
    expect(evalOne("isSet", "value")).toBe(true);
    expect(evalOne("isSet", 0)).toBe(true);
    expect(evalOne("isSet", false)).toBe(true);
  });

  it("isSet rejects null, undefined and the empty string", () => {
    expect(evalOne("isSet", null)).toBe(false);
    expect(evalOne("isSet", undefined)).toBe(false);
    expect(evalOne("isSet", "")).toBe(false);
  });

  it("isNotSet is the exact inverse of isSet", () => {
    for (const fact of ["value", 0, false, null, undefined, ""]) {
      expect(evalOne("isNotSet", fact)).toBe(!evalOne("isSet", fact));
    }
  });

  it("isTrue accepts the boolean, the number and both string spellings", () => {
    // A definition's value arrives as a string, and a fact may be a JSON boolean or a
    // flag stored as 1 - all four spellings mean the same thing to a user.
    for (const fact of [true, 1, "true", "1"]) expect(evalOne("isTrue", fact)).toBe(true);
    for (const fact of [false, 0, "false", "0", "yes", null]) expect(evalOne("isTrue", fact)).toBe(false);
  });

  it("isFalse accepts the corresponding falsy spellings", () => {
    for (const fact of [false, 0, "false", "0"]) expect(evalOne("isFalse", fact)).toBe(true);
    for (const fact of [true, 1, "true", "1", "no", null]) expect(evalOne("isFalse", fact)).toBe(false);
  });
});

describe("membership", () => {
  it("in matches any member of the list", () => {
    expect(evalOne("in", "b", ["a", "b"])).toBe(true);
    expect(evalOne("in", "z", ["a", "b"])).toBe(false);
  });

  it("in coerces across the string boundary like equals does", () => {
    expect(evalOne("in", 2, ["1", "2"])).toBe(true);
    expect(evalOne("in", "2", [1, 2])).toBe(true);
  });

  it("notIn is the inverse for a well-formed list", () => {
    expect(evalOne("notIn", "z", ["a", "b"])).toBe(true);
    expect(evalOne("notIn", "b", ["a", "b"])).toBe(false);
  });

  it("fails both directions when the expected value is not a list", () => {
    // A malformed membership rule cannot be judged either way, so both fail closed
    // rather than `notIn` passing for everyone.
    expect(evalOne("in", "a", "not-a-list")).toBe(false);
    expect(evalOne("notIn", "a", "not-a-list")).toBe(false);
    expect(evalOne("notIn", "a", undefined)).toBe(false);
  });

  it("fails against an empty list for `in` and passes for `notIn`", () => {
    expect(evalOne("in", "a", [])).toBe(false);
    expect(evalOne("notIn", "a", [])).toBe(true);
  });
});

// -- Fail-closed -------------------------------------------------------------

describe("unknown operators", () => {
  it("rejects an operator no branch claims", () => {
    // The whole reason this file's contract is "fail closed": a typo in a definition
    // must not become a site-wide broadcast.
    expect(evalOne("nonsenseOperator", "a", "b")).toBe(false);
    expect(evalOne("", "a", "b")).toBe(false);
  });

  it("is case-sensitive about operator names", () => {
    expect(evalOne("EQUALS", "a", "a")).toBe(false);
    expect(evalOne("Contains", "abc", "b")).toBe(false);
  });

  it("rejects a rule with no operator at all", () => {
    expect(
      evaluateConditions({ operator: "AND", rules: [{ fact: "x", value: "a" } as never] }, { x: "a" }),
    ).toBe(false);
  });

  it("fails the whole AND group when one rule is unjudgeable", () => {
    expect(
      evaluateConditions(
        {
          operator: "AND",
          rules: [rule("x", "a"), { fact: "x", operator: "bogus" as Operator, value: "a" }],
        },
        { x: "a" },
      ),
    ).toBe(false);
  });
});

// -- The exported palette ----------------------------------------------------

describe("operator palette", () => {
  it("lists the unary operators as a subset of the full palette", () => {
    for (const op of UNARY_OPERATORS) expect(OPERATORS).toContain(op);
  });

  it("has no duplicate entries", () => {
    expect(new Set(OPERATORS).size).toBe(OPERATORS.length);
  });

  it("is non-empty, so the builder always has something to render", () => {
    expect(OPERATORS.length).toBeGreaterThan(0);
  });
});

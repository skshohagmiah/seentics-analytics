/**
 * Automation condition evaluation.
 *
 * A condition is a boolean tree over the facts an evaluate request carries — the
 * visitor's profile, the page context, the trigger's own payload. Groups nest to any
 * depth under AND / OR / NOT, and the leaves are `{ fact, operator, value }` rules.
 *
 * Two rules govern every branch below, because this runs unauthenticated on the tracker
 * edge and decides who sees what:
 *
 *  - **Fail closed.** Anything the evaluator cannot confidently judge — an unknown
 *    operator, a malformed rule, a regex it will not run — answers `false`. Answering
 *    `true` would turn one typo into a site-wide broadcast.
 *  - **Compare predictably.** Rule values arrive from a text input, so they are always
 *    strings, while facts are whatever JSON carried. Coercion is therefore explicit and
 *    uniform rather than left to `==`, whose surprises (`0 == ''`, `'' == false`) are
 *    exactly the wrong answers here.
 */

export type Operator =
  | 'equals' | 'notEquals'
  | 'greaterThan' | 'lessThan' | 'greaterThanOrEqual' | 'lessThanOrEqual'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'matches'
  | 'isSet' | 'isNotSet' | 'isTrue' | 'isFalse'
  | 'in' | 'notIn';

/** Every operator, as data — the builder renders its dropdown from this. */
export const OPERATORS: readonly Operator[] = [
  'equals', 'notEquals',
  'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual',
  'contains', 'notContains', 'startsWith', 'endsWith', 'matches',
  'isSet', 'isNotSet', 'isTrue', 'isFalse',
  'in', 'notIn',
] as const;

/** Operators that take no right-hand value; the builder disables the value input. */
export const UNARY_OPERATORS: readonly Operator[] = ['isSet', 'isNotSet', 'isTrue', 'isFalse'] as const;

export type Rule = {
  /** Dot path into the evaluation context, e.g. `user.plan` or `trigger.depth`. */
  fact: string;
  operator: Operator;
  value?: unknown;
};

export type ConditionGroup = {
  operator: 'AND' | 'OR' | 'NOT';
  rules: Array<Rule | ConditionGroup>;
};

/**
 * Reject a regex that could backtrack catastrophically.
 *
 * The pattern comes from a definition and runs on the request path, so a nested
 * quantifier is a denial-of-service primitive rather than a stylistic problem.
 */
function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (/(\*|\+|\{[0-9,]+\})(\*|\+|\{[0-9,]+\})/.test(pattern)) return false;
  if (/\([^)]*(\*|\+)\)[*+]/.test(pattern)) return false;
  return true;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Equality across the type boundary a text input creates.
 *
 * Same type: strict. Different types: compared as strings, so `5` matches `"5"` and
 * `true` matches `"true"`. Nullish never equals anything, including another nullish —
 * "no value" is not a value two facts can agree on.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  // Nullish first, ahead of the identity check: two unset values are not "equal", they
  // are both absent. Answering true would let a rule whose value field was left empty
  // match every visitor missing that fact. `isNotSet` is how you ask that question.
  if (a == null || b == null) return false;
  if (a === b) return true;
  if (typeof a === typeof b) return false;
  return String(a) === String(b);
}

/**
 * A value as a finite number, or `null` when it is not one.
 *
 * Deliberately narrower than `Number()`, which answers `0` for `null`, `''`, `false`
 * and `[]`. Every one of those would make an unset fact compare as zero — so a visitor
 * with no recorded page views would satisfy "pageViews <= 5" and get targeted by a
 * campaign meant for light users.
 */
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Both sides as finite numbers, or `null` when either is not numeric. */
function asNumbers(a: unknown, b: unknown): [number, number] | null {
  const x = asNumber(a);
  const y = asNumber(b);
  return x === null || y === null ? null : [x, y];
}

/** Case-insensitive across the whole string-matching family, for consistency. */
function asText(v: unknown): string | null {
  return v == null ? null : String(v).toLowerCase();
}

function applyOperator(value: unknown, op: Operator, expected: unknown): boolean {
  switch (op) {
    case 'equals':
      return valuesEqual(value, expected);
    case 'notEquals':
      return !valuesEqual(value, expected);

    case 'greaterThan': {
      const n = asNumbers(value, expected);
      return n !== null && n[0] > n[1];
    }
    case 'lessThan': {
      const n = asNumbers(value, expected);
      return n !== null && n[0] < n[1];
    }
    case 'greaterThanOrEqual': {
      const n = asNumbers(value, expected);
      return n !== null && n[0] >= n[1];
    }
    case 'lessThanOrEqual': {
      const n = asNumbers(value, expected);
      return n !== null && n[0] <= n[1];
    }

    case 'contains': {
      const [v, e] = [asText(value), asText(expected)];
      return v !== null && e !== null && v.includes(e);
    }
    case 'notContains': {
      const [v, e] = [asText(value), asText(expected)];
      // A fact that is not set contains nothing, so it satisfies "does not contain".
      return v === null || e === null || !v.includes(e);
    }
    case 'startsWith': {
      const [v, e] = [asText(value), asText(expected)];
      return v !== null && e !== null && v.startsWith(e);
    }
    case 'endsWith': {
      const [v, e] = [asText(value), asText(expected)];
      return v !== null && e !== null && v.endsWith(e);
    }
    case 'matches': {
      if (value == null) return false;
      const pattern = String(expected ?? '');
      if (!isSafeRegexPattern(pattern)) return false;
      try {
        return new RegExp(pattern).test(String(value));
      } catch {
        return false;
      }
    }

    case 'isSet':
      return value != null && value !== '';
    case 'isNotSet':
      return value == null || value === '';
    case 'isTrue':
      return value === true || value === 1 || value === 'true' || value === '1';
    case 'isFalse':
      return value === false || value === 0 || value === 'false' || value === '0';

    case 'in':
      return Array.isArray(expected) && expected.some((e) => valuesEqual(value, e));
    case 'notIn':
      // A malformed `notIn` cannot be judged, so it fails like any other unknown.
      return Array.isArray(expected) && !expected.some((e) => valuesEqual(value, e));

    default:
      // Fail closed. This branch is only reached for an operator no case above claims —
      // a typo, or a builder shipping a dropdown entry ahead of its server support.
      // Returning `true` would mean such a rule passed for everyone.
      return false;
  }
}

function isRule(node: unknown): node is Rule {
  return typeof node === 'object' && node !== null && 'fact' in node;
}

function isGroup(node: unknown): node is ConditionGroup {
  return (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as ConditionGroup).rules)
  );
}

function evalRule(rule: Rule, context: Record<string, unknown>): boolean {
  if (typeof rule.fact !== 'string' || rule.fact === '') return false;
  return applyOperator(getNestedValue(context, rule.fact), rule.operator, rule.value);
}

/**
 * Evaluate a condition tree.
 *
 * `null` means "no condition", which passes — an automation with no conditions fires for
 * everyone by design. An *empty group* passes for the same reason: it constrains nothing.
 */
export function evaluateConditions(
  conditions: ConditionGroup | null | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!conditions) return true;

  const { operator, rules } = conditions;
  if (!Array.isArray(rules) || rules.length === 0) return true;

  // A branch is a rule or a group, and nothing else. A node that is neither — a
  // half-written entry with no `fact` and no `rules` — used to fall through to the
  // empty-group path and pass, which is the fail-open shape this file exists to avoid.
  const evaluate = (node: Rule | ConditionGroup): boolean => {
    if (isRule(node)) return evalRule(node, context);
    if (isGroup(node)) return evaluateConditions(node, context);
    return false;
  };

  switch (operator) {
    case 'NOT':
      // NOT negates its first branch; further entries are ignored rather than implicitly
      // AND-ed, because "not (a and b)" and "not a" are different claims and the builder
      // only ever produces the single-branch form.
      return !evaluate(rules[0]!);
    case 'OR':
      return rules.some(evaluate);
    case 'AND':
      return rules.every(evaluate);
    default:
      return false;
  }
}

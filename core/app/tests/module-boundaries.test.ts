import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The architectural rule, as a test.
 *
 * A module may import from another module's `interfaces/` and nothing else. Not its
 * services, not its repositories, not its routes, not its engines. Every cross-module
 * dependency is therefore an interface declared by one side and implemented by the
 * other, and the only other thing that crosses a module boundary at runtime is the
 * event bus.
 *
 * Worth enforcing mechanically because the violations it catches are the kind that
 * look harmless in review — one convenient import of a batch-insert function, one
 * `getSomeEngine()` call — and each one silently makes the importing module
 * untestable in isolation. That is exactly how the four that used to exist got in.
 *
 * A cycle between two modules' implementations would also be a compile error only by
 * luck; this makes it a test failure with a name attached.
 */

const CORE = resolve(import.meta.dir, "..", "..");
const MODULES = join(CORE, "modules");

/** Source files, excluding tests — a test may reach for whatever it needs to stub. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "tests" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every relative `from "…"` specifier in a file, resolved to a core-relative path. */
function relativeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    specs.push(relative(CORE, resolve(dirname(file), m[1]!)));
  }
  return specs;
}

const moduleNames = readdirSync(MODULES).filter((n) => statSync(join(MODULES, n)).isDirectory());

describe("module boundaries", () => {
  it("has modules to check", () => {
    expect(moduleNames.length).toBeGreaterThan(5);
  });

  for (const owner of moduleNames) {
    it(`${owner} imports only interfaces from its peers`, () => {
      const violations: string[] = [];

      for (const file of sourceFiles(join(MODULES, owner))) {
        for (const target of relativeImports(file)) {
          const parts = target.split("/");
          if (parts[0] !== "modules") continue;

          const peer = parts[1];
          if (peer === owner) continue;

          // `modules/<peer>/interfaces` and anything under it is the public surface.
          if (parts[2]?.startsWith("interfaces")) continue;

          violations.push(`${relative(CORE, file)} -> ${target}`);
        }
      }

      expect(violations).toEqual([]);
    });
  }

  it("keeps the composition root on init functions and interfaces", () => {
    const violations: string[] = [];

    for (const file of [...sourceFiles(join(CORE, "app")), join(CORE, "index.ts")]) {
      for (const target of relativeImports(file)) {
        const parts = target.split("/");
        if (parts[0] !== "modules") continue;

        if (parts[2]?.startsWith("interfaces")) continue;
        if (parts.length === 3 && parts[2] === "init") continue;

        violations.push(`${relative(CORE, file)} -> ${target}`);
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * The blind spot this test used to have.
   *
   * Everything above asks whether a *module* reaches somewhere it should not. Nothing
   * asked the reverse, so `platform/` — which sits *below* the modules and must not know
   * they exist — could import a module's services or repositories freely, and a module's
   * own domain types could drift outward into `platform/lib` where any module could pick
   * them up without going through the owning module's interfaces. Four had.
   */
  it("keeps platform below the modules", () => {
    const violations: string[] = [];

    for (const file of sourceFiles(join(CORE, "platform"))) {
      for (const target of relativeImports(file)) {
        const parts = target.split("/");
        if (parts[0] !== "modules") continue;

        // `interfaces/` is allowed, and is how the HTTP composition files in
        // `platform/http` name the ports the composition root injects into them. What is
        // not allowed is what modules may not do either: reaching a peer's services,
        // repositories, routes or engines.
        if (parts[2]?.startsWith("interfaces")) continue;

        violations.push(`${relative(CORE, file)} -> ${target}`);
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * A type in `platform/lib/types.ts` must be shared by more than one place.
   *
   * A single-consumer type there is that module's own shape sitting in a file everyone
   * imports — `HeatmapPointRow`, `PageSummaryRow`, `ScreenshotJob` and `SessionMetaRow`
   * all were, and `ReplayChunk` had no consumer at all. None of them tripped any rule,
   * because `platform/` is not a module and importing from it is legal from anywhere.
   */
  it("keeps single-module types out of platform/lib/types.ts", () => {
    /**
     * Moves blocked on concurrent work in `heatmap-ingest.service.ts`, which is where
     * both are consumed. They belong in `modules/heatmaps/interfaces`; this list exists
     * so the rule can be enforced now rather than deferred with it.
     */
    const PENDING_MOVE = new Set(["HeatmapPointRow", "ScreenshotJob"]);

    const shared = readFileSync(join(CORE, "platform", "lib", "types.ts"), "utf8");
    const names = [...shared.matchAll(/^export type (\w+)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);

    const zones = new Map<string, Set<string>>();
    for (const dir of ["modules", "platform", "app"]) {
      for (const file of sourceFiles(join(CORE, dir))) {
        const rel = relative(CORE, file);
        if (rel === join("platform", "lib", "types.ts")) continue;
        const src = readFileSync(file, "utf8");
        const zone = rel.startsWith("modules") ? rel.split("/")[1]! : dir;
        for (const name of names) {
          if (new RegExp(`\\b${name}\\b`).test(src)) {
            (zones.get(name) ?? zones.set(name, new Set()).get(name)!).add(zone);
          }
        }
      }
    }

    const misplaced = names
      .filter((n) => !PENDING_MOVE.has(n))
      .filter((n) => (zones.get(n)?.size ?? 0) < 2)
      .map((n) => `${n} (used by ${[...(zones.get(n) ?? [])].join(", ") || "nothing"})`);

    expect(misplaced).toEqual([]);
  });
});

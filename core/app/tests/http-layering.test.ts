import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const moduleNames = [
  "ai",
  "analytics",
  "auth",
  "automations",
  "funnels",
  "heatmaps",
  "ingest",
  "recordings",
  "websites",
] as const;

describe("HTTP module layering", () => {
  for (const moduleName of moduleNames) {
    it(`${moduleName} keeps route registration in routes.ts`, async () => {
      const source = await readFile(join("modules", moduleName, "routes.ts"), "utf8");
      expect(source).toMatch(/(?:routes|publicRoutes|authRoutes)\.(get|post|put|patch|delete)\(/);
      expect(source).not.toMatch(/validation|validators|repositories/);
      expect(source).not.toMatch(/export\s*\{[^}]*Controller[^}]*Routes/);
      expect(source).not.toMatch(/create\w+Controller\(deps\)/);
    });

    it(`${moduleName} has domain-split controllers without routers`, async () => {
      const directory = join("modules", moduleName, "controllers");
      const files = (await readdir(directory)).filter((file) => file.endsWith(".controller.ts"));
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const file of files) {
        const source = await readFile(join(directory, file), "utf8");
        expect(source).not.toContain("new Hono");
        expect(source).not.toMatch(/\b(routes|publicRoutes|authRoutes|r)\.(get|post|put|patch|delete)\(/);
        expect(source).not.toMatch(/from ["'][^"']*(repositories|\/db)["']/);
        expect(source).not.toMatch(/from ["'][^"']*\/services\//);
      }
    });

    it(`${moduleName} has domain-split services`, async () => {
      const files = (await readdir(join("modules", moduleName, "services")))
        .filter((file) => file.endsWith(".ts"));
      expect(files.length).toBeGreaterThanOrEqual(2);
      expect(files.every((file) => file.endsWith(".service.ts"))).toBe(true);
      for (const file of files) {
        const source = await readFile(join("modules", moduleName, "services", file), "utf8");
        expect(source).not.toMatch(/from ["'][^"']*\/controllers\//);
        expect(source).not.toMatch(/from ["'][^"']*(hono|middleware|validators?)[^"']*["']/);
      }
    });

    it(`${moduleName} keeps public interfaces independent of implementations`, async () => {
      const directory = join("modules", moduleName, "interfaces");
      const files = (await readdir(directory)).filter((file) => file.endsWith(".ts"));
      for (const file of files) {
        const source = await readFile(join(directory, file), "utf8");
        expect(source).not.toMatch(/from ["'][^"']*\/(services|controllers|repositories)\//);
      }
    });
  }
});

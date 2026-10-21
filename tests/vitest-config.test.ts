// @vitest-environment node
import { describe, expect, it } from "vitest";

import config from "../vite.config";

describe("vitest config", () => {
  it("runs only the suites under tests/ and never stray worktrees", () => {
    expect(config.test?.include).toEqual(["tests/**/*.test.{ts,tsx}"]);
    expect(config.test?.exclude).toContain(".worktrees/**");
    expect(config.test?.exclude).toContain("**/node_modules/**");
  });

  it("boots Vite without HMR or a dependency scan under test", () => {
    expect(config.server).toMatchObject({ hmr: false, ws: false });
    expect(config.optimizeDeps).toMatchObject({ noDiscovery: true });
  });

  it("pre-bundles nothing under test, even what plugin-react asks for", async () => {
    const { resolveConfig } = await import("vite");
    const resolved = await resolveConfig({}, "serve");
    expect(resolved.optimizeDeps.include ?? []).toEqual([]);
    expect(resolved.optimizeDeps.noDiscovery).toBe(true);
  });
});

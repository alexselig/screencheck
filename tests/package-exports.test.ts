// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// scripts/build.mjs emits declarations with tsc, which keeps the src/ layout
// under dist/types (rootDir is src/ because full-page.ts imports src/shared).
function sourceForDeclaration(typesPath: string) {
  const relative = path.relative("dist/types", typesPath);
  return path.join(ROOT, "src", relative.replace(/\.d\.ts$/, ".ts"));
}

describe("package exports", () => {
  it("points every types condition at a declaration the build writes", () => {
    const entries = Object.entries(pkg.exports).filter(
      ([, target]) => typeof target === "object",
    ) as [string, { types?: string }][];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, target] of entries) {
      if (!target.types) continue;
      expect(target.types.startsWith("./dist/types/")).toBe(true);
      expect(existsSync(sourceForDeclaration(target.types))).toBe(true);
    }
  });

  it("types screencheck/capture from the capture module", () => {
    expect(pkg.exports["./capture"].types).toBe(
      "./dist/types/capture/full-page.d.ts",
    );
  });
});

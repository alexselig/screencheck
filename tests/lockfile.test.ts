// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const lock = JSON.parse(
  readFileSync(path.resolve(__dirname, "..", "package-lock.json"), "utf8"),
) as { packages: Record<string, { resolved?: string; link?: boolean }> };

// Contributors and CI run `npm ci` against the public registry; a lockfile
// generated behind a private mirror points them at a host they can't reach.
describe("package-lock.json", () => {
  it("resolves every package from the public npm registry", () => {
    const resolved = Object.values(lock.packages)
      .map((entry) => entry.resolved)
      .filter((url): url is string => Boolean(url));
    expect(resolved.length).toBeGreaterThan(0);
    const elsewhere = resolved.filter(
      (url) => !url.startsWith("https://registry.npmjs.org/"),
    );
    expect(elsewhere).toEqual([]);
  });
});

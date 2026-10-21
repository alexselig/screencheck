// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

describe("release metadata", () => {
  it("keeps package-lock.json on the package.json version", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("has a CHANGELOG entry for the package.json version", () => {
    expect(existsSync("CHANGELOG.md")).toBe(true);
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(
      (m) => m[1],
    );
    expect(headings).toContain(pkg.version);
    expect(headings[0] === "Unreleased" ? headings[1] : headings[0]).toBe(
      pkg.version,
    );
    expect(changelog).toMatch(
      new RegExp(`^\\[${pkg.version.replace(/\./g, "\\.")}\\]: https://`, "m"),
    );
  });

  it("is past the first npm release", () => {
    expect(pkg.version).not.toBe("0.1.0");
  });
});

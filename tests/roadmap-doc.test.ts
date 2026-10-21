// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const roadmap = readFileSync("ROADMAP.md", "utf8");
const server = readFileSync("src/mcp/server.ts", "utf8");

describe("ROADMAP.md", () => {
  it("names only MCP tools the server registers", () => {
    const registered = new Set(
      [...server.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
    );
    const row = roadmap.split("\n").find((line) => line.startsWith("| 1 "));
    expect(row).toBeDefined();
    const named = [...row!.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("describes tag-driven releases and the shipped rail", () => {
    expect(roadmap).not.toMatch(/provenance on `v\*` tags/);
    expect(roadmap).toMatch(/tag-driven/);
    expect(roadmap).toMatch(/Resolution\*\* filter/);
    expect(roadmap).toMatch(/_Partly shipped:_/);
  });

  it("keeps `screencheck capture` for one URL and ranks config capture first", () => {
    const next = roadmap.slice(
      roadmap.indexOf("### Next"),
      roadmap.indexOf("### Later"),
    );
    const order = [...next.matchAll(/^\| (\d+a?) +\|/gm)].map((m) => m[1]);
    expect(order).toEqual(["6", "6a", "8", "10", "7", "9"]);
    expect(next).toMatch(/`screencheck capture --config`/);
  });
});

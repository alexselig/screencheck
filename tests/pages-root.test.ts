// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DOCS = path.resolve(__dirname, "..", "docs");
const SITE_FILES = new Set(["CNAME", "index.html", "PLAYGROUND.md"]);

// docs/ is the GitHub Pages root: everything in it is public at screencheck.dev.
describe("docs/ (Pages root)", () => {
  it("holds only the site, its images and the playground guide", () => {
    const stray = readdirSync(DOCS, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
      .map((entry) =>
        path.relative(DOCS, path.join(entry.parentPath, entry.name)),
      )
      .map((file) => file.split(path.sep).join("/"))
      .filter(
        (file) =>
          !SITE_FILES.has(file) &&
          !/^assets\/[^/]+\.(png|jpe?g|svg|webp|gif|ico)$/.test(file),
      );
    expect(stray).toEqual([]);
  });
});

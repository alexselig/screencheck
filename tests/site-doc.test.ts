import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(path.resolve(__dirname, "..", file), "utf8");
const README = read("README.md");
const SITE = new DOMParser().parseFromString(
  read("docs/index.html"),
  "text/html",
);

function readmeKeyboardRows() {
  const lines = README.slice(README.indexOf("### Keyboard")).split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, -1).split("|").map(clean));
  }
  return rows;
}

function clean(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

describe("site and README stay in step", () => {
  it("shows the README keyboard table on the site", () => {
    const site = [...SITE.querySelectorAll("table.keys tbody tr")].map((row) =>
      [...row.children].map((cell) => clean(cell.textContent)),
    );
    expect(site).toEqual(readmeKeyboardRows());
    expect(site.length).toBeGreaterThan(4);
  });

  it("documents the health check the server answers", () => {
    expect(read("src/server/index.ts")).toContain('"/healthz"');
    expect(README).toContain("`GET /healthz`");
  });

  it("gives link unfurlers an absolute image and a card", () => {
    const meta = (selector: string) =>
      SITE.querySelector(`meta[${selector}]`)?.getAttribute("content");
    expect(meta('property="og:image"')).toBe(
      "https://screencheck.dev/assets/hero.png",
    );
    expect(meta('property="og:url"')).toBe("https://screencheck.dev/");
    expect(meta('name="twitter:card"')).toBe("summary_large_image");
  });
});

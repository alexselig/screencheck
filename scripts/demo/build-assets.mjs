// Rebuilds the assets bundled for `screencheck demo`: the Tidewater captures
// (with element maps) for both builds and the seed scenario.
//
//   node scripts/demo/build-assets.mjs
//
// The output in demo/ is committed and shipped in the npm package, so the
// demo runs without Playwright or a clone.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { captureFullPage } from "../../src/capture/full-page.ts";
import { APPROVED, SEED, VERSIONS } from "../playground/scenario.mjs";
import { SCREENS } from "../site/demo-app.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const OUT = path.join(ROOT, "demo");

await rm(OUT, { recursive: true, force: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  for (const [version, screens] of Object.entries(VERSIONS)) {
    await mkdir(path.join(OUT, "captures", version), { recursive: true });
    for (const screen of screens) {
      await page.setContent(screen.html);
      await captureFullPage(page, {
        path: path.join(OUT, "captures", version, `${screen.id}.png`),
        elements: true,
      });
    }
  }
} finally {
  await browser.close();
}

const scenario = {
  project: {
    id: "tidewater",
    name: "Tidewater",
    versions: Object.keys(VERSIONS),
    screens: SCREENS.map((screen, index) => ({
      id: screen.id,
      ordinal: index + 1,
      title: screen.title,
      group: screen.group,
      description: screen.description,
      capturePath: `${screen.id}.png`,
      viewport: { width: 1440, height: 1000 },
    })),
  },
  seed: SEED,
  approved: APPROVED,
};
await writeFile(
  path.join(OUT, "scenario.json"),
  `${JSON.stringify(scenario, null, 2)}\n`,
);
console.log(`Wrote ${path.relative(ROOT, OUT)}/`);

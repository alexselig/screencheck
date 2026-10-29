// Performance budget for screen index thumbnails and the rail resizer
// (.github/plans/2026-10-29-rail-thumbnails-design.md). Builds a 120-screen
// project with tall captures, serves it with the built client and measures
// with the Chrome DevTools Protocol.
//
//   npm run build && node scripts/perf/rail-thumbnails.mjs [--keep]
//
// Exits 1 when any budget fails. Its home is .local/perf-rail-thumbnails
// (gitignored); --keep leaves it there afterwards.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { captureFullPage } from "../../src/capture/full-page.ts";
import { captureThumbnails } from "../../src/capture/thumbnail.ts";
import { SCREENS } from "../site/demo-app.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const HOME = path.join(ROOT, ".local", "perf-rail-thumbnails");
const PROJECT = "perf";
const COUNT = 120;
const PORT = Number(process.env.PERF_PORT ?? 4398);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const keep = process.argv.includes("--keep");

const BUDGET = {
  cachedFirstMs: 150,
  workerFirstMs: 600,
  longTaskMs: 50,
  layoutShift: 0,
  frameMs: 16,
  frameIntervalMs: 18,
  dragCommits: 0,
  memoryMb: 20,
  alignPx: 1,
};

// Taller than the viewport, so captures are full pages and thumbnails a crop.
const TALL_CSS = `body { min-height: 3600px; }`;

const screenIds = Array.from(
  { length: COUNT },
  (_, index) => `screen-${String(index + 1).padStart(3, "0")}`,
);

function sourceKey(info) {
  return `${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}`;
}

// Captures the nine demo screens once, then fills 120 screens from them. The
// "cached" version has capture-time thumbnails; "fresh" has none, so the
// worker has to make them.
async function buildProject() {
  await rm(HOME, { recursive: true, force: true });
  const shots = path.join(HOME, "shots");
  await mkdir(shots, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const thumbs = [];
  for (const screen of SCREENS) {
    await page.setContent(screen.html);
    await page.addStyleTag({ content: TALL_CSS });
    await captureFullPage(page, { path: path.join(shots, `${screen.id}.png`) });
    thumbs.push(await captureThumbnails(page));
  }
  await browser.close();

  const thumbsRoot = path.join(HOME, "thumbs", PROJECT, "cached");
  await mkdir(thumbsRoot, { recursive: true });
  for (const version of ["cached", "fresh"]) {
    const dir = path.join(HOME, "captures", version);
    await mkdir(dir, { recursive: true });
    for (const [index, id] of screenIds.entries()) {
      const from = SCREENS[index % SCREENS.length];
      const file = path.join(dir, `${id}.png`);
      await copyFile(path.join(shots, `${from.id}.png`), file);
      const images = thumbs[index % SCREENS.length];
      if (version !== "cached" || !images) continue;
      const source = sourceKey(await stat(file));
      for (const [width, bytes] of Object.entries(images)) {
        const type = bytes[0] === 0x52 && bytes[8] === 0x57 ? "webp" : "png";
        await writeFile(path.join(thumbsRoot, `${id}-${width}.${type}`), bytes);
        await writeFile(
          path.join(thumbsRoot, `${id}-${width}.json`),
          `${JSON.stringify({ source, type })}\n`,
        );
      }
    }
  }
  await mkdir(path.join(HOME, "projects"), { recursive: true });
  await writeFile(
    path.join(HOME, "projects", `${PROJECT}.json`),
    JSON.stringify({
      id: PROJECT,
      name: "Perf",
      versions: ["fresh", "cached"].map((id) => ({
        id,
        captureRoot: path.join(HOME, "captures", id),
      })),
      screens: screenIds.map((id, index) => ({
        id,
        ordinal: index + 1,
        title: `${SCREENS[index % SCREENS.length].title} ${index + 1}`,
        group: `Group ${Math.floor(index / 10) + 1}`,
        capturePath: `${id}.png`,
        viewport: { width: 1440, height: 900 },
      })),
    }),
  );
}

function startServer() {
  const cli = path.join(ROOT, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("Run `npm run build` first.");
  const child = spawn(
    process.execPath,
    [cli, "serve", "--port", String(PORT)],
    {
      cwd: ROOT,
      env: { ...process.env, SCREENCHECK_HOME: HOME, SCREENCHECK_RECORD: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(String(PORT))) resolve(child);
    });
  });
}

// Counts React commits through the devtools hook React looks for at start,
// and collects long tasks and layout shifts.
const INIT = `
  window.__commits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() { return 1; },
    onCommitFiberRoot() { window.__commits += 1; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  window.__shift = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__shift += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
`;

async function openReview(context, version, show) {
  const page = await context.newPage();
  await page.addInitScript(INIT);
  await page.addInitScript(
    `localStorage.setItem("screencheck:show-thumbnails", "${show ? 1 : 0}");
     localStorage.removeItem("screencheck:rail-width");`,
  );
  await page.goto(
    `${ORIGIN}/#project=${PROJECT}&version=${version}&screen=${screenIds[0]}`,
  );
  await page.waitForFunction(() => {
    const image = document.querySelector("img.screen-capture");
    return image?.complete && image.naturalWidth > 0;
  });
  await page.waitForTimeout(500);
  return page;
}

// Clicks Show thumbnails and times until every thumbnail in view has drawn.
// The click comes from the page, so CDP latency isn't counted.
async function timeToggle(page) {
  await page.evaluate(() => {
    window.__longTasks = [];
    window.__toggleAt = 0;
    window.__firstAt = 0;
    const rail = document.querySelector(".rail-column .screen-rail");
    rail.scrollTop = 0;
    const toggle = [...rail.querySelectorAll('[role="switch"]')].find(
      (item) => item.textContent === "Show thumbnails",
    );
    const check = () => {
      const box = rail.getBoundingClientRect();
      const bottom = Math.min(box.bottom, innerHeight);
      const visible = [...rail.querySelectorAll(".screen-thumb")].filter(
        (thumb) => {
          const r = thumb.getBoundingClientRect();
          return r.bottom > box.top && r.top < bottom;
        },
      );
      const drawn = visible.filter((thumb) => {
        const image = thumb.querySelector("img");
        return image?.complete && image.naturalWidth > 0;
      });
      if (visible.length && drawn.length === visible.length) {
        window.__firstAt = performance.now();
        return;
      }
      requestAnimationFrame(check);
    };
    window.__toggleAt = performance.now();
    toggle.click();
    requestAnimationFrame(check);
  });
  await page.waitForFunction(() => window.__firstAt > 0, null, {
    timeout: 15_000,
  });
  return page.evaluate(() => ({
    ms: window.__firstAt - window.__toggleAt,
    longest: Math.max(0, ...window.__longTasks),
  }));
}

async function scrollIndex(page) {
  await page.evaluate(async () => {
    window.__longTasks = [];
    window.__shift = 0;
    const rail = document.querySelector(".rail-column .screen-rail");
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    rail.scrollTop = 0;
    while (rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1) {
      rail.scrollTop += 120;
      await frame();
    }
    await new Promise((done) => setTimeout(done, 1500));
  });
  return page.evaluate(() => ({
    longest: Math.max(0, ...window.__longTasks),
    shift: window.__shift,
    loaded: [...document.querySelectorAll(".screen-thumb img")].filter(
      (image) => image.complete && image.naturalWidth > 0,
    ).length,
  }));
}

// Drags the handle from 220 to 640px. A frame's main-thread work is the time
// from its start to the end of a forced layout queued after the resizer's own
// frame callback (which writes --rail-width).
async function dragRail(page) {
  const handle = page.getByRole("separator", { name: "Resize screen index" });
  await handle.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(300);
  // The handle runs the column's full height; its grip stays in view.
  const box = await page.locator(".rail-resizer-grip").boundingBox();
  const y = box.y + box.height / 2;
  const startX = box.x + box.width / 2;
  await page.mouse.move(startX, y);
  // Headless Chromium spends 20-40ms repainting a tall, scrolled rail on the
  // first press after idle (a plain row click costs the same, thumbnails or
  // not). One warm-up press keeps that one-off out of the drag's frames.
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.evaluate(() => {
    window.__commits = 0;
    window.__longTasks = [];
    window.__frames = [];
    window.__deltas = [];
    window.__measuring = true;
    let last = 0;
    let moved = false;
    // Frames count from the first move, not from this script's own task.
    addEventListener("pointermove", () => (moved = true), { once: true });
    const grid = document.querySelector(".workbench-grid");
    const measure = (start) => {
      if (!window.__measuring) return;
      if (!moved) {
        requestAnimationFrame(measure);
        return;
      }
      if (last) window.__deltas.push(start - last);
      last = start;
      requestAnimationFrame(measure);
      // After every frame callback, including the resizer's.
      setTimeout(() => {
        grid.getBoundingClientRect();
        window.__frames.push(performance.now() - start);
      }, 0);
    };
    requestAnimationFrame(measure);
  });
  const steps = 60;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(startX + (420 * step) / steps, y);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done())),
    );
  }
  const during = await page.evaluate(() => {
    window.__measuring = false;
    return {
      commits: window.__commits,
      frames: window.__frames,
      deltas: window.__deltas,
      longest: Math.max(0, ...window.__longTasks),
      width: document.querySelector(".rail-column").getBoundingClientRect()
        .width,
    };
  });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    commits: window.__commits,
    stored: localStorage.getItem("screencheck:rail-width"),
  }));
  return { ...during, committedAfter: after.commits, stored: after.stored };
}

async function memory(page, client) {
  await client.send("HeapProfiler.collectGarbage");
  await page.waitForTimeout(200);
  await client.send("HeapProfiler.collectGarbage");
  const { metrics } = await client.send("Performance.getMetrics");
  const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize").value;
  // Decoded thumbnails that can be on screen: rows outside the rail's view
  // are skipped by content-visibility, so their images needn't stay decoded.
  const decoded = await page.evaluate(() => {
    const rail = document.querySelector(".rail-column .screen-rail");
    const box = rail.getBoundingClientRect();
    let bytes = 0;
    for (const image of rail.querySelectorAll(".screen-thumb img")) {
      const r = image.getBoundingClientRect();
      if (r.bottom < box.top || r.top > box.bottom) continue;
      bytes += image.naturalWidth * image.naturalHeight * 4;
    }
    return bytes;
  });
  return { heap, decoded };
}

// With a short list, the settings sit on the rail's visible bottom edge.
async function bottomAlignment(context) {
  const page = await context.newPage();
  await page.addInitScript(
    `localStorage.setItem("screencheck:show-thumbnails", "0");`,
  );
  await page.goto(`${ORIGIN}/#project=${PROJECT}&version=cached`);
  await page.locator(".rail-column .rail-settings").waitFor();
  // Three rows left: a short list.
  await page.evaluate(() => {
    const rail = document.querySelector(".rail-column .screen-rail");
    for (const [index, row] of [...rail.querySelectorAll("li")].entries()) {
      if (index > 2) row.remove();
    }
  });
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const rail = document.querySelector(".rail-column .screen-rail");
    const bar = document.querySelector(".action-bar");
    return {
      settings: rail.querySelector(".rail-settings").getBoundingClientRect()
        .bottom,
      rail: Math.min(
        rail.getBoundingClientRect().bottom,
        bar?.getBoundingClientRect().top ?? innerHeight,
      ),
    };
  });
  await page.close();
  return result;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}
const round = (value) => Math.round(value * 10) / 10;

async function main() {
  console.log(`Building a ${COUNT}-screen project…`);
  await buildProject();
  const server = await startServer();
  const browser = await chromium.launch();
  const failures = [];
  const check = (name, value, limit, unit = "ms") => {
    const ok = value <= limit;
    if (!ok) failures.push(name);
    console.log(
      `${ok ? "pass" : "FAIL"}  ${name}: ${round(value)}${unit} (budget ≤ ${limit}${unit})`,
    );
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    // The memory baseline: thumbnails off, whole index scrolled.
    const off = await openReview(context, "cached", false);
    const offClient = await context.newCDPSession(off);
    await offClient.send("Performance.enable");
    await scrollIndex(off);
    const baseline = await memory(off, offClient);
    await off.close();

    const cached = await openReview(context, "cached", false);
    const client = await context.newCDPSession(cached);
    await client.send("Performance.enable");
    const toggle = await timeToggle(cached);
    check(
      "toggle on, cached: first visible thumbnails",
      toggle.ms,
      BUDGET.cachedFirstMs,
    );
    check("toggle on, cached: longest task", toggle.longest, BUDGET.longTaskMs);
    const scroll = await scrollIndex(cached);
    check("scroll 120 rows: longest task", scroll.longest, BUDGET.longTaskMs);
    check(
      "scroll 120 rows: layout shift",
      scroll.shift,
      BUDGET.layoutShift,
      "",
    );
    console.log(
      `      ${scroll.loaded}/${COUNT} thumbnails loaded after scrolling`,
    );
    const used = await memory(cached, client);
    const extra = (used.heap - baseline.heap + used.decoded) / 1048576;
    console.log(
      `      JS heap ${round(baseline.heap / 1048576)} → ${round(used.heap / 1048576)} MB; decoded thumbnails in view ${round(used.decoded / 1048576)} MB`,
    );
    check(
      "memory over the thumbnails-off baseline",
      extra,
      BUDGET.memoryMb,
      " MB",
    );

    const drag = await dragRail(cached);
    console.log(
      `      dragged to ${round(drag.width)}px over ${drag.frames.length} frames; frame interval p50 ${round(percentile(drag.deltas, 50))}ms, p95 ${round(percentile(drag.deltas, 95))}ms`,
    );
    check(
      "drag 220→640: slowest frame's main-thread work",
      Math.max(0, ...drag.frames),
      BUDGET.frameMs,
    );
    check(
      "drag 220→640: p95 frame work",
      percentile(drag.frames, 95),
      BUDGET.frameMs,
    );
    // 60 Hz: an interval much past 16.7ms is a dropped frame.
    check(
      "drag 220→640: longest frame interval",
      Math.max(0, ...drag.deltas),
      BUDGET.frameIntervalMs,
    );
    check("drag 220→640: longest task", drag.longest, BUDGET.longTaskMs);
    check(
      "drag 220→640: React commits while dragging",
      drag.commits,
      BUDGET.dragCommits,
      "",
    );
    if (
      drag.committedAfter < 1 ||
      drag.stored !== String(Math.round(drag.width))
    ) {
      failures.push("commit on release");
      console.log(
        `FAIL  width not committed on release (stored ${drag.stored})`,
      );
    } else {
      console.log(`pass  committed once on release (stored ${drag.stored}px)`);
    }
    await cached.close();

    // The worker path: nothing cached for "fresh".
    const freshThumbs = path.join(HOME, "thumbs", PROJECT, "fresh");
    await rm(freshThumbs, { recursive: true, force: true });
    const fresh = await openReview(context, "fresh", false);
    const made = await timeToggle(fresh);
    check(
      "toggle on, worker: first visible thumbnails",
      made.ms,
      BUDGET.workerFirstMs,
    );
    check("toggle on, worker: longest task", made.longest, BUDGET.longTaskMs);
    await fresh.waitForTimeout(1500);
    const uploaded = existsSync(freshThumbs);
    if (!uploaded) failures.push("worker upload");
    console.log(
      `${uploaded ? "pass" : "FAIL"}  worker thumbnails uploaded to the cache`,
    );
    await fresh.close();

    const align = await bottomAlignment(context);
    check(
      "short list: settings bottom to rail bottom",
      Math.abs(align.settings - align.rail),
      BUDGET.alignPx,
      "px",
    );
  } finally {
    await browser.close();
    server.kill();
    if (!keep) await rm(HOME, { recursive: true, force: true });
  }
  if (failures.length) {
    console.log(`\n${failures.length} budget(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll budgets pass.");
}

await main();

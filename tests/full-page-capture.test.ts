// @vitest-environment node
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureFullPage } from "../src/capture/full-page";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

const VIEWPORT = { width: 400, height: 300 };
const LONG_PAGE = 1200;
const ORANGE = [242, 101, 34];

function page(body: string, css = "") {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #fff; }
    main { height: ${LONG_PAGE}px; }
    .bar { height: 40px; background: rgb(${ORANGE.join(",")}); }
    ${css}
  </style></head><body>${body}</body></html>`;
}

async function open(html: string) {
  const tab = await browser.newPage({ viewport: VIEWPORT });
  await tab.setContent(html);
  return tab;
}

// Reads pixel colours out of a PNG by drawing it into a canvas.
async function pixels(image: Uint8Array, points: [number, number][]) {
  const tab = await browser.newPage();
  try {
    return await tab.evaluate(
      async ({ data, points }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        return {
          height: img.height,
          colours: points.map(([x, y]) => [
            ...context.getImageData(x, y, 1, 1).data.slice(0, 3),
          ]),
        };
      },
      { data: Buffer.from(image).toString("base64"), points },
    );
  } finally {
    await tab.close();
  }
}

const isOrange = (colour: number[]) =>
  colour.every((value, index) => Math.abs(value - ORANGE[index]!) < 8);

// The first screenful ends at y=300; the document ends at y=1200.
const MID_PAGE: [number, number] = [200, VIEWPORT.height - 10];
const PAGE_END: [number, number] = [200, LONG_PAGE - 10];

async function check(tab: Page) {
  const plain = await pixels(await tab.screenshot({ fullPage: true }), [
    MID_PAGE,
    PAGE_END,
  ]);
  const fixed = await captureFullPage(tab);
  const pinned = await pixels(fixed.image, [MID_PAGE, PAGE_END]);
  return { plain, pinned, report: fixed.pinned };
}

describe("captureFullPage", () => {
  it("moves a fixed footer from mid-page to the bottom of a long page", async () => {
    const tab = await open(
      page(
        `<main></main><footer class="bar" style="opacity: 1"></footer>`,
        "footer { position: fixed; left: 0; right: 0; bottom: 0; }",
      ),
    );
    const { plain, pinned, report } = await check(tab);

    // The bug: Playwright paints it where the first screenful ends.
    expect(plain.height).toBe(LONG_PAGE);
    expect(isOrange(plain.colours[0]!)).toBe(true);
    expect(isOrange(plain.colours[1]!)).toBe(false);

    expect(report).toEqual(["footer.bar"]);
    expect(pinned.height).toBe(LONG_PAGE);
    expect(isOrange(pinned.colours[0]!)).toBe(false);
    expect(isOrange(pinned.colours[1]!)).toBe(true);

    // The page is left exactly as it was.
    expect(
      await tab.evaluate(() => ({
        style: document.querySelector("footer")!.getAttribute("style"),
        position: getComputedStyle(document.querySelector("footer")!).position,
      })),
    ).toEqual({ style: "opacity: 1", position: "fixed" });
    await tab.close();
  });

  it("returns a stuck sticky footer to the end of the flow", async () => {
    const tab = await open(
      page(
        `<main></main><footer class="bar"></footer>`,
        "footer { position: sticky; bottom: 0; }",
      ),
    );
    const { plain, pinned, report } = await check(tab);
    expect(report).toEqual(["footer.bar"]);
    expect(pinned.height).toBe(plain.height);
    expect(isOrange(pinned.colours[0]!)).toBe(false);
    // The flow puts the footer after the 1200px main.
    const end = await pixels((await captureFullPage(tab)).image, [
      [200, LONG_PAGE + 20],
    ]);
    expect(isOrange(end.colours[0]!)).toBe(true);
    expect(
      await tab.evaluate(() =>
        document.querySelector("footer")!.getAttribute("style"),
      ),
    ).toBeNull();
    await tab.close();
  });

  it("leaves headers, dialogs and short pages alone", async () => {
    const tab = await open(
      page(
        `<header class="bar"></header><main></main>
         <div class="backdrop"></div>`,
        `header { position: fixed; top: 0; left: 0; right: 0; }
         .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.2); }`,
      ),
    );
    expect((await captureFullPage(tab)).pinned).toEqual([]);
    await tab.close();

    const short = await open(
      page(
        `<p>Short</p><footer class="bar"></footer>`,
        "main { display: none; } footer { position: fixed; bottom: 0; left: 0; right: 0; }",
      ),
    );
    expect((await captureFullPage(short)).pinned).toEqual([]);
    await short.close();
  });

  it("keeps a bottom offset when the body is the containing block", async () => {
    const tab = await open(
      page(
        `<main></main><footer class="bar"></footer>`,
        "body { position: relative; margin-top: 30px; } main { height: 1170px; } footer { position: fixed; left: 0; right: 0; bottom: 20px; }",
      ),
    );
    const result = await captureFullPage(tab);
    const { colours } = await pixels(result.image, [
      [200, LONG_PAGE - 25],
      [200, LONG_PAGE - 10],
    ]);
    // 20px gap kept below the bar.
    expect(isOrange(colours[0]!)).toBe(true);
    expect(isOrange(colours[1]!)).toBe(false);
    await tab.close();
  });
});

describe("page functions compiled with keepNames", () => {
  // tsx/esbuild wrap named functions in __name(), which the page lacks;
  // this stand-in page calls __name the way that compiled code would.
  it("defines __name in the page before running its own functions", async () => {
    const tab = await open(page("<main></main>"));
    try {
      const compiled = {
        evaluate: <R>(fn: (() => R) | string) =>
          tab.evaluate(
            typeof fn === "string"
              ? fn
              : `(() => { const f = ${fn.toString()}; __name(f, "f"); return f(); })()`,
          ) as Promise<R>,
        screenshot: (options?: object) => tab.screenshot(options),
      };
      const result = await captureFullPage(compiled, { elements: false });
      expect(result.image.byteLength).toBeGreaterThan(0);
    } finally {
      await tab.close();
    }
  });
});

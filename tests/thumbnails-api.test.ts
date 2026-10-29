// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";
import {
  createThumbnailCache,
  defaultThumbsRoot,
  storeCaptureThumbnails,
} from "../src/server/thumbnails";
import { thumbnailType, thumbnailUrl } from "../src/shared/thumbnails";

let root: string;
let captures: string;
let server: Awaited<ReturnType<typeof startServer>>;

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-thumbs-"));
  captures = join(root, "captures", "v1");
  await mkdir(join(root, "projects"));
  await mkdir(captures, { recursive: true });
  await writeFile(join(captures, "home.png"), "capture one");
  await writeFile(
    join(root, "projects", "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: [
        {
          id: "home",
          ordinal: 1,
          title: "Home",
          group: "Main",
          capturePath: "home.png",
          viewport: { width: 1440, height: 1000 },
        },
        {
          id: "blank",
          ordinal: 2,
          title: "Blank",
          group: "Main",
          capturePath: "blank.png",
          viewport: { width: 1440, height: 1000 },
        },
      ],
    }),
  );
  server = await startServer({
    port: 0,
    dataRoot: join(root, "feedback"),
    projectsRoot: join(root, "projects"),
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const url = (screen = "home", w: number | string = 400, version = "v1") =>
  `${server.origin}/api/projects/demo/thumbnails/${version}/${screen}?w=${w}`;

const put = (
  body: Uint8Array,
  {
    screen = "home",
    w = 400 as number | string,
    origin = server.origin,
  }: { screen?: string; w?: number | string; origin?: string } = {},
) =>
  fetch(url(screen, w), {
    method: "PUT",
    headers: { origin, "content-type": "image/webp" },
    body: body as BodyInit,
  });

describe("thumbnail route", () => {
  it("answers 404 until a thumbnail exists, then serves it with an ETag", async () => {
    expect((await fetch(url())).status).toBe(404);
    expect((await put(WEBP)).status).toBe(204);
    const hit = await fetch(url());
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toBe("image/webp");
    expect(hit.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(WEBP);
    const etag = hit.headers.get("etag")!;
    expect(etag).toMatch(/^"/);
    const again = await fetch(url(), { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    // The other width is separate.
    expect((await fetch(url("home", 800))).status).toBe(404);
  });

  it("stores the cache beside the data folder, never in the captures", async () => {
    await put(PNG);
    expect(await readdir(captures)).toEqual(["home.png"]);
    expect(await readdir(join(root, "thumbs", "demo", "v1"))).toEqual(
      expect.arrayContaining(["home-400.png", "home-400.json"]),
    );
  });

  it("goes stale when the screen is re-captured", async () => {
    await put(WEBP);
    expect((await fetch(url())).status).toBe(200);
    await writeFile(join(captures, "home.png"), "capture two, longer");
    const later = new Date(Date.now() + 5000);
    await utimes(join(captures, "home.png"), later, later);
    expect((await fetch(url())).status).toBe(404);
  });

  it("refuses a PUT from another origin", async () => {
    const response = await put(WEBP, { origin: "http://evil.test" });
    expect(response.status).toBe(403);
  });

  it("refuses a body over 256 KB", async () => {
    const big = new Uint8Array(256 * 1024 + 1);
    big.set(WEBP);
    expect((await put(big)).status).toBe(413);
  });

  it("refuses a body that is not a WebP or PNG image", async () => {
    const response = await put(new TextEncoder().encode("<svg></svg>"));
    expect(response.status).toBe(415);
  });

  it("refuses an unknown screen, version or project", async () => {
    expect((await put(WEBP, { screen: "nope" })).status).toBe(404);
    expect(
      (
        await fetch(url("home", 400, "v9"), {
          method: "PUT",
          headers: { origin: server.origin },
          body: WEBP as BodyInit,
        })
      ).status,
    ).toBe(404);
    // Registered, but nothing captured to make a thumbnail of.
    expect((await put(WEBP, { screen: "blank" })).status).toBe(404);
  });

  it("refuses a width other than 400 or 800", async () => {
    expect((await put(WEBP, { w: 300 })).status).toBe(400);
    expect((await fetch(url("home", "x"))).status).toBe(400);
  });

  it("answers 405 for other methods", async () => {
    const response = await fetch(url(), {
      method: "DELETE",
      headers: { origin: server.origin },
    });
    expect(response.status).toBe(405);
  });
});

describe("thumbnail cache", () => {
  it("is keyed by the capture written just now", async () => {
    const cache = createThumbnailCache(join(root, "cache"));
    const ids = { projectId: "demo", version: "v1", screenId: "home" };
    await storeCaptureThumbnails(cache, ids, join(captures, "home.png"), {
      400: WEBP,
      800: PNG,
    });
    expect((await readdir(join(root, "cache", "demo", "v1"))).sort()).toEqual([
      "home-400.json",
      "home-400.webp",
      "home-800.json",
      "home-800.png",
    ]);
  });

  it("keeps odd version ids inside the cache folder", async () => {
    const cache = createThumbnailCache(join(root, "cache"));
    await cache.write(
      { projectId: "demo", version: "..", screenId: "a/b" },
      400,
      WEBP,
      "k",
    );
    expect(await readdir(join(root, "cache", "demo"))).toEqual(["%2e%2e"]);
  });

  it("defaults beside the data folder, or where SCREENCHECK_THUMBS says", () => {
    expect(defaultThumbsRoot({}, "/x/home/feedback")).toBe("/x/home/thumbs");
    expect(defaultThumbsRoot({ SCREENCHECK_HOME: "/h" })).toBe("/h/thumbs");
    expect(defaultThumbsRoot({ SCREENCHECK_THUMBS: "/t" }, "/x/f")).toBe("/t");
  });

  it("builds the route the client asks", () => {
    expect(thumbnailUrl("demo", "v 1", "home", 800)).toBe(
      "/api/projects/demo/thumbnails/v%201/home?w=800",
    );
  });

  it("recognises WebP and PNG by their first bytes", () => {
    expect(thumbnailType(WEBP)).toBe("webp");
    expect(thumbnailType(PNG)).toBe("png");
    expect(thumbnailType(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

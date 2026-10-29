// Loaded with import() only when a thumbnail is missing from the cache, so
// the toggle costs nothing until it is needed. Makes the thumbnail in a
// worker, two at a time, never while the screen under review is loading;
// then stores it in the server's cache (online) or keeps it for the session
// (offline viewer).
import {
  THUMBNAIL_WIDTHS,
  thumbnailUrl,
  type ThumbnailWidth,
} from "../shared/thumbnails";
import {
  thumbnailWorkerSource,
  type ThumbnailWorkerRequest,
  type ThumbnailWorkerResponse,
} from "./thumbnail-worker";

export const THUMBNAIL_CONCURRENCY = 2;

// The main canvas capture, while it is still loading.
function loadingCanvas(root: ParentNode = document) {
  const image = root.querySelector<HTMLImageElement>("img.screen-capture");
  return image && !image.complete ? image : null;
}

// Resolves once the screen under review has loaded (or after a few seconds,
// so a capture that never loads can't stall the queue for good).
export function canvasReady(root: ParentNode = document): Promise<void> {
  const image = loadingCanvas(root);
  if (!image) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      image.removeEventListener("load", done);
      image.removeEventListener("error", done);
      // Another capture may have started loading in the meantime.
      void canvasReady(root).then(resolve);
    };
    const timer = setTimeout(done, 4000);
    image.addEventListener("load", done);
    image.addEventListener("error", done);
  });
}

// A small job queue: deduplicated by key, at most `concurrency` running, and
// each job waits for `ready()` before it starts.
export function createThumbnailQueue({
  concurrency = THUMBNAIL_CONCURRENCY,
  ready = () => canvasReady(),
}: { concurrency?: number; ready?: () => Promise<void> } = {}) {
  const jobs = new Map<string, Promise<unknown>>();
  const pending: (() => void)[] = [];
  let active = 0;
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (pending.length && active < concurrency) {
        await ready();
        if (active >= concurrency) break;
        const start = pending.shift();
        if (!start) break;
        active += 1;
        start();
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const known = jobs.get(key);
    if (known) return known as Promise<T>;
    const job = new Promise<T>((resolve, reject) => {
      pending.push(() => {
        run()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            void pump();
          });
      });
    });
    jobs.set(key, job);
    // A failed job may be tried again later.
    job.catch(() => jobs.delete(key));
    void pump();
    return job;
  }

  return {
    enqueue,
    get active() {
      return active;
    },
    get pending() {
      return pending.length;
    },
  };
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (response: ThumbnailWorkerResponse) => void>();

function thumbnailWorker() {
  if (worker) return worker;
  const url = URL.createObjectURL(
    new Blob([thumbnailWorkerSource()], { type: "text/javascript" }),
  );
  worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = (event: MessageEvent<ThumbnailWorkerResponse>) => {
    waiting.get(event.data.id)?.(event.data);
    waiting.delete(event.data.id);
  };
  return worker;
}

function makeInWorker(request: Omit<ThumbnailWorkerRequest, "id">) {
  const id = nextId++;
  return new Promise<{ width: number; blob: Blob }[]>((resolve, reject) => {
    waiting.set(id, (response) =>
      "error" in response
        ? reject(new Error(response.error))
        : resolve(response.images),
    );
    thumbnailWorker().postMessage({ ...request, id });
  });
}

export type ThumbnailTarget = {
  projectId: string;
  version: string;
  screenId: string;
  // Where the full capture is (the API route, or a file in a bundle).
  captureSrc: string;
  aspect: { width: number; height: number };
  // Offline: nowhere to store it, so it lives in memory for the session.
  offline: boolean;
};

export type ThumbnailSources = Partial<Record<400 | 800, string>>;

const queue = createThumbnailQueue();
const made = new Map<string, ThumbnailSources>();

async function store(
  target: ThumbnailTarget,
  width: ThumbnailWidth,
  blob: Blob,
) {
  try {
    await fetch(
      thumbnailUrl(target.projectId, target.version, target.screenId, width),
      { method: "PUT", body: blob, headers: { "content-type": blob.type } },
    );
  } catch {
    // The thumbnail still shows; the next visit makes it again.
  }
}

// Object URLs for a screen's thumbnails, made once per session.
export function makeThumbnail(
  target: ThumbnailTarget,
): Promise<ThumbnailSources> {
  const key = `${target.projectId}\n${target.version}\n${target.screenId}`;
  const known = made.get(key);
  if (known) return Promise.resolve(known);
  return queue.enqueue(key, async () => {
    const images = await makeInWorker({
      url: new URL(target.captureSrc, location.href).href,
      aspect: target.aspect,
      widths: [...THUMBNAIL_WIDTHS],
    });
    const sources: ThumbnailSources = {};
    for (const { width, blob } of images) {
      if (width !== 400 && width !== 800) continue;
      sources[width] = URL.createObjectURL(blob);
      if (!target.offline) void store(target, width, blob);
    }
    made.set(key, sources);
    return sources;
  });
}

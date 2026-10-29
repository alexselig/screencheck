// The fallback thumbnail maker, run in a Web Worker so a tall capture is
// never decoded on the main thread. It fetches the capture, decodes it with
// createImageBitmap, crops the top viewport and resizes it on an
// OffscreenCanvas to each width, as WebP (PNG where the browser can't).
//
// The worker is started from a Blob URL made of this function's source, so
// the same code works in the server build and in the offline viewer's single
// script. It must stay self-contained: no imports, no outer names.

export type ThumbnailWorkerRequest = {
  id: number;
  url: string;
  // The screen's viewport; the crop keeps its width-to-height ratio.
  aspect: { width: number; height: number };
  widths: number[];
};

export type ThumbnailWorkerResponse =
  | { id: number; images: { width: number; blob: Blob }[] }
  | { id: number; error: string };

export function thumbnailWorkerMain(scope: {
  onmessage: ((event: MessageEvent<ThumbnailWorkerRequest>) => void) | null;
  postMessage(message: ThumbnailWorkerResponse): void;
}) {
  scope.onmessage = async (event) => {
    const { id, url, aspect, widths } = event.data;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const full = await createImageBitmap(await response.blob());
      const sourceWidth = full.width;
      const sourceHeight = Math.min(
        full.height,
        Math.max(1, Math.round((sourceWidth * aspect.height) / aspect.width)),
      );
      const images: { width: number; blob: Blob }[] = [];
      try {
        for (const width of widths) {
          const scaled = Math.min(width, sourceWidth);
          const height = Math.max(
            1,
            Math.round((sourceHeight * scaled) / sourceWidth),
          );
          const canvas = new OffscreenCanvas(scaled, height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("No 2D context");
          context.imageSmoothingQuality = "high";
          context.drawImage(
            full,
            0,
            0,
            sourceWidth,
            sourceHeight,
            0,
            0,
            scaled,
            height,
          );
          let blob = await canvas.convertToBlob({
            type: "image/webp",
            quality: 0.82,
          });
          if (blob.type !== "image/webp") {
            blob = await canvas.convertToBlob({ type: "image/png" });
          }
          images.push({ width, blob });
        }
      } finally {
        full.close();
      }
      scope.postMessage({ id, images });
    } catch (error) {
      scope.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

// The worker script: the function above, started on the worker's global.
export function thumbnailWorkerSource() {
  return `globalThis.__name = globalThis.__name || function (t) { return t; };
(${thumbnailWorkerMain.toString()})(self);`;
}

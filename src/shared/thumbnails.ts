// Small top-of-screen images for the screen index. Two widths, so the
// browser picks the smallest that is sharp at the rail's width and density.
export const THUMBNAIL_WIDTHS = [400, 800] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];

// Worker-made thumbnails are uploaded; a real one is 15–40 KB.
export const MAX_THUMBNAIL_BYTES = 256 * 1024;

export function isThumbnailWidth(value: unknown): value is ThumbnailWidth {
  return THUMBNAIL_WIDTHS.includes(value as ThumbnailWidth);
}

export function thumbnailUrl(
  projectId: string,
  version: string,
  screenId: string,
  width: ThumbnailWidth,
) {
  return `/api/projects/${encodeURIComponent(projectId)}/thumbnails/${encodeURIComponent(version)}/${encodeURIComponent(screenId)}?w=${width}`;
}

// "webp" or "png" from the first bytes, or null for anything else.
export function thumbnailType(bytes: Uint8Array): "webp" | "png" | null {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

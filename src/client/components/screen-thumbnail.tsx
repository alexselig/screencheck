import { useEffect, useRef, useState } from "react";

import { bundleThumbnailKey } from "../../shared/bundle";
import { thumbnailUrl } from "../../shared/thumbnails";
import { captureSrc, readBundle } from "../offline-api";

// One IntersectionObserver per scrolling rail, shared by all its rows. Rows
// start loading a little before they scroll into view.
const observers = new WeakMap<Element | Document, IntersectionObserver>();
const callbacks = new WeakMap<Element, () => void>();

function observe(element: Element, onVisible: () => void) {
  if (typeof IntersectionObserver !== "function") {
    onVisible();
    return () => {};
  }
  const root = element.closest(".screen-rail") ?? document;
  let observer = observers.get(root);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries, self) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          self.unobserve(entry.target);
          callbacks.get(entry.target)?.();
          callbacks.delete(entry.target);
        }
      },
      {
        root: root instanceof Element ? root : null,
        rootMargin: "200px 0px",
      },
    );
    observers.set(root, observer);
  }
  callbacks.set(element, onVisible);
  observer.observe(element);
  const watching = observer;
  return () => {
    watching.unobserve(element);
    callbacks.delete(element);
  };
}

export type ThumbnailProps = {
  projectId: string;
  version: string;
  screenId: string;
  // The screen's viewport: the thumbnail is its top, at this ratio.
  viewport: { width: number; height: number };
  // How wide the thumbnail is drawn, for the browser's srcset choice.
  sizes: string;
};

type Source =
  | { kind: "cache" }
  | { kind: "made"; srcSet: string }
  | { kind: "capture"; src: string }
  | { kind: "none" };

// The top of a screen in a rail row. Nothing loads until the row is near
// the visible part of the index; the box keeps its size meanwhile.
export function ScreenThumbnail({
  projectId,
  version,
  screenId,
  viewport,
  sizes,
}: ThumbnailProps) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<Source>({ kind: "cache" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSource({ kind: "cache" });
    setLoaded(false);
  }, [projectId, version, screenId]);

  useEffect(() => {
    const element = box.current;
    if (!element || visible) return;
    return observe(element, () => setVisible(true));
  }, [visible]);

  const bundle = readBundle();
  const bundled = bundle?.thumbnails;
  const aspect = { width: viewport.width, height: viewport.height };

  async function fallback() {
    if (source.kind !== "cache") {
      setSource({ kind: "none" });
      return;
    }
    const capture = captureSrc(projectId, version, screenId);
    try {
      const { makeThumbnail } = await import("../thumbnails");
      const made = await makeThumbnail({
        projectId,
        version,
        screenId,
        captureSrc: capture,
        aspect,
        offline: Boolean(bundle),
      });
      const srcSet = Object.entries(made)
        .map(([width, url]) => `${url} ${width}w`)
        .join(", ");
      setSource(srcSet ? { kind: "made", srcSet } : { kind: "none" });
    } catch {
      // A file:// capture can't be read by a worker: show it cropped instead.
      setSource(bundle ? { kind: "capture", src: capture } : { kind: "none" });
    }
  }

  const missingFromBundle =
    Boolean(bundle) &&
    !bundled?.[bundleThumbnailKey(version, screenId, 400)] &&
    !bundled?.[bundleThumbnailKey(version, screenId, 800)];
  // A bundle made before thumbnails: make one as soon as the row shows.
  useEffect(() => {
    if (visible && missingFromBundle && source.kind === "cache") {
      void fallback();
    }
    // fallback reads the latest props itself.
  }, [visible, missingFromBundle, source.kind]);

  let image = null;
  if (visible && source.kind !== "none") {
    let srcSet: string | undefined;
    let src: string;
    if (source.kind === "made") {
      srcSet = source.srcSet;
      src = source.srcSet.split(" ")[0]!;
    } else if (source.kind === "capture") {
      src = source.src;
    } else if (bundle) {
      const at = (width: number) =>
        bundled?.[bundleThumbnailKey(version, screenId, width)];
      const small = at(400);
      const large = at(800);
      srcSet = small && large ? `${small} 400w, ${large} 800w` : undefined;
      src = small ?? large ?? "";
    } else {
      srcSet = `${thumbnailUrl(projectId, version, screenId, 400)} 400w, ${thumbnailUrl(projectId, version, screenId, 800)} 800w`;
      src = thumbnailUrl(projectId, version, screenId, 400);
    }
    image = src ? (
      <img
        alt=""
        decoding="async"
        fetchPriority="low"
        key={src}
        loading="lazy"
        onError={() => void fallback()}
        onLoad={() => setLoaded(true)}
        sizes={srcSet ? sizes : undefined}
        src={src}
        srcSet={srcSet}
      />
    ) : null;
  }

  return (
    <span
      aria-hidden="true"
      className="screen-thumb"
      data-loaded={loaded || undefined}
      data-testid="screen-thumbnail"
      ref={box}
      style={{ aspectRatio: `${aspect.width} / ${aspect.height}` }}
    >
      {image}
    </span>
  );
}

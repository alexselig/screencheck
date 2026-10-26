import { useEffect, useRef, useState, type CSSProperties } from "react";

import { pinAnchor } from "../../shared/pin-box";
import type { FeedbackRecord } from "../../shared/feedback";
import type { Size } from "../sizes";
import { pinDotClassName } from "./feedback-inspector";

// Every size of one screen side by side, scaled to the same height, with its
// pins. Read-only: pins are added in the single view. Picking a size opens
// it; closing returns to the size you were on.
export function CompareSizes({
  title,
  sizes,
  version,
  fallbackHeight,
  captureSrc,
  pinsFor,
  pinNumbers,
  pinNumbersFor,
  onPick,
  onClose,
}: {
  title: string;
  sizes: readonly Size[];
  version: string;
  // The registered viewport height, used until a capture loads.
  fallbackHeight: number;
  captureSrc: (version: string) => string | undefined;
  pinsFor: (version: string) => FeedbackRecord[];
  pinNumbers: ReadonlyMap<string, number>;
  // Per-size numbers, when a size's pins are numbered apart from the rest.
  pinNumbersFor?: (version: string) => ReadonlyMap<string, number>;
  onPick: (version: string) => void;
  onClose: () => void;
}) {
  const [natural, setNatural] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLOListElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRowWidth(row.clientWidth));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const boxes = sizes.map(
    (size) =>
      natural[size.version] ?? {
        width: size.width ?? 1440,
        height: fallbackHeight,
      },
  );
  const height = fitHeight(rowWidth, boxes);
  return (
    <section
      aria-label="Compare sizes"
      className="compare-sizes"
      style={
        height
          ? ({ "--compare-height": `${height}px` } as CSSProperties)
          : undefined
      }
    >
      <header className="compare-sizes-head">
        <span className="eyebrow">Compare sizes · {title}</span>
        <button onClick={onClose} ref={closeRef} type="button">
          Close
        </button>
      </header>
      <ol className="compare-sizes-row" ref={rowRef}>
        {sizes.map((size, index) => {
          const box = boxes[index];
          const src = captureSrc(size.version);
          return (
            <li key={size.version}>
              <button
                aria-current={size.version === version ? "true" : undefined}
                aria-label={`Show ${size.label}${size.name ? ` ${size.name}` : ""}`}
                className="compare-sizes-shot"
                onClick={() => onPick(size.version)}
                style={
                  {
                    "--shot-ratio": `${box.width} / ${box.height}`,
                  } as CSSProperties
                }
                type="button"
              >
                {src ? (
                  <img
                    alt=""
                    draggable={false}
                    onLoad={(event) => {
                      const { naturalWidth, naturalHeight } =
                        event.currentTarget;
                      if (!naturalWidth || !naturalHeight) return;
                      setNatural((current) => ({
                        ...current,
                        [size.version]: {
                          width: naturalWidth,
                          height: naturalHeight,
                        },
                      }));
                    }}
                    src={src}
                  />
                ) : (
                  <span className="compare-sizes-empty">No capture</span>
                )}
                {pinsFor(size.version).map((item) => (
                  <span
                    aria-hidden="true"
                    className={`feedback-pin ${pinDotClassName(item, false)}`}
                    data-testid="compare-pin"
                    key={item.id}
                    style={{
                      left: `${pinAnchor(item).x * 100}%`,
                      top: `${pinAnchor(item).y * 100}%`,
                    }}
                  >
                    {(pinNumbersFor?.(size.version) ?? pinNumbers).get(
                      item.id,
                    ) ?? 0}
                  </span>
                ))}
              </button>
              <span className="compare-sizes-label">
                {size.label}
                {size.name ? <span> {size.name}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const MAX_HEIGHT = 560;
const MIN_HEIGHT = 240;
// Room for the gaps, borders and current-size outline between shots.
const GUTTER = 32;

// The shared height that lets every shot fit the row side by side, capped so
// a short screen is not blown up, and floored so a narrow window scrolls
// rather than shrinking captures to thumbnails.
export function fitHeight(
  rowWidth: number,
  boxes: readonly { width: number; height: number }[],
) {
  if (!rowWidth || boxes.length === 0) return undefined;
  const ratio = boxes.reduce((sum, box) => sum + box.width / box.height, 0);
  const room = rowWidth - GUTTER * boxes.length;
  return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, room / ratio)));
}

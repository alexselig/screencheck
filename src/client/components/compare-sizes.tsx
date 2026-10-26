import { useEffect, useRef, useState, type CSSProperties } from "react";

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
  onPick: (version: string) => void;
  onClose: () => void;
}) {
  const [natural, setNatural] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), []);
  return (
    <section aria-label="Compare sizes" className="compare-sizes">
      <header className="compare-sizes-head">
        <span className="eyebrow">Compare sizes · {title}</span>
        <button onClick={onClose} ref={closeRef} type="button">
          Close
        </button>
      </header>
      <ol className="compare-sizes-row">
        {sizes.map((size) => {
          const box = natural[size.version] ?? {
            width: size.width ?? 1440,
            height: fallbackHeight,
          };
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
                      left: `${item.x * 100}%`,
                      top: `${item.y * 100}%`,
                    }}
                  >
                    {pinNumbers.get(item.id) ?? 0}
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

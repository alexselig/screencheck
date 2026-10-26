import type { CSSProperties } from "react";

import { pinBoxOf } from "../../shared/pin-box";
import { cropFrame } from "../compare";
import type { BuildCapture } from "./compare-builds";

export type FixPreview = { before: BuildCapture; after: BuildCapture };

// The verify card's glance: the capture the comment was made on and the
// newest capture of that size, cropped to the same spot. The crop is CSS
// only: the capture is scaled up and slid so the pin sits in the middle.
export function FixCrops({
  pin,
  number,
  before,
  after,
}: {
  pin: { x: number; y: number };
  number: number;
  before: BuildCapture;
  after: BuildCapture;
}) {
  const box = pinBoxOf(pin);
  const frame = cropFrame(box ? { ...pin, box } : pin);
  const canvas = {
    width: `${100 / frame.width}%`,
    transform: `translate(${-frame.left * 100}%, ${-frame.centerY * 100}%)`,
  } satisfies CSSProperties;
  return (
    <div
      aria-label="Before and after the fix"
      className="fix-crops"
      role="group"
    >
      {(
        [
          ["Before", before],
          ["After", after],
        ] as const
      ).map(([side, shot]) => (
        <figure className="fix-crop" key={side}>
          <div className="fix-crop-window">
            <div className="fix-crop-canvas" style={canvas}>
              <img
                alt={`Pin ${number} ${side.toLowerCase()} the fix, ${shot.label}`}
                draggable={false}
                src={shot.src}
              />
              {box ? (
                <span
                  aria-hidden="true"
                  className="fix-crop-box"
                  style={{
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.w * 100}%`,
                    height: `${box.h * 100}%`,
                  }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="fix-crop-pin"
                  style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                />
              )}
            </div>
          </div>
          <figcaption>
            {side} · {shot.label}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

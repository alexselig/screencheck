import {
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// How the canvas compares this build with the previous one. Toggle is the
// footer's Before | After flip; the others draw both captures at once.
export type CompareMode = "toggle" | "overlay" | "slider" | "diff";
export type BlendMode = Exclude<CompareMode, "toggle">;

export type BuildCapture = { src: string; label: string };

// The footer's Before | After and the compare modes share one state: flipping
// Before or After goes back to Toggle, and picking a mode shows After.
export function useCompareBuilds() {
  const [showBefore, setBefore] = useState(false);
  const [compareMode, setMode] = useState<CompareMode>("toggle");
  const setShowBefore = useCallback((value: SetStateAction<boolean>) => {
    setMode("toggle");
    setBefore(value);
  }, []);
  const setCompareMode = useCallback((mode: CompareMode) => {
    setMode(mode);
    setBefore(false);
  }, []);
  return { showBefore, setShowBefore, compareMode, setCompareMode };
}

const MODES: readonly [CompareMode, string, string][] = [
  ["toggle", "Toggle", "Flip between builds with Before | After"],
  ["overlay", "Overlay", "This build over the previous one, with an opacity"],
  ["slider", "Slider", "Previous build left of a divider, this build right"],
  ["diff", "Diff", "Highlight the pixels that changed"],
];

// Sits with the size and zoom controls above the capture.
export function CompareModePicker({
  mode,
  onMode,
  beforeLabel,
}: {
  mode: CompareMode;
  onMode: (mode: CompareMode) => void;
  beforeLabel: string;
}) {
  return (
    <div
      aria-label="Compare builds"
      className="segmented compare-modes"
      role="group"
      title={`Compare with ${beforeLabel}`}
    >
      {MODES.map(([value, label, title]) => (
        <button
          aria-pressed={mode === value}
          key={value}
          onClick={() => onMode(value)}
          title={`${title} (${beforeLabel})`}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Drawn over the capture frame; pins stay hidden underneath.
export function CompareBuilds({
  mode,
  before,
  after,
}: {
  mode: BlendMode;
  before: BuildCapture;
  after: BuildCapture;
}) {
  const [opacity, setOpacity] = useState(50);
  const [split, setSplit] = useState(50);
  return (
    <div
      className="compare-builds"
      data-mode={mode}
      data-testid="compare-builds"
    >
      {mode === "diff" ? (
        <DiffView after={after} before={before} />
      ) : (
        <>
          <img
            alt={`${before.label} (before)`}
            className="compare-builds-image"
            draggable={false}
            src={before.src}
          />
          <img
            alt={`${after.label} (after)`}
            className="compare-builds-image"
            draggable={false}
            src={after.src}
            style={
              mode === "overlay"
                ? { opacity: opacity / 100 }
                : { clipPath: `inset(0 0 0 ${split}%)` }
            }
          />
        </>
      )}
      {mode === "overlay" ? (
        <label className="compare-builds-panel">
          <span>{before.label}</span>
          <input
            aria-label="After opacity"
            aria-valuetext={`${after.label} at ${opacity}%`}
            max={100}
            min={0}
            onChange={(event) => setOpacity(Number(event.target.value))}
            type="range"
            value={opacity}
          />
          <span>{after.label}</span>
        </label>
      ) : null}
      {mode === "slider" ? (
        <>
          <span className="compare-builds-badge">{before.label}</span>
          <span className="compare-builds-badge is-after">{after.label}</span>
          {/* The whole frame is the range, so a drag anywhere moves it and
              the arrow keys step it. */}
          <input
            aria-label={`Divider: ${before.label} left, ${after.label} right`}
            aria-valuetext={`${split}% ${before.label}`}
            className="compare-builds-range"
            max={100}
            min={0}
            onChange={(event) => setSplit(Number(event.target.value))}
            type="range"
            value={split}
          />
          <span
            aria-hidden="true"
            className="compare-builds-divider"
            style={{ left: `${split}%` }}
          />
        </>
      ) : null}
    </div>
  );
}

// Any channel moving more than this counts as a changed pixel, so
// anti-aliasing noise stays quiet.
const THRESHOLD = 48;

function highlightColour(): [number, number, number] {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--bauhaus-orange")
    .trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) return [237, 108, 71];
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

// This build, faded, with every pixel that differs from the previous build
// painted in the highlight colour. Runs in the browser on a canvas.
function DiffView({
  before,
  after,
}: {
  before: BuildCapture;
  after: BuildCapture;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [share, setShare] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setShare(null);
    setFailed(false);
    Promise.all([loadImage(before.src), loadImage(after.src)])
      .then(([old, now]) => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { willReadFrequently: true });
        if (cancelled || !canvas || !context) return;
        const width = now.naturalWidth;
        const height = now.naturalHeight;
        canvas.width = width;
        canvas.height = height;
        context.drawImage(old, 0, 0);
        const previous = context.getImageData(0, 0, width, height).data;
        context.clearRect(0, 0, width, height);
        context.drawImage(now, 0, 0);
        const image = context.getImageData(0, 0, width, height);
        const pixels = image.data;
        const [red, green, blue] = highlightColour();
        let changed = 0;
        for (let at = 0; at < pixels.length; at += 4) {
          const delta = Math.max(
            Math.abs(pixels[at]! - previous[at]!),
            Math.abs(pixels[at + 1]! - previous[at + 1]!),
            Math.abs(pixels[at + 2]! - previous[at + 2]!),
            Math.abs(pixels[at + 3]! - previous[at + 3]!),
          );
          if (delta > THRESHOLD) {
            changed += 1;
            pixels[at] = red;
            pixels[at + 1] = green;
            pixels[at + 2] = blue;
            pixels[at + 3] = 255;
          } else {
            for (let channel = 0; channel < 3; channel += 1) {
              pixels[at + channel] = 255 - (255 - pixels[at + channel]!) / 5;
            }
          }
        }
        context.putImageData(image, 0, 0);
        setShare(changed / (width * height));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [before.src, after.src]);
  return (
    <>
      <canvas
        aria-label={`Changed pixels between ${before.label} and ${after.label}`}
        className="compare-builds-image"
        ref={canvasRef}
        role="img"
      />
      <span aria-live="polite" className="compare-builds-badge">
        {failed
          ? "Diff unavailable"
          : share === null
            ? "Comparing…"
            : share === 0
              ? `No change since ${before.label}`
              : `${share < 0.001 ? "<0.1" : (share * 100).toFixed(1)}% changed since ${before.label}`}
      </span>
    </>
  );
}

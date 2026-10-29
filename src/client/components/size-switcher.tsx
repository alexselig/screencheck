import type { Size } from "../sizes";
import { SHORTCUTS } from "../shortcuts";

export type Zoom = "fit" | "actual";

// Above the capture: which size to review, how big to draw it, and the
// side-by-side view of every size.
export function CanvasToolbar({
  sizes,
  version,
  onSize,
  zoom,
  onZoom,
  onCompare,
  comparing = false,
}: {
  sizes: readonly Size[];
  version: string;
  onSize: (version: string) => void;
  zoom: Zoom;
  onZoom: (zoom: Zoom) => void;
  onCompare?: () => void;
  comparing?: boolean;
}) {
  return (
    <div className="canvas-toolbar">
      {sizes.length > 1 ? (
        <SizeSwitcher onSize={onSize} sizes={sizes} version={version} />
      ) : null}
      <div aria-label="Zoom" className="segmented" role="group">
        {(
          [
            ["fit", "Fit", "Fit the whole width in the canvas"],
            ["actual", "100%", "Actual pixels; the canvas scrolls"],
          ] as const
        ).map(([value, label, title]) => (
          <button
            aria-pressed={zoom === value}
            key={value}
            onClick={() => onZoom(value)}
            title={title}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {sizes.length > 1 && onCompare ? (
        <button
          aria-pressed={comparing}
          className="canvas-compare-button"
          onClick={onCompare}
          title={comparing ? "Close Compare sizes (Esc)" : undefined}
          type="button"
        >
          Compare sizes
          {comparing ? (
            <span aria-hidden="true" className="canvas-compare-close">
              <svg height="14" viewBox="0 0 14 14" width="14">
                <path
                  d="M2 2l10 10M12 2 2 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                />
              </svg>
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}

export function SizeSwitcher({
  sizes,
  version,
  onSize,
}: {
  sizes: readonly Size[];
  version: string;
  onSize: (version: string) => void;
}) {
  return (
    <div
      aria-label="Screen size"
      className="segmented size-switcher"
      role="group"
    >
      {sizes.map((size) => (
        <button
          aria-keyshortcuts={`${SHORTCUTS.previousSize.aria} ${SHORTCUTS.nextSize.aria}`}
          aria-label={size.name ? `${size.label} ${size.name}` : size.label}
          aria-pressed={size.version === version}
          key={size.version}
          onClick={() => onSize(size.version)}
          title={`${size.name ? `${size.name} · ` : ""}${size.label} (${SHORTCUTS.previousSize.label} / ${SHORTCUTS.nextSize.label})`}
          type="button"
        >
          <span className="size-switcher-label">{size.label}</span>
          {size.name ? (
            <span className="size-switcher-name">{size.name}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

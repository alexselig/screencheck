import type { ReactNode } from "react";

export type FullscreenDrawer = { open: boolean; pinned: boolean };

// Escape is handled by the App so it only undoes the innermost thing; this
// component just renders the edges and reports drawer changes.
export function FullscreenReview({
  children,
  navigation,
  feedback,
  drawer,
  onDrawerChange,
}: {
  children: ReactNode;
  navigation: ReactNode;
  feedback: ReactNode;
  drawer: FullscreenDrawer;
  onDrawerChange: (drawer: FullscreenDrawer) => void;
}) {
  return (
    <div className="fullscreen-review" data-testid="fullscreen-review">
      {/* The screen rail sits on the edge in its compact form and expands on hover. */}
      <div className="fullscreen-rail">{navigation}</div>
      <div className="fullscreen-canvas">{children}</div>
      <div
        className="fullscreen-edge fullscreen-edge-feedback"
        data-open={drawer.open}
        onFocus={() => {
          if (!drawer.open) onDrawerChange({ ...drawer, open: true });
        }}
        onMouseEnter={() => onDrawerChange({ ...drawer, open: true })}
        onMouseLeave={() => {
          if (!drawer.pinned) onDrawerChange({ open: false, pinned: false });
        }}
      >
        <button
          aria-expanded={drawer.open}
          aria-label="Feedback panel"
          className="fullscreen-edge-handle"
          onClick={() => {
            const pinned = !drawer.pinned;
            onDrawerChange({ open: pinned, pinned });
          }}
          type="button"
        >
          Feedback
        </button>
        <section className="fullscreen-edge-panel">{feedback}</section>
      </div>
    </div>
  );
}

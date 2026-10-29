import { type KeyboardEvent, type PointerEvent, useRef } from "react";

import {
  RAIL_MIN,
  RAIL_STEP,
  RAIL_STEP_LARGE,
  clampRailWidth,
  dragOutcome,
} from "../use-rail-width";

const COMPACT_WIDTH = 64;

// The handle on the screen index's right edge. A drag writes --rail-width
// straight onto the layout once per frame, so React doesn't re-render while
// it moves; the new width is committed once, on release.
export function RailResizer({
  width,
  max,
  onChange,
  onCompact,
}: {
  // The current width; RAIL_DEFAULT when the reviewer never chose one.
  width: number;
  max: number;
  // A committed width, or null to go back to the default.
  onChange: (width: number | null) => void;
  onCompact: () => void;
}) {
  const readoutRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{
    startX: number;
    startWidth: number;
    target: HTMLElement;
    previous: string;
    raw: number;
    frame: number;
  } | null>(null);

  function target(handle: HTMLElement) {
    return (
      handle.closest<HTMLElement>(".workbench-grid, .fullscreen-review") ??
      handle.parentElement!
    );
  }

  function paint() {
    const state = drag.current;
    if (!state) return;
    state.frame = 0;
    const outcome = dragOutcome(state.raw, window.innerWidth);
    const shown = outcome.compact ? COMPACT_WIDTH : outcome.width;
    state.target.style.setProperty("--rail-width", `${shown}px`);
    if (readoutRef.current) {
      readoutRef.current.textContent = outcome.compact
        ? "Collapse"
        : `${shown} px`;
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const grid = target(handle);
    const rail = handle.parentElement?.getBoundingClientRect().width;
    drag.current = {
      startX: event.clientX,
      startWidth: rail && rail > 0 ? rail : width,
      target: grid,
      previous: grid.style.getPropertyValue("--rail-width"),
      raw: 0,
      frame: 0,
    };
    drag.current.raw = drag.current.startWidth;
    grid.dataset.resizing = "true";
    handle.dataset.dragging = "true";
    if (readoutRef.current) {
      readoutRef.current.textContent = `${Math.round(drag.current.startWidth)} px`;
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    state.raw = state.startWidth + event.clientX - state.startX;
    if (!state.frame) state.frame = requestAnimationFrame(paint);
  }

  function finish(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    if (state.frame) cancelAnimationFrame(state.frame);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    delete state.target.dataset.resizing;
    delete event.currentTarget.dataset.dragging;
    const moved = Math.abs(state.raw - state.startWidth) >= 1;
    const outcome = dragOutcome(state.raw, window.innerWidth);
    // Put back what React last rendered; the commit below re-renders it.
    if (state.previous) {
      state.target.style.setProperty("--rail-width", state.previous);
    } else {
      state.target.style.removeProperty("--rail-width");
    }
    if (!commit || !moved) return;
    if (outcome.compact) onCompact();
    else onChange(outcome.width);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? RAIL_STEP_LARGE : RAIL_STEP;
    const viewport = window.innerWidth;
    let next: number | null | undefined;
    if (event.key === "ArrowLeft")
      next = clampRailWidth(width - step, viewport);
    else if (event.key === "ArrowRight")
      next = clampRailWidth(width + step, viewport);
    else if (event.key === "Home") next = RAIL_MIN;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") next = null;
    else return;
    // Handled here, so the global ← → screen and Shift+← → size keys don't
    // also fire.
    event.preventDefault();
    event.stopPropagation();
    onChange(next);
  }

  return (
    <div
      aria-label="Resize screen index"
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={RAIL_MIN}
      aria-valuenow={width}
      className="rail-resizer"
      onDoubleClick={() => onChange(null)}
      onKeyDown={onKeyDown}
      onLostPointerCapture={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      role="separator"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
    >
      <span className="rail-resizer-track">
        <span aria-hidden="true" className="rail-resizer-grip" />
        <span
          aria-hidden="true"
          className="rail-resizer-readout"
          ref={readoutRef}
        />
      </span>
    </div>
  );
}

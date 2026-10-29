import { type CSSProperties, useCallback, useEffect, useState } from "react";

// The wide screen index can be dragged between these widths. Below the snap
// point a drag collapses it to the compact strip instead.
export const RAIL_DEFAULT = 280;
export const RAIL_MIN = 220;
export const RAIL_MAX = 640;
export const RAIL_SNAP_COMPACT = 160;
export const RAIL_STEP = 16;
export const RAIL_STEP_LARGE = 64;

const RAIL_WIDTH_KEY = "screencheck:rail-width";

// Never more than half the window, so the canvas keeps room.
export function railMax(viewportWidth: number) {
  return Math.max(RAIL_MIN, Math.min(Math.floor(viewportWidth / 2), RAIL_MAX));
}

export function clampRailWidth(width: number, viewportWidth: number) {
  return Math.round(
    Math.min(Math.max(width, RAIL_MIN), railMax(viewportWidth)),
  );
}

// Where a drag lands: a width, or the compact strip when pulled past it.
export function dragOutcome(
  raw: number,
  viewportWidth: number,
): { compact: true } | { compact: false; width: number } {
  if (raw < RAIL_SNAP_COMPACT) return { compact: true };
  return { compact: false, width: clampRailWidth(raw, viewportWidth) };
}

export function readRailWidth(): number | null {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeRailWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(RAIL_WIDTH_KEY);
    else localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable; the width still applies for this session.
  }
}

function viewportWidth() {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

// The remembered rail width, clamped again whenever the window resizes.
// null means the reviewer never chose one, so the stylesheet default applies.
export function useRailWidth() {
  const [stored, setStored] = useState(readRailWidth);
  const [windowWidth, setWindowWidth] = useState(viewportWidth);
  useEffect(() => {
    const follow = () => setWindowWidth(viewportWidth());
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, []);
  const setWidth = useCallback((width: number | null) => {
    setStored(width);
    writeRailWidth(width);
  }, []);
  return {
    width: stored === null ? null : clampRailWidth(stored, windowWidth),
    max: railMax(windowWidth),
    setWidth,
  };
}

// The inline style that carries a chosen width to the grid (and the
// fullscreen rail); without one the stylesheet default applies.
export function railWidthStyle(width: number | null) {
  return width === null
    ? undefined
    : ({ "--rail-width": `${width}px` } as CSSProperties);
}

// How wide a thumbnail is drawn: the rail less its number column and padding.
export function railThumbnailSizes(width: number | null) {
  return `${Math.max(120, (width ?? RAIL_DEFAULT) - 64)}px`;
}

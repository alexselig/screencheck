import { type RefObject, useEffect, useRef } from "react";

const SHOW_THUMBNAILS_KEY = "screencheck:show-thumbnails";

export function readShowThumbnails() {
  try {
    return localStorage.getItem(SHOW_THUMBNAILS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowThumbnails(show: boolean) {
  try {
    localStorage.setItem(SHOW_THUMBNAILS_KEY, show ? "1" : "0");
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
}

function Switch({
  checked,
  onToggle,
  label,
  extra,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  extra?: string;
}) {
  return (
    <button
      aria-checked={checked}
      className="rail-filter-button"
      onClick={onToggle}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className="rail-filter-switch" />
      <span>{label}</span>
      {extra ? <span className="rail-filter-count">{extra}</span> : null}
    </button>
  );
}

// The desktop rail is sticky under a page header that scrolls away. Keeps
// --rail-offset on it equal to the header still in view, so a short list's
// settings sit on the visible bottom edge rather than below the window.
function useVisibleRailHeight(
  ref: RefObject<HTMLDivElement | null>,
  shown: boolean,
) {
  useEffect(() => {
    const nav = ref.current?.closest<HTMLElement>(
      ".rail-column > .screen-rail",
    );
    const column = nav?.parentElement;
    if (!nav || !column) return;
    let frame = 0;
    let last = "";
    const measure = () => {
      frame = 0;
      const offset = `${Math.max(0, Math.round(column.getBoundingClientRect().top))}px`;
      if (offset === last) return;
      last = offset;
      nav.style.setProperty("--rail-offset", offset);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // The header above can change height after load (fonts, notices).
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(document.body);
    return () => {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      nav.style.removeProperty("--rail-offset");
    };
  }, [ref, shown]);
}

// Set-and-forget settings, below the last screen and pushed to the foot of
// the rail when the list is short.
export function RailSettings({
  hideApproved,
  showThumbnails,
}: {
  hideApproved?: {
    checked: boolean;
    hiddenCount: number;
    onToggle: () => void;
  };
  showThumbnails?: { checked: boolean; onToggle: () => void };
}) {
  const ref = useRef<HTMLDivElement>(null);
  useVisibleRailHeight(ref, Boolean(hideApproved || showThumbnails));
  if (!hideApproved && !showThumbnails) return null;
  return (
    <div className="rail-settings" data-testid="rail-settings" ref={ref}>
      {hideApproved ? (
        <Switch
          checked={hideApproved.checked}
          extra={
            hideApproved.checked
              ? `${hideApproved.hiddenCount} hidden`
              : undefined
          }
          label="Hide approved screens"
          onToggle={hideApproved.onToggle}
        />
      ) : null}
      {showThumbnails ? (
        <Switch
          checked={showThumbnails.checked}
          label="Show thumbnails"
          onToggle={showThumbnails.onToggle}
        />
      ) : null}
    </div>
  );
}

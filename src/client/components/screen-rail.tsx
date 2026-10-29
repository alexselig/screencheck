import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { ReviewScreen } from "../../shared/manifest";
import {
  RailSettings,
  readShowThumbnails,
  writeShowThumbnails,
} from "./rail-settings";
import { ScreenThumbnail } from "./screen-thumbnail";

export type RailMode = "wide" | "compact";

// On a tablet-width window the rail starts as numbers so the capture gets
// the room; it still expands on hover.
export const TABLET_QUERY = "(min-width: 901px) and (max-width: 1200px)";

// The phone/tablet strip centres the current screen, so the screens either
// side of it stay in view.
export function centeredScrollLeft(
  left: number,
  width: number,
  viewport: number,
  scrollWidth: number,
) {
  const centred = left + width / 2 - viewport / 2;
  return Math.round(Math.min(Math.max(0, centred), scrollWidth - viewport));
}

export function defaultRailMode(): RailMode {
  return typeof window.matchMedia === "function" &&
    window.matchMedia(TABLET_QUERY).matches
    ? "compact"
    : "wide";
}

const HIDE_APPROVED_KEY = "screencheck:hide-approved-screens";

export function readHideApproved() {
  try {
    return localStorage.getItem(HIDE_APPROVED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHideApproved(hide: boolean) {
  try {
    localStorage.setItem(HIDE_APPROVED_KEY, hide ? "1" : "0");
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
}

// The rows the rail lists. The current screen stays listed even when
// approved, so you never lose it; Prev/Next walk this same list.
export function visibleRailScreens<T extends { id: string }>(
  screens: readonly T[],
  selectedId: string,
  approvedIds: ReadonlySet<string> | undefined,
  hideApproved: boolean,
) {
  return hideApproved
    ? screens.filter(
        (screen) => screen.id === selectedId || !approvedIds?.has(screen.id),
      )
    : [...screens];
}

// Short labels for the collapsed rail, where only the number column shows.
// "1440 × 1000" → "1440", "build-42" → "42", "Mobile" → "Mob".
export function versionTag(label: string) {
  const digits = label.match(/\d+/g);
  if (digits)
    return label.includes("×") ? digits[0] : digits[digits.length - 1];
  return label.trim().slice(0, 3);
}

export function ScreenRail({
  screens,
  selectedId,
  openCounts,
  approvedIds,
  partialApprovals,
  mode,
  onModeChange,
  onSelect,
  hideApproved: hideApprovedProp,
  onHideApprovedChange,
  thumbnails,
  changedIds,
  changedSince,
}: {
  // versionLabel is set when the rail lists one row per version.
  screens: (ReviewScreen & { versionLabel?: string })[];
  selectedId: string;
  openCounts?: ReadonlyMap<string, number>;
  approvedIds?: ReadonlySet<string>;
  // Screens approved at some of their sizes, with a summary of which.
  partialApprovals?: ReadonlyMap<string, string>;
  mode: RailMode;
  // Omitted where the container controls collapse (the fullscreen drawer).
  onModeChange?: (mode: RailMode) => void;
  onSelect: (id: string) => void;
  // Controlled by the app so Prev/Next skip the same rows; standalone, the
  // rail keeps the choice itself.
  hideApproved?: boolean;
  onHideApprovedChange?: (hide: boolean) => void;
  // Where thumbnails come from; omitted where there is no room (phones).
  // `width` is the current size's width, `sizes` how wide they are drawn.
  thumbnails?: {
    projectId: string;
    version: string;
    width?: number;
    sizes: string;
  };
  // Screens whose capture differs from the previous build at this size.
  changedIds?: ReadonlySet<string>;
  changedSince?: string;
}) {
  const [showThumbnails, setShowThumbnails] = useState(readShowThumbnails);
  const thumbs = showThumbnails && mode === "wide" ? thumbnails : undefined;
  const [temporaryExpanded, setTemporaryExpanded] = useState(false);
  const [hideApprovedState, setHideApproved] = useState(readHideApproved);
  const hideApproved = hideApprovedProp ?? hideApprovedState;
  const approvedCount = screens.filter((screen) =>
    approvedIds?.has(screen.id),
  ).length;
  const visibleScreens = visibleRailScreens(
    screens,
    selectedId,
    approvedIds,
    hideApproved,
  );
  // The current screen is kept listed while hidden, so count only real drops.
  const hiddenCount = screens.length - visibleScreens.length;
  function toggleHideApproved() {
    const next = !hideApproved;
    // Hiding while on an approved screen would leave its row in place, so
    // step to the nearest screen still to review, looking forward first.
    if (next && approvedIds?.has(selectedId)) {
      const at = screens.findIndex((screen) => screen.id === selectedId);
      const open = (screen: { id: string }) => !approvedIds.has(screen.id);
      const target =
        screens.slice(at + 1).find(open) ??
        screens.slice(0, Math.max(at, 0)).reverse().find(open);
      if (target) onSelect(target.id);
    }
    if (onHideApprovedChange) {
      onHideApprovedChange(next);
    } else {
      setHideApproved(next);
      writeHideApproved(next);
    }
  }
  const expanded = mode === "wide" || temporaryExpanded;
  let previousGroup = "";
  let groupIndex = -1;
  const navRef = useRef<HTMLElement>(null);

  // Keep the current screen visible in the list without moving the page.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    const strip = current.closest("ol");
    let stripObserver: ResizeObserver | undefined;
    if (strip) {
      const centre = () => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        const box = current.getBoundingClientRect();
        strip.scrollLeft = centeredScrollLeft(
          box.left - strip.getBoundingClientRect().left + strip.scrollLeft,
          box.width,
          strip.clientWidth,
          strip.scrollWidth,
        );
      };
      centre();
      // Counts and fonts arrive after the first paint and widen the items.
      if (typeof ResizeObserver === "function") {
        stripObserver = new ResizeObserver(centre);
        for (const item of strip.children) stripObserver.observe(item);
      }
    }
    const stop = () => stripObserver?.disconnect();
    if (nav.scrollHeight <= nav.clientHeight) return stop;
    const top = current.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop + 48) {
      nav.scrollTop = Math.max(0, top - 96);
    } else if (top + current.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + current.offsetHeight - nav.clientHeight + 48;
    }
    return stop;
  }, [selectedId]);

  // When a screen button has focus, keep focus on the current screen so the
  // arrow keys (here and the global ← →) always move from what's selected.
  useEffect(() => {
    const nav = navRef.current;
    const active = document.activeElement;
    if (!nav || !(active instanceof HTMLElement)) return;
    if (!active.dataset.screenId || !nav.contains(active)) return;
    nav
      .querySelector<HTMLElement>('[aria-current="page"]')
      ?.focus({ preventScroll: true });
  }, [selectedId]);

  const rovingId = visibleScreens.some((screen) => screen.id === selectedId)
    ? selectedId
    : "";

  function onListKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    const target = event.target as HTMLElement;
    const focusedId = target.dataset?.screenId;
    if (!focusedId) return;
    const from = visibleScreens.findIndex(
      (screen) => screen.id === (selectedId || focusedId),
    );
    let to: number;
    if (event.key === "ArrowDown") to = from + 1;
    else if (event.key === "ArrowUp") to = from - 1;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = visibleScreens.length - 1;
    else return;
    event.preventDefault();
    if (from < 0 || to < 0 || to >= visibleScreens.length || to === from)
      return;
    onSelect(visibleScreens[to].id);
  }

  return (
    <nav
      aria-label="Screen navigation"
      ref={navRef}
      className="screen-rail"
      data-expanded={expanded}
      data-mode={mode}
      onFocus={() => mode === "compact" && setTemporaryExpanded(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setTemporaryExpanded(false);
        }
      }}
      onMouseEnter={() => mode === "compact" && setTemporaryExpanded(true)}
      onMouseLeave={() => setTemporaryExpanded(false)}
    >
      <div className="rail-head">
        <div className="rail-toolbar">
          {expanded ? <h2 className="rail-title">Screen index</h2> : null}
          {onModeChange ? (
            <button
              aria-label={
                mode === "wide"
                  ? "Collapse screen index"
                  : "Expand screen index"
              }
              aria-expanded={mode === "wide"}
              className="rail-mode-button"
              title={
                mode === "wide" ? "Collapse to numbers" : "Expand screen index"
              }
              onClick={() => {
                setTemporaryExpanded(false);
                onModeChange(mode === "wide" ? "compact" : "wide");
              }}
              type="button"
            >
              <svg
                aria-hidden="true"
                height="16"
                viewBox="0 0 16 16"
                width="16"
              >
                <path
                  d={
                    mode === "wide"
                      ? "M9 3 4 8l5 5M13 3 8 8l5 5"
                      : "M3 3l5 5-5 5M7 3l5 5-5 5"
                  }
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
      <ol onKeyDown={onListKeyDown}>
        {visibleScreens.map((screen, index) => {
          const showGroup = screen.group !== previousGroup;
          if (showGroup) groupIndex += 1;
          previousGroup = screen.group;
          const approved = approvedIds?.has(screen.id) ?? false;
          const partial = approved
            ? undefined
            : partialApprovals?.get(screen.id);
          const openCount = openCounts?.get(screen.id) ?? 0;
          const changed =
            changedIds?.has(screen.id) && changedSince
              ? `Changed since ${changedSince}`
              : "";
          return (
            <li key={screen.id}>
              {showGroup ? (
                <h3 data-tone={groupIndex % 4} title={screen.group}>
                  <span className="group-full">{screen.group}</span>
                </h3>
              ) : null}
              <button
                aria-current={screen.id === selectedId ? "page" : undefined}
                data-screen-id={screen.id}
                // One tab stop for the whole list; ↑ / ↓ / Home / End move.
                tabIndex={
                  screen.id === rovingId || (!rovingId && index === 0) ? 0 : -1
                }
                aria-label={`${String(screen.ordinal).padStart(2, "0")}. ${screen.title}${screen.versionLabel ? ` · ${screen.versionLabel}` : ""}${approved ? " (approved)" : ""}${partial ? ` (${partial})` : ""}${openCount ? `, ${openCount} open` : ""}${changed ? `, changed since ${changedSince}` : ""}`}
                onClick={() => onSelect(screen.id)}
                title={[
                  screen.title,
                  screen.versionLabel ?? "",
                  approved ? "Approved" : "",
                  partial ?? "",
                  openCount ? `${openCount} open` : "",
                  changed,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                type="button"
              >
                <span className="screen-number">
                  <span aria-hidden="true" className="screen-badges">
                    {approved ? (
                      <svg
                        className="screen-approved-mark"
                        data-testid="screen-approved-mark"
                        viewBox="0 0 12 12"
                      >
                        <circle cx="6" cy="6" r="6" />
                        <path d="M3.2 6.2 5.2 8.1 8.9 4.2" />
                      </svg>
                    ) : partial ? (
                      <svg
                        className="screen-approved-mark is-partial"
                        data-testid="screen-partial-mark"
                        viewBox="0 0 12 12"
                      >
                        <circle cx="6" cy="6" r="5.25" />
                        <path d="M3.2 6.2 5.2 8.1 8.9 4.2" />
                      </svg>
                    ) : null}
                    {changed ? (
                      <span
                        className="screen-changed-dot"
                        data-testid="screen-changed-dot"
                        title={changed}
                      />
                    ) : null}
                    {/* Approved at every size: the tick says it all. */}
                    {openCount && !approved ? (
                      <span
                        className="screen-open-count"
                        data-testid="screen-open-count"
                      >
                        {openCount}
                      </span>
                    ) : null}
                  </span>
                  <span className="screen-ordinal">
                    {String(screen.ordinal).padStart(2, "0")}
                  </span>
                  {screen.versionLabel ? (
                    <span aria-hidden="true" className="screen-version-tag">
                      {versionTag(screen.versionLabel)}
                    </span>
                  ) : null}
                </span>
                <span className="screen-name">{screen.title}</span>
                {thumbs &&
                (screen as { hasCapture?: boolean }).hasCapture !== false ? (
                  <ScreenThumbnail
                    projectId={thumbs.projectId}
                    screenId={screen.id}
                    sizes={thumbs.sizes}
                    version={thumbs.version}
                    viewport={{
                      width: thumbs.width ?? screen.viewport.width,
                      height: screen.viewport.height,
                    }}
                  />
                ) : null}
                {screen.versionLabel ? (
                  <span aria-hidden="true" className="screen-version">
                    {versionTag(screen.versionLabel)}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
      {mode === "wide" ? (
        <RailSettings
          hideApproved={
            approvedCount > 0
              ? {
                  checked: hideApproved,
                  hiddenCount,
                  onToggle: toggleHideApproved,
                }
              : undefined
          }
          showThumbnails={
            thumbnails
              ? {
                  checked: showThumbnails,
                  onToggle: () => {
                    setShowThumbnails(!showThumbnails);
                    writeShowThumbnails(!showThumbnails);
                  },
                }
              : undefined
          }
        />
      ) : null}
    </nav>
  );
}

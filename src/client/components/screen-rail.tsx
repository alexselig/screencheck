import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { ReviewScreen } from "../../shared/manifest";

export type RailMode = "wide" | "compact";

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

// "Sign in" → "SI", "Onboarding" → "O".
export function groupAbbreviation(group: string) {
  return group
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export function ScreenRail({
  screens,
  selectedId,
  openCounts,
  approvedIds,
  mode,
  onModeChange,
  onSelect,
  hideApproved: hideApprovedProp,
  onHideApprovedChange,
}: {
  // versionLabel is set when the rail lists one row per version.
  screens: (ReviewScreen & { versionLabel?: string })[];
  selectedId: string;
  openCounts?: ReadonlyMap<string, number>;
  approvedIds?: ReadonlySet<string>;
  mode: RailMode;
  // Omitted where the container controls collapse (the fullscreen drawer).
  onModeChange?: (mode: RailMode) => void;
  onSelect: (id: string) => void;
  // Controlled by the app so Prev/Next skip the same rows; standalone, the
  // rail keeps the choice itself.
  hideApproved?: boolean;
  onHideApprovedChange?: (hide: boolean) => void;
}) {
  const [temporaryExpanded, setTemporaryExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
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
  function toggleHideApproved() {
    const next = !hideApproved;
    if (onHideApprovedChange) {
      onHideApprovedChange(next);
    } else {
      setHideApproved(next);
      writeHideApproved(next);
    }
  }
  const expanded = mode === "wide" || temporaryExpanded || pinned;
  let previousGroup = "";
  let groupIndex = -1;
  const navRef = useRef<HTMLElement>(null);

  // Keep the current screen visible in the list without moving the page.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    const strip = current.closest("ol");
    if (strip && strip.scrollWidth > strip.clientWidth) {
      const left = current.offsetLeft - strip.offsetLeft;
      if (
        left < strip.scrollLeft ||
        left + current.offsetWidth > strip.scrollLeft + strip.clientWidth
      ) {
        strip.scrollLeft = Math.max(0, left - 16);
      }
    }
    if (nav.scrollHeight <= nav.clientHeight) return;
    const top = current.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop + 48) {
      nav.scrollTop = Math.max(0, top - 96);
    } else if (top + current.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + current.offsetHeight - nav.clientHeight + 48;
    }
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
        if (!event.currentTarget.contains(event.relatedTarget) && !pinned) {
          setTemporaryExpanded(false);
        }
      }}
      onMouseEnter={() => mode === "compact" && setTemporaryExpanded(true)}
      onMouseLeave={() => !pinned && setTemporaryExpanded(false)}
    >
      <div className="rail-toolbar">
        {expanded ? <h2 className="rail-title">Screen index</h2> : null}
        {mode === "compact" && expanded ? (
          <button
            aria-pressed={pinned}
            className="rail-pin-button"
            onClick={() => setPinned((value) => !value)}
            type="button"
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        ) : null}
        {onModeChange ? (
          <button
            aria-label={
              mode === "wide" ? "Collapse screen index" : "Expand screen index"
            }
            aria-expanded={mode === "wide"}
            className="rail-mode-button"
            title={
              mode === "wide" ? "Collapse to numbers" : "Expand screen index"
            }
            onClick={() => {
              setPinned(false);
              setTemporaryExpanded(false);
              onModeChange(mode === "wide" ? "compact" : "wide");
            }}
            type="button"
          >
            <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
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
      {approvedCount > 0 ? (
        <button
          aria-pressed={hideApproved}
          className="rail-filter-button"
          onClick={toggleHideApproved}
          type="button"
        >
          {hideApproved
            ? `Show approved screens (${approvedCount})`
            : "Hide approved screens"}
        </button>
      ) : null}
      <ol onKeyDown={onListKeyDown}>
        {visibleScreens.map((screen, index) => {
          const showGroup = screen.group !== previousGroup;
          if (showGroup) groupIndex += 1;
          previousGroup = screen.group;
          const approved = approvedIds?.has(screen.id) ?? false;
          const openCount = openCounts?.get(screen.id) ?? 0;
          return (
            <li key={screen.id}>
              {showGroup ? (
                <h3 data-tone={groupIndex % 4} title={screen.group}>
                  <span className="group-full">{screen.group}</span>
                  <span aria-hidden="true" className="group-short">
                    {groupAbbreviation(screen.group)}
                  </span>
                </h3>
              ) : null}
              <button
                aria-current={screen.id === selectedId ? "page" : undefined}
                data-screen-id={screen.id}
                // One tab stop for the whole list; ↑ / ↓ / Home / End move.
                tabIndex={
                  screen.id === rovingId || (!rovingId && index === 0) ? 0 : -1
                }
                aria-label={`${String(screen.ordinal).padStart(2, "0")}. ${screen.title}${approved ? " (approved)" : ""}${openCount ? `, ${openCount} open` : ""}`}
                onClick={() => onSelect(screen.id)}
                title={[
                  screen.title,
                  approved ? "Approved" : "",
                  openCount ? `${openCount} open` : "",
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
                    ) : null}
                    {openCount ? (
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
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

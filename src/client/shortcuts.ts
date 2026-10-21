import { type RefObject, useEffect, useRef } from "react";

// Every app-wide shortcut lives here: one window listener, one "is typing"
// and "inside a dialog" check, and one registry that the buttons read their
// hints and aria-keyshortcuts from.

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

export function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function inDialog(target: EventTarget | null) {
  return (
    target instanceof Element && target.closest('[role="dialog"]') !== null
  );
}

export const SHORTCUTS = {
  addFeedback: {
    label: isMac ? "⌘F" : "Ctrl+F",
    kbd: isMac ? "⌘F" : "Ctrl F",
    aria: isMac ? "Meta+F" : "Control+F",
  },
  approve: { label: isMac ? "⌘A" : "Ctrl+A", aria: "Meta+A Control+A" },
  previous: { label: "←", aria: "ArrowLeft [" },
  next: { label: "→", aria: "ArrowRight ]" },
  escape: { label: "Esc", aria: "Escape" },
} as const;

// Escape undoes only the innermost thing. Layers are checked in order; the
// first active one runs. Dialogs and confirms handle Esc themselves and call
// preventDefault, so they always win.
export type EscapeLayer = {
  active: boolean;
  run: () => void;
  // Most layers stand aside while a field has focus, so Esc never yanks a
  // half-written note away.
  whileTyping?: boolean;
  // Swallow Esc without acting (for example while a modal owns it).
  block?: boolean;
};

export type ShortcutHandlers = {
  escape: EscapeLayer[];
  addFeedback?: () => void;
  // Returns false when there is nothing to approve, so the browser's own
  // select-all still runs.
  approve?: () => boolean;
  step?: (delta: 1 | -1) => void;
};

function command(event: KeyboardEvent, key: string) {
  return (
    event.key.toLowerCase() === key &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function routeShortcut(
  event: KeyboardEvent,
  handlers: ShortcutHandlers,
) {
  if (event.defaultPrevented) return;
  const typing = isTyping(event.target);
  if (event.key === "Escape") {
    for (const layer of handlers.escape) {
      if (!layer.active || (typing && !layer.whileTyping)) continue;
      if (layer.block) return;
      event.preventDefault();
      layer.run();
      return;
    }
    return;
  }
  if (inDialog(event.target)) return;
  if (command(event, "f") && handlers.addFeedback) {
    event.preventDefault();
    handlers.addFeedback();
    return;
  }
  if (command(event, "a") && !typing) {
    if (handlers.approve?.()) event.preventDefault();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || typing) return;
  if (!handlers.step) return;
  if (event.key === "ArrowRight" || event.key === "]") {
    event.preventDefault();
    handlers.step(1);
  } else if (event.key === "ArrowLeft" || event.key === "[") {
    event.preventDefault();
    handlers.step(-1);
  }
}

// Handlers are read from a ref, so callers pass fresh closures every render
// without re-subscribing.
export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      routeShortcut(event, ref.current);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export type ApproveShortcut = RefObject<(() => void) | null>;

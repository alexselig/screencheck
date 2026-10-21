import { describe, expect, it, vi } from "vitest";

import {
  inDialog,
  isTyping,
  routeShortcut,
  type ShortcutHandlers,
} from "../src/client/shortcuts";

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

function handlers(extra: Partial<ShortcutHandlers> = {}): ShortcutHandlers {
  return {
    escape: [],
    addFeedback: vi.fn(),
    approve: vi.fn(() => true),
    step: vi.fn(),
    ...extra,
  };
}

describe("shortcut router (ux-18)", () => {
  it("runs only the first active Escape layer", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const event = press({ key: "Escape" });
    routeShortcut(
      event,
      handlers({
        escape: [
          { active: false, run: vi.fn() },
          { active: true, run: inner },
          { active: true, run: outer },
        ],
      }),
    );
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("skips Escape layers while typing unless they opt in", () => {
    const textarea = document.createElement("textarea");
    const drawer = vi.fn();
    const placing = vi.fn();
    routeShortcut(
      press({ key: "Escape" }, textarea),
      handlers({ escape: [{ active: true, run: drawer }] }),
    );
    expect(drawer).not.toHaveBeenCalled();
    routeShortcut(
      press({ key: "Escape" }, textarea),
      handlers({ escape: [{ active: true, run: placing, whileTyping: true }] }),
    );
    expect(placing).toHaveBeenCalledOnce();
  });

  it("lets a blocking layer swallow Escape and leaves handled events alone", () => {
    const below = vi.fn();
    const blocked = press({ key: "Escape" });
    routeShortcut(
      blocked,
      handlers({
        escape: [
          { active: true, run: vi.fn(), block: true },
          { active: true, run: below },
        ],
      }),
    );
    expect(below).not.toHaveBeenCalled();
    expect(blocked.defaultPrevented).toBe(false);

    const handled = press({ key: "Escape" });
    handled.preventDefault();
    routeShortcut(
      handled,
      handlers({ escape: [{ active: true, run: below }] }),
    );
    expect(below).not.toHaveBeenCalled();
  });

  it("adds feedback with Cmd/Ctrl+F, even from a field, but not in a dialog", () => {
    const h = handlers();
    routeShortcut(
      press({ key: "f", metaKey: true }, document.createElement("textarea")),
      h,
    );
    expect(h.addFeedback).toHaveBeenCalledOnce();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const input = dialog.appendChild(document.createElement("input"));
    routeShortcut(press({ key: "f", ctrlKey: true }, input), h);
    expect(h.addFeedback).toHaveBeenCalledOnce();
  });

  it("approves with Cmd+A only outside fields, and keeps select-all when nothing applies", () => {
    const h = handlers();
    routeShortcut(
      press({ key: "a", metaKey: true }, document.createElement("input")),
      h,
    );
    expect(h.approve).not.toHaveBeenCalled();
    const none = press({ key: "a", metaKey: true });
    routeShortcut(none, handlers({ approve: () => false }));
    expect(none.defaultPrevented).toBe(false);
    const ok = press({ key: "a", ctrlKey: true });
    routeShortcut(ok, h);
    expect(h.approve).toHaveBeenCalledOnce();
    expect(ok.defaultPrevented).toBe(true);
  });

  it("steps with arrows and brackets, but not while typing or with modifiers", () => {
    const h = handlers();
    routeShortcut(press({ key: "ArrowRight" }), h);
    routeShortcut(press({ key: "[" }), h);
    routeShortcut(press({ key: "ArrowLeft", altKey: true }), h);
    routeShortcut(
      press({ key: "ArrowLeft" }, document.createElement("input")),
      h,
    );
    expect(vi.mocked(h.step!).mock.calls).toEqual([[1], [-1]]);
  });

  it("shares one typing and dialog check", () => {
    expect(isTyping(document.createElement("select"))).toBe(true);
    expect(isTyping(document.body)).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    expect(inDialog(dialog.appendChild(document.createElement("button")))).toBe(
      true,
    );
    expect(inDialog(document.body)).toBe(false);
  });
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

beforeEach(async () => {
  window.history.replaceState(null, "", "#");
  api = await installFakeFeedbackApi();
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  await api.dispose();
});

async function enterFullscreen() {
  render(<App />);
  const bar = screen.getByRole("contentinfo", { name: "Review actions" });
  await waitFor(() =>
    expect(
      within(bar).getByRole("button", { name: "Add feedback" }),
    ).toBeEnabled(),
  );
  fireEvent.click(within(bar).getByRole("button", { name: "View fullscreen" }));
  expect(screen.getByTestId("fullscreen-review")).toBeInTheDocument();
  return screen.getByRole("button", { name: "Add feedback" });
}

function escape(target: Element | Window = window) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(target, event);
  return event;
}

describe("Escape in fullscreen (ux-6)", () => {
  it("keeps navigation on the edge and closes the feedback drawer before exiting", async () => {
    await enterFullscreen();
    expect(
      screen.queryByRole("button", { name: "Open navigation panel" }),
    ).toBeNull();
    const handle = screen.getByRole("button", { name: "Open feedback panel" });
    fireEvent.mouseEnter(handle.parentElement!);
    expect(handle).toHaveAttribute("aria-expanded", "true");
    expect(escape().defaultPrevented).toBe(true);
    expect(handle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("fullscreen-review")).toBeInTheDocument();
    escape();
    expect(screen.queryByTestId("fullscreen-review")).toBeNull();
  });

  it("cancels pin placement without leaving fullscreen", async () => {
    const add = await enterFullscreen();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    await waitFor(() => expect(add).toHaveAttribute("aria-pressed", "true"));
    escape();
    expect(add).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("fullscreen-review")).toBeInTheDocument();
  });

  it("leaves the drawer open when Escape is pressed while typing a note", async () => {
    const add = await enterFullscreen();
    fireEvent.click(add);
    const frame = screen.getByTestId("screen-frame");
    frame.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 700 }) as DOMRect;
    fireEvent.click(frame, { clientX: 500, clientY: 350 });
    const note = screen.getByRole("textbox", { name: "Feedback note" });
    note.focus();
    const handle = screen.getByRole("button", { name: "Open feedback panel" });
    expect(handle).toHaveAttribute("aria-expanded", "true");
    escape(note);
    expect(handle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("fullscreen-review")).toBeInTheDocument();
    expect(note).toBeInTheDocument();
  });
});

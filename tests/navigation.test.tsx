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

// The workbench renders once the project list has loaded.
async function renderApp() {
  render(<App />);
  await screen.findByRole("contentinfo", { name: "Review actions" });
}

function actionBar() {
  return screen.getByRole("contentinfo", { name: "Review actions" });
}

describe("action bar", () => {
  it("keeps Add feedback in the fixed footer, not the side panel", async () => {
    await renderApp();
    const add = within(actionBar()).getByRole("button", {
      name: "Add feedback",
    });
    await waitFor(() => expect(add).toBeEnabled());
    expect(
      within(
        screen.getByRole("complementary", { name: "Feedback inspector" }),
      ).queryByRole("button", { name: "Add feedback" }),
    ).toBeNull();
  });

  it("toggles fullscreen from the bottom-left of the footer", async () => {
    await renderApp();
    const view = within(actionBar()).getByRole("button", {
      name: "View fullscreen",
    });
    expect(view.closest(".action-bar-start")).not.toBeNull();
    fireEvent.click(view);
    const exit = await within(actionBar()).findByRole("button", {
      name: "Exit fullscreen",
    });
    expect(exit.closest(".action-bar-start")).not.toBeNull();
    fireEvent.click(exit);
    expect(
      await within(actionBar()).findByRole("button", {
        name: "View fullscreen",
      }),
    ).toBeVisible();
  });

  it("shows the collapsed rail in fullscreen and expands it on hover", async () => {
    await renderApp();
    fireEvent.click(
      within(actionBar()).getByRole("button", { name: "View fullscreen" }),
    );
    await within(actionBar()).findByRole("button", { name: "Exit fullscreen" });
    const rail = document.querySelector(".fullscreen-rail .screen-rail")!;
    expect(rail).toHaveAttribute("data-mode", "compact");
    expect(rail).toHaveAttribute("data-expanded", "false");
    // ds-28: the corner cell holds the expand control instead of sitting empty.
    expect(
      within(rail as HTMLElement).getByRole("button", {
        name: "Expand screen index",
      }),
    ).toBeInTheDocument();
    fireEvent.mouseEnter(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
    fireEvent.mouseLeave(rail);
    expect(rail).toHaveAttribute("data-expanded", "false");
    fireEvent.click(
      within(actionBar()).getByRole("button", { name: "Exit fullscreen" }),
    );
    // The normal view keeps its own rail mode.
    expect(
      await screen.findByRole("button", { name: "Collapse screen index" }),
    ).toBeVisible();
  });

  it("centres screen navigation in the footer", async () => {
    await renderApp();
    const nav = within(actionBar()).getByRole("button", {
      name: "Next screen",
    });
    expect(nav.closest(".action-bar-nav")?.parentElement).toBe(actionBar());
    expect(actionBar().children[1]).toBe(nav.closest(".action-bar-nav"));
  });

  it("starts a pin with Cmd+F or Ctrl+F instead of the browser find bar", async () => {
    await renderApp();
    const add = within(actionBar()).getByRole("button", {
      name: "Add feedback",
    });
    await waitFor(() => expect(add).toBeEnabled());

    const meta = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(true);
    await waitFor(() => expect(add).toHaveAttribute("aria-pressed", "true"));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(add).toHaveAttribute("aria-pressed", "false"));
    fireEvent.keyDown(window, { key: "F", ctrlKey: true });
    await waitFor(() => expect(add).toHaveAttribute("aria-pressed", "true"));
  });

  it("steps through screens with Prev/Next and the arrow keys", async () => {
    await renderApp();
    const bar = actionBar();
    const prev = within(bar).getByRole("button", { name: "Previous screen" });
    const next = within(bar).getByRole("button", { name: "Next screen" });
    expect(bar).toHaveTextContent("01 / 3");
    expect(prev).toBeDisabled();

    fireEvent.click(next);
    expect(bar).toHaveTextContent("02 / 3 Session bootstrap");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(bar).toHaveTextContent("03 / 3 Populated dashboard");
    expect(next).toBeDisabled();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(bar).toHaveTextContent("02 / 3");
    await waitFor(() =>
      expect(window.location.hash).toContain("screen=bootstrap"),
    );
  });

  it("does not change screens while typing a note", async () => {
    await renderApp();
    const add = within(actionBar()).getByRole("button", {
      name: "Add feedback",
    });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    const frame = screen.getByTestId("screen-frame");
    Object.defineProperty(frame, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.click(frame, { clientX: 400, clientY: 300 });
    const note = screen.getByRole("textbox", { name: "Feedback note" });
    fireEvent.keyDown(note, { key: "ArrowRight" });
    expect(actionBar()).toHaveTextContent("01 / 3");
  });

  it("opens the screen named in the address", async () => {
    window.history.replaceState(null, "", "#project=example&screen=dashboard");
    await renderApp();
    await waitFor(() =>
      expect(actionBar()).toHaveTextContent("03 / 3 Populated dashboard"),
    );
  });
});

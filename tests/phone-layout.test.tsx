import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, PHONE_QUERY } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

beforeEach(async () => {
  window.history.replaceState(null, "", "#screen=landing");
  api = await installFakeFeedbackApi();
  await api.storage.importFeedback("example", [
    {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "example",
      screenId: "landing",
      version: "live",
      tags: [],
      status: "OPEN",
      x: 0.5,
      y: 0.5,
      note: "Tighten the hero",
      createdAt: "2026-10-05T19:00:00.000Z",
      updatedAt: "2026-10-05T19:00:00.000Z",
    },
  ] as never);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PHONE_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  await api.dispose();
});

const bar = () => screen.getByRole("contentinfo", { name: "Review actions" });
const workspace = () =>
  screen.getByRole("region", { name: "Review workspace" });

async function ready() {
  render(<App />);
  await screen.findByRole("contentinfo", { name: "Review actions" });
  await waitFor(() =>
    expect(
      within(bar()).getByRole("button", { name: "Add feedback" }),
    ).toBeEnabled(),
  );
}

describe("phone layout (ds-25)", () => {
  it("opens the feedback list as a sheet from a counted button", async () => {
    await ready();
    const open = within(bar()).getByRole("button", { name: /^Feedback/ });
    await waitFor(() => expect(open).toHaveTextContent("Feedback1"));
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(workspace()).toHaveAttribute("data-sheet-open", "false");

    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(workspace()).toHaveAttribute("data-sheet-open", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(workspace()).toHaveAttribute("data-sheet-open", "false");

    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Close feedback" }));
    expect(workspace()).toHaveAttribute("data-sheet-open", "false");
  });

  it("closes the sheet to place a pin and reopens it for the note", async () => {
    await ready();
    fireEvent.click(within(bar()).getByRole("button", { name: /^Feedback/ }));
    fireEvent.click(
      within(bar()).getByRole("button", { name: "Add feedback" }),
    );
    expect(workspace()).toHaveAttribute("data-sheet-open", "false");
    const frame = screen.getByTestId("screen-frame");
    frame.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 700 }) as DOMRect;
    fireEvent.click(frame, { clientX: 500, clientY: 350 });
    expect(workspace()).toHaveAttribute("data-sheet-open", "true");
  });

  it("moves Export and fullscreen into a menu", async () => {
    await ready();
    const more = within(bar()).getByRole("button", { name: "More actions" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More actions" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Export…",
      "View fullscreen",
      "Your name…",
    ]);
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export…" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the screen counter between icon-sized Prev and Next", async () => {
    await ready();
    const prev = within(bar()).getByRole("button", { name: "Previous screen" });
    expect(prev.querySelector(".action-bar-nav-label")).toHaveTextContent(
      "Prev",
    );
    expect(bar().querySelector(".action-bar-place strong")).toHaveTextContent(
      /^1\/\d+$/,
    );
  });
});

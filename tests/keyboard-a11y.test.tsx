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

async function ready() {
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add feedback" })).toBeEnabled(),
  );
}

describe("screen rail tab stops (ux-14)", () => {
  it("makes only the current row tabbable and moves the stop with selection", async () => {
    await ready();
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    const rows = within(rail)
      .getAllByRole("button")
      .filter((button) => button.dataset.screenId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    await waitFor(() =>
      expect(rows[1]).toHaveAttribute("aria-current", "page"),
    );
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("skip links focus the capture and the feedback panel without touching the URL", async () => {
    await ready();
    await waitFor(() => expect(window.location.hash).toContain("screen="));
    const hash = window.location.hash;
    fireEvent.click(screen.getByRole("link", { name: "Skip to capture" }));
    expect(screen.getByTestId("canvas")).toHaveFocus();
    fireEvent.click(screen.getByRole("link", { name: "Skip to feedback" }));
    expect(
      screen.getByRole("complementary", { name: "Feedback inspector" }),
    ).toHaveFocus();
    expect(window.location.hash).toBe(hash);
  });
});

describe("keyboard pin placement (ux-8)", () => {
  it("places a pin with the arrow keys and Enter without changing screens", async () => {
    await ready();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const frame = screen.getByTestId("screen-frame");
    await waitFor(() => expect(frame).toHaveFocus());
    expect(frame).toHaveAccessibleName(/Place a pin at 50% across, 50% down/);

    for (let i = 0; i < 3; i += 1)
      fireEvent.keyDown(frame, { key: "ArrowRight" });
    fireEvent.keyDown(frame, { key: "ArrowDown", shiftKey: true });
    expect(frame).toHaveAccessibleName(/53% across, 60% down/);
    expect(
      screen.getByRole("contentinfo", { name: "Review actions" }),
    ).toHaveTextContent("1/3");

    fireEvent.keyDown(frame, { key: "Enter" });
    const note = await screen.findByRole("textbox", { name: "Feedback note" });
    await waitFor(() => expect(note).toHaveFocus());
    fireEvent.change(note, { target: { value: "Keyboard pin." } });
    await waitFor(
      async () =>
        expect(await api.storage.listFeedback("example")).toEqual([
          expect.objectContaining({ note: "Keyboard pin.", x: 0.53, y: 0.6 }),
        ]),
      { timeout: 3000 },
    );
  });

  it("offers a comment on the whole screen", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Comment on whole screen" }),
    );
    const note = await screen.findByRole("textbox", { name: "Feedback note" });
    fireEvent.change(note, { target: { value: "Whole screen." } });
    await waitFor(
      async () =>
        expect(await api.storage.listFeedback("example")).toEqual([
          expect.objectContaining({ x: 0.02, y: 0.02 }),
        ]),
      { timeout: 3000 },
    );
  });
});

describe("panel semantics (ux-22)", () => {
  it("has no nested banner and nests rail group headings under the index", async () => {
    await ready();
    expect(
      within(
        screen.getByRole("complementary", { name: "Feedback inspector" }),
      ).queryByRole("banner"),
    ).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    expect(
      within(rail).getByRole("heading", { level: 2, name: "Screen index" }),
    ).toBeInTheDocument();
    expect(within(rail).getAllByRole("heading", { level: 3 }).length).toBe(
      within(rail).queryAllByRole("heading").length - 1,
    );
  });

  it("names the fullscreen handle once and reports state with aria-expanded", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "View fullscreen" }));
    const handle = screen.getByRole("button", { name: "Feedback panel" });
    expect(handle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(handle);
    expect(
      screen.getByRole("button", { name: "Feedback panel" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

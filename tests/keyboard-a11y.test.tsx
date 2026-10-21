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

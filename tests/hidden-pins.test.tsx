import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App, readHiddenPinStatuses } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

const base = {
  projectId: "example",
  screenId: "landing",
  version: "live",
  tags: ["P1"],
  createdAt: "2026-10-05T19:00:00.000Z",
  updatedAt: "2026-10-05T19:00:00.000Z",
};
const open = {
  ...base,
  id: "11111111-1111-4111-8111-111111111111",
  x: 0.2,
  y: 0.2,
  note: "Still open.",
  status: "OPEN",
};
const fixed = {
  ...base,
  id: "22222222-2222-4222-8222-222222222222",
  x: 0.6,
  y: 0.6,
  note: "Already fixed.",
  status: "RESOLVED",
};

beforeEach(async () => {
  api = await installFakeFeedbackApi();
  await api.storage.importFeedback("example", [open, fixed] as never);
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await api.dispose();
});

function pinLabels() {
  return screen
    .queryAllByTestId("feedback-pin")
    .map((pin) => pin.getAttribute("aria-label"));
}

describe("hiding pins by section", () => {
  it("hides fixed pins by default but keeps their cards", async () => {
    render(<App />);
    expect(await screen.findByText("Already fixed.")).toBeInTheDocument();

    await waitFor(() => expect(pinLabels()).toEqual(["Pin 1: Still open."]));
    expect(
      screen.getByRole("button", { name: "Show Fixed pins" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Show Backlog pins" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles a section's pins and remembers the choice", async () => {
    const first = render(<App />);
    await screen.findByText("Already fixed.");

    fireEvent.click(screen.getByRole("button", { name: "Show Fixed pins" }));
    await waitFor(() => expect(pinLabels()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Show Backlog pins" }));
    await waitFor(() =>
      expect(pinLabels()).toEqual(["Pin 2 (fixed): Already fixed."]),
    );

    first.unmount();
    render(<App />);
    await screen.findByText("Already fixed.");
    await waitFor(() =>
      expect(pinLabels()).toEqual(["Pin 2 (fixed): Already fixed."]),
    );
  });

  it("still shows a hidden pin while its card is selected", async () => {
    render(<App />);
    const card = await screen.findByText("Already fixed.");
    fireEvent.click(card);

    await waitFor(() =>
      expect(pinLabels()).toContain("Pin 2 (fixed): Already fixed."),
    );
  });

  it("falls back to hiding fixed pins when storage is unreadable", () => {
    localStorage.setItem("screencheck:hidden-pin-statuses", "{broken");
    expect(readHiddenPinStatuses()).toEqual(["RESOLVED", "VERIFIED"]);
    localStorage.setItem(
      "screencheck:hidden-pin-statuses",
      JSON.stringify(["OPEN", "nonsense"]),
    );
    // A list saved before Verified existed keeps its choices and hides
    // Verified by default.
    expect(readHiddenPinStatuses()).toEqual(["OPEN", "VERIFIED"]);
  });
});

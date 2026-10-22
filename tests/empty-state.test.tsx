import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

const base = {
  projectId: "example",
  version: "live",
  tags: [],
  status: "OPEN",
  x: 0.5,
  y: 0.5,
  createdAt: "2026-10-05T19:00:00.000Z",
  updatedAt: "2026-10-05T19:00:00.000Z",
};

beforeEach(async () => {
  window.history.replaceState(null, "", "#screen=landing");
  api = await installFakeFeedbackApi();
  await api.storage.importFeedback("example", [
    {
      ...base,
      id: "11111111-1111-4111-8111-111111111111",
      screenId: "dashboard",
      note: "One",
    },
    {
      ...base,
      id: "22222222-2222-4222-8222-222222222222",
      screenId: "dashboard",
      note: "Two",
    },
  ] as never);
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  await api.dispose();
});

describe("feedback zero state (ds-30)", () => {
  it("offers an inline add and jumps to the next screen with open items", async () => {
    render(<App />);
    const empty = await screen.findByRole("region", {
      name: "No feedback yet",
    });
    await waitFor(() =>
      expect(empty).toHaveTextContent("2 open across 1 screen"),
    );

    const add = screen.getByRole("button", {
      name: "Add feedback to this screen",
    });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    expect(
      screen.getByRole("button", { name: "Add feedback" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(
      screen.getByRole("button", { name: "Next: 03 Populated dashboard" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toContain("screen=dashboard"),
    );
  });
});

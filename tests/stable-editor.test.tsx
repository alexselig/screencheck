import {
  act,
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

beforeEach(async () => {
  api = await installFakeFeedbackApi();
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await api.dispose();
});

async function startPin() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add feedback" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
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
  const box = screen.getByRole("textbox", { name: "Feedback note" });
  box.focus();
  return box;
}

function type(box: HTMLElement, value: string) {
  fireEvent.change(box, { target: { value } });
}

const wait = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("typing feedback keeps the same input", () => {
  it("keeps the note box and focus when a new pin autosaves", async () => {
    render(<App />);
    const box = await startPin();
    type(box, "First thought");

    await screen.findByTestId("feedback-pin", {}, { timeout: 2000 });
    expect(screen.getByRole("textbox", { name: "Feedback note" })).toBe(box);
    expect(document.activeElement).toBe(box);
  });

  it("does not move the card while its priority or status changes", async () => {
    render(<App />);
    const box = await startPin();
    type(box, "Retag me");
    await screen.findByTestId("feedback-pin", {}, { timeout: 2000 });

    fireEvent.click(screen.getByRole("button", { name: "P0" }));
    box.focus();
    await wait(700);
    expect(screen.getByRole("textbox", { name: "Feedback note" })).toBe(box);
    expect(document.activeElement).toBe(box);
    const [saved] = await api.storage.listFeedback("example");
    expect(saved.tags).toContain("P0");

    // A fresh comment stays in Backlog with no status picker until reopened.
    expect(
      screen.queryByRole("combobox", { name: "Feedback status" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Collapse comment/ }));
    fireEvent.click(
      await screen.findByText("Retag me", {
        selector: ".feedback-comment strong",
      }),
    );
    const reopened = await screen.findByRole("textbox", {
      name: "Feedback note",
    });

    fireEvent.change(
      screen.getByRole("combobox", { name: "Feedback status" }),
      {
        target: { value: "IN_PROGRESS" },
      },
    );
    await wait(300);
    expect(screen.getByRole("textbox", { name: "Feedback note" })).toBe(
      reopened,
    );
    const backlog = reopened.closest("section.feedback-section")!;
    expect(backlog).toHaveAttribute("aria-label", "Backlog");
    // ux-21: the held slot says where the comment goes and the old section
    // stops counting it.
    await screen.findByText("Moves to In progress · P0 when closed");
    expect(
      backlog.querySelector(".feedback-section-toggle .feedback-count"),
    ).toHaveTextContent("0");
    expect(
      backlog.querySelector(".feedback-group-title .feedback-count"),
    ).toHaveTextContent("0");

    fireEvent.click(screen.getByRole("button", { name: /^Collapse comment/ }));
    const card = await screen.findByText("Retag me", {
      selector: ".feedback-comment strong",
    });
    expect(card.closest("[role=group]")).toHaveAttribute(
      "aria-label",
      "In progress P0",
    );
  });

  it("creates one pin even when typing continues during the first save", async () => {
    render(<App />);
    const box = await startPin();
    for (const value of ["a", "ab", "abc", "abcd"]) {
      type(box, value);
      await wait(520);
    }
    await wait(700);

    const records = await api.storage.listFeedback("example");
    expect(records).toHaveLength(1);
    expect(records[0].note).toBe("abcd");
    expect(screen.getByRole("textbox", { name: "Feedback note" })).toBe(box);
  });
});

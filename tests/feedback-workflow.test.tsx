import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

function fakeRect(element: HTMLElement) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 100,
      top: 50,
      width: 800,
      height: 600,
      right: 900,
      bottom: 650,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    }),
  });
}

async function addFeedbackAtCentre(note: string) {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add feedback" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
  const frame = screen.getByTestId("screen-frame");
  fakeRect(frame);
  fireEvent.click(frame, { clientX: 500, clientY: 350 });
  fireEvent.change(screen.getByRole("textbox", { name: "Feedback note" }), {
    target: { value: note },
  });
}

describe("feedback workflow integration", () => {
  it("places a normalized pin, saves it to disk, and reloads it from the server", async () => {
    const firstRender = render(<App />);
    await addFeedbackAtCentre("Keep this action above the fold.");

    const pin = await screen.findByTestId(
      "feedback-pin",
      {},
      { timeout: 2000 },
    );
    expect(pin).toHaveStyle({ left: "50%", top: "50%" });
    const onDisk = await readFile(
      join(api.root, "example", "feedback.json"),
      "utf8",
    );
    expect(onDisk).toContain("Keep this action above the fold.");
    expect(localStorage.getItem("screencheck.feedback.v1:example")).toBeNull();

    firstRender.unmount();
    render(<App />);

    expect(
      await screen.findByText("Keep this action above the fold."),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("feedback-pin")).toHaveStyle({
      left: "50%",
      top: "50%",
    });
  });

  it("numbers each comment with the same dot as its pin", async () => {
    render(<App />);
    await addFeedbackAtCentre("First note.");
    await screen.findByTestId("feedback-pin", {}, { timeout: 2000 });

    const pin = screen.getByTestId("feedback-pin");
    const cardDot = screen.getByLabelText("Pin 1", {
      selector: ".feedback-list .pin-dot",
    });
    expect(pin).toHaveTextContent("1");
    expect(cardDot).toHaveTextContent("1");
    expect(pin).toHaveClass("pin-dot");
    expect(cardDot.className).toBe(pin.className.replace("feedback-pin ", ""));
  });

  it("edits a comment in place instead of listing it twice", async () => {
    render(<App />);
    await addFeedbackAtCentre("Only once.");
    await screen.findByTestId("feedback-pin", {}, { timeout: 2000 });
    const list = screen.getByRole("complementary", {
      name: "Feedback inspector",
    });
    expect(list.querySelectorAll(".feedback-list > li")).toHaveLength(1);
    expect(
      screen.queryByText("Only once.", {
        selector: ".feedback-comment-note",
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Feedback editor" })
        .closest(".feedback-list"),
    ).not.toBeNull();
  });

  it("guides an empty screen and shows a cancellable pin mode", async () => {
    render(<App />);
    expect(
      await screen.findByText(/No feedback on this screen yet/),
    ).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add feedback" });
    await waitFor(() => expect(add).toBeEnabled());

    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(/Click the screen to place a pin/),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(add).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/Click the screen to place a pin/)).toBeNull();
  });

  it("shows a load error with retry instead of an empty review", async () => {
    api.failNext(
      500,
      "feedback.json contains invalid JSON; restore or repair it.",
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid JSON/);
    expect(screen.getByRole("button", { name: "Add feedback" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add feedback" }),
      ).toBeEnabled(),
    );
  });
});

describe("legacy browser feedback migration", () => {
  const legacy = {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: "example",
    screenId: "landing",
    version: "live",
    x: 0.25,
    y: 0.25,
    note: "Saved before the server existed.",
    tags: ["P1"],
    status: "OPEN",
    createdAt: "2026-10-05T19:00:00.000Z",
    updatedAt: "2026-10-05T19:00:00.000Z",
  };
  const key = "screencheck.feedback.v1:example";

  it("moves browser-only feedback to disk and then clears the browser copy", async () => {
    localStorage.setItem(key, JSON.stringify([legacy]));
    render(<App />);

    expect(await screen.findByText(legacy.note)).toBeInTheDocument();
    expect(await api.storage.listFeedback("example")).toEqual([
      { ...legacy, thread: [] },
    ]);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("leaves unreadable browser feedback untouched and says so", async () => {
    localStorage.setItem(key, "{broken");
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /left untouched/,
    );
    expect(localStorage.getItem(key)).toBe("{broken");
  });

  it("keeps the browser copy when some records cannot be imported", async () => {
    localStorage.setItem(key, JSON.stringify([legacy, { id: "bad" }]));
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/1 older/);
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(await api.storage.listFeedback("example")).toHaveLength(1);
  });

  it("saves a new pin explicitly and closes its editor (ds-31)", async () => {
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add feedback" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
    const frame = screen.getByTestId("screen-frame");
    fakeRect(frame);
    fireEvent.click(frame, { clientX: 500, clientY: 350 });

    const save = screen.getByRole("button", { name: "Save pin" });
    expect(save).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback note" }), {
      target: { value: "Saved on purpose." },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Feedback editor" }),
      ).toBeNull(),
    );
    expect(await screen.findByTestId("feedback-pin")).toBeInTheDocument();
    expect(
      screen.getByText("Saved on purpose.", {
        selector: ".feedback-comment-note",
      }),
    ).toBeInTheDocument();
  });
});

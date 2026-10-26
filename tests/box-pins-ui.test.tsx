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

// jsdom has no PointerEvent; a MouseEvent carrying the pointer fields will do.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}
if (!("PointerEvent" in window)) {
  Object.assign(window, { PointerEvent: FakePointerEvent });
}

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

async function startAdding() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add feedback" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
  const frame = screen.getByTestId("screen-frame");
  fakeRect(frame);
  return frame;
}

function gesture(
  frame: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const base = {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  };
  fireEvent.pointerDown(frame, { ...base, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(frame, { ...base, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(frame, { ...base, clientX: to.x, clientY: to.y });
  fireEvent.click(frame, { clientX: to.x, clientY: to.y });
}

async function save(note: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Feedback note" }), {
    target: { value: note },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
  return screen.findByTestId("feedback-pin", {}, { timeout: 2000 });
}

describe("box pins", () => {
  it("draws a box when the pointer drags more than 6px", async () => {
    render(<App />);
    const frame = await startAdding();
    // 100,50 is the frame's top-left; drag 20%..60% across, 10%..40% down.
    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
      clientX: 260,
      clientY: 110,
    });
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
      clientX: 580,
      clientY: 290,
    });
    expect(screen.getByTestId("pin-box-preview")).toHaveStyle({
      left: "20%",
      top: "10%",
      width: "40%",
      height: "30%",
    });
    fireEvent.pointerUp(frame, {
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
      clientX: 580,
      clientY: 290,
    });
    fireEvent.click(frame, { clientX: 580, clientY: 290 });
    expect(screen.queryByTestId("pin-box-preview")).toBeNull();
    expect(screen.getByTestId("draft-pin")).toHaveStyle({
      left: "20%",
      top: "10%",
    });
    expect(screen.getByTestId("draft-box")).toHaveStyle({
      left: "20%",
      top: "10%",
      width: "40%",
      height: "30%",
    });

    const pin = await save("This whole card.");
    // The badge sits on the box's top-left corner and stays the focus target.
    expect(pin).toHaveStyle({ left: "20%", top: "10%" });
    expect(pin.tagName).toBe("BUTTON");
    const box = screen.getByTestId("feedback-box");
    expect(box).toHaveStyle({
      left: "20%",
      top: "10%",
      width: "40%",
      height: "30%",
    });
    expect(box).toHaveAttribute("aria-hidden", "true");

    const onDisk = JSON.parse(
      await readFile(join(api.root, "example", "feedback.json"), "utf8"),
    );
    expect(onDisk.feedback[0]).toMatchObject({
      x: 0.4,
      y: 0.25,
      box: { x: 0.2, y: 0.1, w: 0.4, h: 0.3 },
    });

    fireEvent.click(pin);
    expect(screen.getByTestId("feedback-box")).toHaveClass("is-selected");
  });

  it("still drops a point pin when the pointer moves 6px or less", async () => {
    render(<App />);
    const frame = await startAdding();
    gesture(frame, { x: 500, y: 350 }, { x: 500, y: 356 });
    expect(screen.queryByTestId("draft-box")).toBeNull();
    const pin = await save("Just here.");
    expect(pin).toHaveStyle({ left: "50%", top: "51%" });
    expect(screen.queryByTestId("feedback-box")).toBeNull();
    const onDisk = JSON.parse(
      await readFile(join(api.root, "example", "feedback.json"), "utf8"),
    );
    expect(onDisk.feedback[0]).not.toHaveProperty("box");
  });

  it("does not draw boxes outside place-pin mode", async () => {
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add feedback" }),
      ).toBeEnabled(),
    );
    const frame = screen.getByTestId("screen-frame");
    fakeRect(frame);
    gesture(frame, { x: 200, y: 100 }, { x: 600, y: 400 });
    expect(screen.queryByTestId("draft-pin")).toBeNull();
    expect(screen.queryByTestId("pin-box-preview")).toBeNull();
  });
});

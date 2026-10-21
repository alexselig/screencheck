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

const base = {
  projectId: "example",
  screenId: "landing",
  version: "live",
  tags: ["P1"],
  status: "OPEN",
  createdAt: "2026-10-05T19:00:00.000Z",
  updatedAt: "2026-10-05T19:00:00.000Z",
};
const aId = "11111111-1111-4111-8111-111111111111";
const bId = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  window.history.replaceState(null, "", "#");
  api = await installFakeFeedbackApi();
  await api.storage.importFeedback("example", [
    { ...base, id: aId, x: 0.2, y: 0.2, note: "A original" },
    {
      ...base,
      id: bId,
      x: 0.6,
      y: 0.6,
      note: "B original",
      createdAt: "2026-10-05T19:01:00.000Z",
    },
  ] as never);
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  await api.dispose();
});

async function stored(id: string) {
  return (await api.storage.listFeedback("example")).find(
    (item) => item.id === id,
  )!;
}

async function openCard(note: string) {
  const card = await screen.findByText(note, {
    selector: ".feedback-comment-note",
  });
  fireEvent.click(card.closest("button")!);
  return screen.getByRole("textbox", { name: "Feedback note" });
}

function pause(ms: number) {
  return act(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

describe("note autosave target", () => {
  it("saves an edit to the comment it was typed in, even after switching to another", async () => {
    render(<App />);
    const note = await openCard("B original");
    fireEvent.change(note, { target: { value: "B original EDITED" } });
    // Switch to A inside the 500 ms debounce window.
    await openCard("A original");

    await waitFor(async () =>
      expect((await stored(bId)).note).toBe("B original EDITED"),
    );
    await pause(700);
    expect((await stored(aId)).note).toBe("A original");
    expect((await stored(bId)).note).toBe("B original EDITED");
  });

  it("sends a pending edit when Cmd+F starts a new pin", async () => {
    render(<App />);
    const note = await openCard("A original");
    fireEvent.change(note, { target: { value: "A original typed" } });
    fireEvent.keyDown(window, { key: "f", metaKey: true });

    await waitFor(async () =>
      expect((await stored(aId)).note).toBe("A original typed"),
    );
  });

  it("sends a pending edit when the rail moves to another screen", async () => {
    render(<App />);
    const note = await openCard("A original");
    fireEvent.change(note, { target: { value: "A before leaving" } });
    fireEvent.click(
      screen.getByRole("button", { name: /^02\. Session bootstrap/ }),
    );

    await waitFor(async () =>
      expect((await stored(aId)).note).toBe("A before leaving"),
    );
  });

  it("sends a pending edit when Next moves to another screen", async () => {
    render(<App />);
    const note = await openCard("B original");
    fireEvent.change(note, { target: { value: "B before next" } });
    fireEvent.click(screen.getByRole("button", { name: "Next screen" }));

    await waitFor(async () =>
      expect((await stored(bId)).note).toBe("B before next"),
    );
    expect((await stored(aId)).note).toBe("A original");
  });
});

describe("status change failure", () => {
  it("puts the old status back when the PATCH fails, and Retry resends it", async () => {
    render(<App />);
    await openCard("A original");
    const status = screen.getByRole("combobox", { name: "Feedback status" });
    api.failNext(500, "Disk full.");
    fireEvent.change(status, { target: { value: "IN_PROGRESS" } });

    await screen.findByText(/Status not changed/);
    expect(status).toHaveValue("OPEN");
    expect((await stored(aId)).status).toBe("OPEN");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(async () =>
      expect((await stored(aId)).status).toBe("IN_PROGRESS"),
    );
    await waitFor(() => expect(status).toHaveValue("IN_PROGRESS"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

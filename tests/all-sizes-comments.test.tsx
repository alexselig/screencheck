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
import { feedbackAtSize } from "../src/client/all-sizes";
import { sizesOf } from "../src/client/sizes";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import type { FeedbackRecord } from "../src/shared/feedback";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

const PROJECT = {
  ...EXAMPLE_PROJECT,
  versions: ["web-1440", "web-390", "web-768"],
  versionDetails: [
    { id: "web-1440", revision: "web", label: "1440" },
    { id: "web-390", revision: "web", label: "390" },
    { id: "web-768", revision: "web", label: "768" },
  ],
  screens: EXAMPLE_PROJECT.screens.map((item) => ({
    ...item,
    hasCapture: true,
  })),
};
const FIRST = PROJECT.screens[0]!;

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;
let installed = false;

beforeEach(() => {
  window.history.replaceState(null, "", "#");
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  if (installed) await api.dispose();
  installed = false;
});

async function install(project?: typeof PROJECT) {
  api = await installFakeFeedbackApi(project);
  installed = true;
}

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

async function placeDraft() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add feedback" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
  const frame = screen.getByTestId("screen-frame");
  fakeRect(frame);
  fireEvent.click(frame, { clientX: 500, clientY: 350 });
  return screen.findByRole("textbox", { name: "Feedback note" });
}

function seed(version: string, fields: Record<string, unknown> = {}) {
  return api.storage.createFeedback("example", {
    clientMutationId: crypto.randomUUID(),
    screenId: FIRST.id,
    version,
    x: 0.25,
    y: 0.5,
    note: `Seeded at ${version}`,
    tags: [],
    status: "OPEN",
    ...fields,
  });
}

function rail() {
  return screen.getByRole("navigation", { name: "Screen navigation" });
}

describe("all-sizes projection", () => {
  it("shows an all-sizes comment on sibling sizes only", () => {
    const sizes = sizesOf(["a-1440", "a-390"], (id) => id.slice(2));
    const base = {
      projectId: "p",
      screenId: "s",
      x: 0.5,
      y: 0.5,
      note: "",
      tags: [],
      status: "OPEN",
      createdAt: "",
      updatedAt: "",
    };
    const records = [
      { ...base, id: "all", version: "a-1440", scope: "all" },
      { ...base, id: "one", version: "a-1440" },
      { ...base, id: "elsewhere", version: "b-1440", scope: "all" },
    ] as FeedbackRecord[];
    const shown = feedbackAtSize(records, sizes, "a-390");
    expect(shown.find((item) => item.id === "all")).toMatchObject({
      version: "a-390",
      pinnedAt: "1440",
    });
    expect(shown.find((item) => item.id === "one")?.version).toBe("a-1440");
    expect(shown.find((item) => item.id === "elsewhere")?.version).toBe(
      "b-1440",
    );
    expect(feedbackAtSize(records, sizes, "a-1440")).toEqual(records);
    expect(feedbackAtSize(records, sizes.slice(0, 1), "a-390")).toEqual(
      records,
    );
  });
});

describe("comments that cover every size", () => {
  it("offers This size / All sizes only when the revision has several sizes", async () => {
    await install();
    render(<App />);
    await placeDraft();
    expect(
      screen.queryByRole("group", { name: "Comment applies to" }),
    ).toBeNull();
  });

  it("defaults to This size and saves an All sizes comment once", async () => {
    await install(PROJECT);
    render(<App />);
    await placeDraft();
    const choice = screen.getByRole("group", { name: "Comment applies to" });
    expect(
      within(choice).getByRole("button", { name: "This size" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(choice).getByRole("button", { name: "All sizes" }));
    expect(
      within(choice).getByRole("button", { name: "All sizes" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback note" }), {
      target: { value: "Logo is blurry everywhere" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    await waitFor(async () => {
      const saved = await api.storage.listFeedback("example");
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ version: "web-768", scope: "all" });
    });
  });

  it("shows it dashed on other sizes, says where it was pinned, and counts it once", async () => {
    await install(PROJECT);
    await seed("web-1440", { scope: "all", note: "Header overlaps" });
    render(<App />);
    // Opens at 768; the comment was pinned at 1440.
    const pin = await screen.findByTestId("feedback-pin");
    expect(pin).toHaveClass("is-other-size");
    expect(pin).toHaveAccessibleName("Pin 1: Header overlaps");
    expect(
      await screen.findByText("All sizes · Pinned at 1440"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(rail()).getByRole("button", {
          name: `01. ${FIRST.title}, 1 open`,
        }),
      ).toBeInTheDocument(),
    );

    // On its own size it is a normal pin and the card just says All sizes.
    const switcher = screen.getByRole("group", { name: "Screen size" });
    fireEvent.click(within(switcher).getByRole("button", { name: /^1440/ }));
    await waitFor(() =>
      expect(screen.getByTestId("feedback-pin")).not.toHaveClass(
        "is-other-size",
      ),
    );
    expect(screen.getByText("All sizes")).toBeInTheDocument();
    expect(screen.queryByText(/Pinned at/)).toBeNull();

    // Compare sizes shows it on every size, dashed off its own.
    fireEvent.click(screen.getByRole("button", { name: "Compare sizes" }));
    const view = screen.getByRole("region", { name: "Compare sizes" });
    const pins = within(view).getAllByTestId("compare-pin");
    expect(pins).toHaveLength(3);
    expect(
      pins.filter((item) => item.classList.contains("is-other-size")),
    ).toHaveLength(2);
  });

  it("flags a carried comment with Check placement until the reviewer confirms it", async () => {
    await install(PROJECT);
    const now = new Date().toISOString();
    await api.storage.importFeedback("example", [
      {
        id: "carried",
        projectId: "example",
        screenId: FIRST.id,
        version: "web-768",
        x: 0.4,
        y: 0.4,
        note: "Button label is cut off",
        tags: [],
        status: "OPEN",
        carriedFrom: ["old-768"],
        checkPlacement: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    render(<App />);
    const pin = await screen.findByTestId("feedback-pin");
    expect(pin).toHaveClass("needs-placement");
    expect(await screen.findByText("Check placement")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Placement OK for pin 1" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Check placement")).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("feedback-pin")).not.toHaveClass(
        "needs-placement",
      ),
    );
    const [saved] = await api.storage.listFeedback("example");
    expect(saved!.checkPlacement).toBeUndefined();
    expect(saved!.carriedFrom).toEqual(["old-768"]);
  });
});

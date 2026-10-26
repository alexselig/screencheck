import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import {
  listLabels,
  rollUpSizes,
  sizeName,
  sizesOf,
  sizeWidth,
} from "../src/client/sizes";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import type { FeedbackStatus } from "../src/shared/feedback";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

describe("sizes", () => {
  it("reads widths only from width-shaped labels and names their range", () => {
    expect(sizeWidth("390")).toBe(390);
    expect(sizeWidth("1440px")).toBe(1440);
    expect(sizeWidth("390 × 844")).toBe(390);
    expect(sizeWidth("build-2024")).toBeUndefined();
    expect(sizeWidth("Mobile")).toBeUndefined();
    expect(sizeName(390)).toBe("Phone");
    expect(sizeName(480)).toBe("Phone");
    expect(sizeName(768)).toBe("Tablet");
    expect(sizeName(1024)).toBe("Tablet");
    expect(sizeName(1440)).toBe("Desktop");
    expect(sizeName(undefined)).toBeUndefined();
  });

  it("orders sizes narrowest first", () => {
    const labels: Record<string, string> = {
      a: "1440",
      b: "390",
      c: "Mobile",
      d: "768",
    };
    expect(
      sizesOf(["a", "b", "c", "d"], (id) => labels[id]!).map(
        (size) => size.label,
      ),
    ).toEqual(["390", "768", "1440", "Mobile"]);
  });

  it("rolls badges and approval up across sizes", () => {
    const sizes = sizesOf(["w-1440", "w-390", "w-768"], (id) => id.slice(2));
    const record = (screenId: string, version: string, status = "OPEN") =>
      ({ screenId, version, status }) as never;
    const rollup = rollUpSizes(
      ["one", "two", "three"],
      sizes,
      [
        record("one", "w-390"),
        record("one", "w-1440"),
        record("one", "w-1440", "RESOLVED"),
        record("two", "other"),
      ],
      [
        { screenId: "one", version: "w-1440", approvedAt: "" },
        ...["w-390", "w-768", "w-1440"].map((version) => ({
          screenId: "two",
          version,
          approvedAt: "",
        })),
      ],
    );
    expect(rollup.openCounts.get("one")).toBe(2);
    expect(rollup.openCounts.get("two")).toBeUndefined();
    expect([...rollup.approvedIds]).toEqual(["two"]);
    expect(rollup.partialApprovals.get("one")).toBe(
      "Approved at 1440; 390 and 768 still to review",
    );
    expect(rollup.partialApprovals.has("three")).toBe(false);
    expect(listLabels(["390", "768", "1440"])).toBe("390, 768 and 1440");
  });
});

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
const [FIRST, SECOND] = PROJECT.screens;

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

function seed(
  screenId: string,
  version: string,
  status: FeedbackStatus = "OPEN",
) {
  return api.storage.createFeedback("example", {
    clientMutationId: crypto.randomUUID(),
    screenId,
    version,
    x: 0.5,
    y: 0.5,
    note: `${screenId} at ${version}`,
    tags: [],
    status,
  });
}

function approve(screenId: string, version: string) {
  return api.storage.setApproval("example", {
    screenId,
    version,
    approved: true,
  });
}

function rail() {
  return screen.getByRole("navigation", { name: "Screen navigation" });
}

async function capture() {
  return screen.findByRole("img", { name: /capture$/ });
}

describe("responsive review", () => {
  beforeEach(async () => {
    window.history.replaceState(null, "", "#");
    api = await installFakeFeedbackApi(PROJECT);
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    window.history.replaceState(null, "", "#");
    await api.dispose();
  });

  it("lists each screen once and counts open comments across sizes", async () => {
    await seed(FIRST!.id, "web-390");
    await seed(FIRST!.id, "web-1440");
    await seed(FIRST!.id, "web-768", "VERIFIED");
    render(<App />);
    await capture();
    const rows = within(rail()).getAllByRole("button", { name: /^\d\d\./ });
    expect(rows).toHaveLength(PROJECT.screens.length);
    expect(within(rail()).queryByRole("button", { name: /· 390/ })).toBeNull();
    await waitFor(() =>
      expect(
        within(rail()).getByRole("button", {
          name: `01. ${FIRST!.title}, 2 open`,
        }),
      ).toBeInTheDocument(),
    );
    // Only the Viewport filter is gone; nothing calls a size a resolution.
    expect(screen.queryByRole("combobox", { name: /Viewport/ })).toBeNull();
    expect(screen.queryByText(/Resolution/)).toBeNull();
  });

  it("marks partly approved screens and hides only fully approved ones", async () => {
    await approve(FIRST!.id, "web-1440");
    for (const version of PROJECT.versions) await approve(SECOND!.id, version);
    render(<App />);
    await capture();
    const partial = await within(rail()).findByRole("button", {
      name: /^01\..*\(Approved at 1440; 390 and 768 still to review\)/,
    });
    expect(partial).toHaveAttribute(
      "title",
      expect.stringContaining("Approved at 1440; 390 and 768 still to review"),
    );
    expect(within(partial).getByTestId("screen-partial-mark")).toBeTruthy();
    const full = within(rail()).getByRole("button", {
      name: /^02\..*\(approved\)/,
    });
    expect(within(full).getByTestId("screen-approved-mark")).toBeTruthy();

    fireEvent.click(
      within(rail()).getByRole("switch", { name: /Hide approved/ }),
    );
    const ids = within(rail())
      .getAllByRole("button")
      .map((button) => button.dataset.screenId)
      .filter(Boolean);
    expect(ids).toContain(FIRST!.id);
    expect(ids).not.toContain(SECOND!.id);
  });

  it("switches sizes with the switcher and Shift+arrows, keeping the size across screens", async () => {
    render(<App />);
    const image = await capture();
    const switcher = screen.getByRole("group", { name: "Screen size" });
    const buttons = within(switcher).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "390Phone",
      "768Tablet",
      "1440Desktop",
    ]);
    // Registration order picks the opening size, as before.
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
    expect(image.getAttribute("src")).toContain("web-768");

    fireEvent.click(buttons[0]!);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect((await capture()).getAttribute("src")).toContain("web-390");
    await waitFor(() =>
      expect(window.location.hash).toContain("version=web-390"),
    );

    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(buttons[2]).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");

    // Plain arrows step screens and keep the size.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(
      within(rail()).getByRole("button", { name: /^02\./ }),
    ).toHaveAttribute("aria-current", "page");
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(window.location.hash).toBe(
        `#project=example&version=web-768&screen=${SECOND!.id}`,
      ),
    );
    // The counter numbers screens as the index does, and names the size.
    const place = document.querySelector(".action-bar-place")!;
    expect(place).toHaveTextContent(`2/${PROJECT.screens.length}`);
    expect(place).toHaveAttribute(
      "aria-label",
      `Screen 2 of ${PROJECT.screens.length} at 768`,
    );
  });

  it("opens a linked size from the URL", async () => {
    window.history.replaceState(
      null,
      "",
      `#project=example&version=web-390&screen=${SECOND!.id}`,
    );
    render(<App />);
    expect((await capture()).getAttribute("src")).toContain("web-390");
    expect(
      within(screen.getByRole("group", { name: "Screen size" })).getByRole(
        "button",
        { name: "390 Phone" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("zooms between Fit and 100%", async () => {
    render(<App />);
    await capture();
    const zoom = screen.getByRole("group", { name: "Zoom" });
    const fit = within(zoom).getByRole("button", { name: "Fit" });
    const actual = within(zoom).getByRole("button", { name: "100%" });
    expect(fit).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-zoom", "fit");
    fireEvent.click(actual);
    expect(actual).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-zoom", "actual");
  });

  it("compares sizes side by side and opens the one clicked", async () => {
    await seed(FIRST!.id, "web-390");
    await seed(FIRST!.id, "web-390");
    await seed(FIRST!.id, "web-1440");
    render(<App />);
    await capture();
    fireEvent.click(screen.getByRole("button", { name: "Compare sizes" }));
    const view = screen.getByRole("region", { name: "Compare sizes" });
    const shots = within(view).getAllByRole("button", { name: /^Show / });
    expect(shots.map((shot) => shot.getAttribute("aria-label"))).toEqual([
      "Show 390 Phone",
      "Show 768 Tablet",
      "Show 1440 Desktop",
    ]);
    await waitFor(() =>
      expect(within(shots[0]!).getAllByTestId("compare-pin")).toHaveLength(2),
    );
    expect(within(shots[2]!).getAllByTestId("compare-pin")).toHaveLength(1);
    expect(shots[1]).toHaveAttribute("aria-current", "true");

    // Closing returns to the size you were on.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Compare sizes" })).toBeNull();
    expect((await capture()).getAttribute("src")).toContain("web-768");

    fireEvent.click(screen.getByRole("button", { name: "Compare sizes" }));
    fireEvent.click(screen.getByRole("button", { name: "Show 1440 Desktop" }));
    expect(screen.queryByRole("region", { name: "Compare sizes" })).toBeNull();
    expect((await capture()).getAttribute("src")).toContain("web-1440");
  });

  it("approves every size, asking first about unverified fixes", async () => {
    await seed(FIRST!.id, "web-390", "RESOLVED");
    render(<App />);
    await capture();
    const toggle = await screen.findByRole("button", {
      name: /Approve screen at 768/,
    });
    await waitFor(() => expect(toggle).toBeEnabled());

    // ⌘A approves only the size on screen.
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(async () =>
      expect(await api.storage.listApprovals("example")).toEqual([
        expect.objectContaining({ version: "web-768", screenId: FIRST!.id }),
      ]),
    );
    expect(
      await within(rail()).findByRole("button", {
        name: /^01\..*\(Approved at 768; 390 and 1440 still to review\)/,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve all sizes" }));
    const confirm = screen.getByRole("group", {
      name: "Confirm approval of all sizes",
    });
    expect(confirm).toHaveTextContent(
      "390: 1 fix not verified. Approve all anyway?",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(await api.storage.listApprovals("example")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Approve all sizes" }));
    fireEvent.click(
      within(
        screen.getByRole("group", { name: "Confirm approval of all sizes" }),
      ).getByRole("button", { name: "Approve" }),
    );
    await waitFor(async () =>
      expect(await api.storage.listApprovals("example")).toHaveLength(3),
    );
    expect(
      await screen.findByRole("button", { name: "All sizes approved" }),
    ).toBeDisabled();
    expect(
      within(rail()).getByRole("button", { name: /^01\..*\(approved\)/ }),
    ).toBeInTheDocument();
  });

  it("approves all sizes straight away when nothing is unverified", async () => {
    render(<App />);
    await capture();
    const all = await screen.findByRole("button", {
      name: "Approve all sizes",
    });
    await waitFor(() => expect(all).toBeEnabled());
    await act(async () => {
      fireEvent.click(all);
    });
    await waitFor(async () =>
      expect(await api.storage.listApprovals("example")).toHaveLength(3),
    );
  });
});

describe("before/after at a size", () => {
  beforeEach(async () => {
    window.history.replaceState(null, "", "#");
    api = await installFakeFeedbackApi({
      ...PROJECT,
      versions: ["b41-1440", "b41-390", "b42-390", "b42-1440"],
      versionDetails: [
        { id: "b41-1440", revision: "b41", label: "1440" },
        { id: "b41-390", revision: "b41", label: "390" },
        { id: "b42-390", revision: "b42", label: "390" },
        { id: "b42-1440", revision: "b42", label: "1440" },
      ],
    });
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    window.history.replaceState(null, "", "#");
    await api.dispose();
  });

  it("shows the previous build at the same size", async () => {
    render(<App />);
    expect((await capture()).getAttribute("src")).toContain("b42-1440");
    fireEvent.click(screen.getByRole("button", { name: "390 Phone" }));
    fireEvent.keyDown(window, { key: "b" });
    expect((await capture()).getAttribute("src")).toContain("b41-390");
    // Stepping size while Before shows keeps Before, at the new size.
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect((await capture()).getAttribute("src")).toContain("b41-1440");
  });
});

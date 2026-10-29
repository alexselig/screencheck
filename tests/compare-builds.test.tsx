import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { cropFrame, newerCapture } from "../src/client/compare";
import { versionModel } from "../src/client/versions";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import type { FeedbackStatus } from "../src/shared/feedback";
import type { PublicProject } from "../src/shared/projects";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

const PROJECT: PublicProject = {
  ...EXAMPLE_PROJECT,
  versions: ["build-41", "build-42"],
  screens: EXAMPLE_PROJECT.screens.map((item, index) => ({
    ...item,
    hasCapture: true,
    // Only the first screen changed between the two builds.
    ...(index === 0 ? { changed: ["build-42"] } : {}),
  })),
};
const [FIRST] = PROJECT.screens;

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

function seed(
  version: string,
  status: FeedbackStatus = "OPEN",
  extra: Record<string, unknown> = {},
) {
  return api.storage.createFeedback("example", {
    clientMutationId: crypto.randomUUID(),
    screenId: FIRST!.id,
    version,
    x: 0.2,
    y: 0.4,
    note: `Pinned on ${version}`,
    tags: [],
    status,
    ...extra,
  });
}

function capture() {
  return screen.findByRole("img", { name: /capture$/ });
}

function modes() {
  return screen.getByRole("group", { name: "Compare builds" });
}

describe("compare helpers", () => {
  it("finds the newest capture of the same size and whether it changed", () => {
    const versions = versionModel({
      versions: ["a-390", "a-1440", "b-1440", "c-390", "c-1440"],
      versionDetails: [
        { id: "a-390", revision: "a", label: "390" },
        { id: "a-1440", revision: "a", label: "1440" },
        { id: "b-1440", revision: "b", label: "1440" },
        { id: "c-390", revision: "c", label: "390" },
        { id: "c-1440", revision: "c", label: "1440" },
      ],
    });
    expect(newerCapture(versions, ["b-1440"], "a-1440")).toBe("c-1440");
    expect(newerCapture(versions, [], "a-1440")).toBeUndefined();
    expect(newerCapture(versions, ["c-390"], "a-390")).toBe("c-390");
    expect(newerCapture(versions, ["c-1440"], "c-1440")).toBeUndefined();
  });

  it("frames a crop around a pin or a box, kept inside the capture", () => {
    expect(cropFrame({ x: 0.5, y: 0.5 })).toEqual({
      width: 0.4,
      left: 0.3,
      centerY: 0.5,
    });
    expect(cropFrame({ x: 0.02, y: 0.1 }).left).toBe(0);
    expect(cropFrame({ x: 0.99, y: 0.1 }).left).toBeCloseTo(0.6);
    const boxed = cropFrame({
      x: 0.1,
      y: 0.1,
      box: { x: 0.1, y: 0.1, w: 0.6, h: 0.2 },
    });
    expect(boxed.width).toBeCloseTo(0.72);
    expect(boxed.centerY).toBeCloseTo(0.2);
  });
});

describe("compare builds", () => {
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

  it("offers Toggle, Overlay, Slider and Diff above the canvas, Toggle first", async () => {
    render(<App />);
    await capture();
    const group = modes();
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Toggle", "Overlay", "Slider", "Diff"]);
    expect(
      within(group).getByRole("button", { name: "Toggle" }),
    ).toHaveAttribute("aria-pressed", "true");
    // It sits with the size and zoom controls, not in the footer.
    const footer = screen.getByRole("contentinfo", { name: "Review actions" });
    expect(footer).not.toContainElement(group);
  });

  it("has no compare modes on the oldest build", async () => {
    window.history.replaceState(null, "", "#project=example&version=build-41");
    render(<App />);
    await capture();
    expect(screen.queryByRole("group", { name: "Compare builds" })).toBeNull();
  });

  it("overlays After on Before with an opacity slider and hides pins", async () => {
    await seed("build-42");
    render(<App />);
    await capture();
    expect(await screen.findAllByTestId("feedback-pin")).toHaveLength(1);

    fireEvent.click(within(modes()).getByRole("button", { name: "Overlay" }));
    const layer = screen.getByTestId("compare-builds");
    const before = within(layer).getByRole("img", { name: /build-41/ });
    const after = within(layer).getByRole("img", { name: /build-42/ });
    expect(before.getAttribute("src")).toContain("build-41");
    expect(after.getAttribute("src")).toContain("build-42");
    expect(screen.queryAllByTestId("feedback-pin")).toHaveLength(0);

    const opacity = screen.getByRole("slider", { name: "After opacity" });
    expect(opacity).toHaveAttribute("type", "range");
    fireEvent.change(opacity, { target: { value: "25" } });
    expect(after.style.opacity).toBe("0.25");
  });

  it("splits Before and After with a keyboard-reachable divider", async () => {
    render(<App />);
    await capture();
    fireEvent.click(within(modes()).getByRole("button", { name: "Slider" }));
    const divider = screen.getByRole("slider", {
      name: "Divider: build-41 left, build-42 right",
    });
    expect(divider).toHaveAttribute("type", "range");
    expect(divider).toHaveValue("50");
    fireEvent.change(divider, { target: { value: "30" } });
    const layer = screen.getByTestId("compare-builds");
    expect(
      within(layer).getByRole("img", { name: /build-42/ }).style.clipPath,
    ).toBe("inset(0 0 0 30%)");
    // Arrow keys belong to the divider, not to screen stepping.
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(
      screen.getByRole("navigation", { name: "Screen navigation" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Screen navigation" }))
        .getAllByRole("button")
        .find((button) => button.getAttribute("aria-current") === "page"),
    ).toHaveAttribute("data-screen-id", FIRST!.id);
  });

  it("shows a Diff canvas", async () => {
    render(<App />);
    await capture();
    fireEvent.click(within(modes()).getByRole("button", { name: "Diff" }));
    expect(
      screen.getByRole("img", {
        name: "Changed pixels between build-41 and build-42",
      }),
    ).toBeInTheDocument();
  });

  it("goes back to Toggle when the footer flips Before or After", async () => {
    render(<App />);
    await capture();
    fireEvent.click(within(modes()).getByRole("button", { name: "Overlay" }));
    const footer = screen.getByRole("contentinfo", { name: "Review actions" });
    fireEvent.click(within(footer).getByRole("button", { name: /Before/ }));
    expect(screen.queryByTestId("compare-builds")).toBeNull();
    expect(
      within(modes()).getByRole("button", { name: "Toggle" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect((await capture()).getAttribute("src")).toContain("build-41");
  });

  it("marks screens whose capture changed since the previous build", async () => {
    render(<App />);
    await capture();
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    const dots = within(rail).getAllByTestId("screen-changed-dot");
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAttribute("title", "Changed since build-41");
    const row = within(rail).getByRole("button", {
      name: /Public landing.*changed since build-41/,
    });
    expect(row).toContainElement(dots[0]!);
  });

  it("shows before and after crops on a fix when a newer capture differs", async () => {
    await seed("build-41", "RESOLVED", {
      box: { x: 0.1, y: 0.3, w: 0.2, h: 0.2 },
    });
    window.history.replaceState(null, "", "#project=example&version=build-41");
    render(<App />);
    const crops = await screen.findByRole("group", {
      name: "Before and after the fix",
    });
    const [before, after] = within(crops).getAllByRole("img");
    expect(before!.getAttribute("src")).toContain("build-41");
    expect(after!.getAttribute("src")).toContain("build-42");
    expect(within(crops).getByText("Before · build-41")).toBeInTheDocument();
    expect(within(crops).getByText("After · build-42")).toBeInTheDocument();
  });

  it("leaves the crops out when no newer capture differs", async () => {
    await seed("build-41", "RESOLVED");
    await api.storage.createFeedback("example", {
      clientMutationId: crypto.randomUUID(),
      screenId: PROJECT.screens[1]!.id,
      version: "build-41",
      x: 0.5,
      y: 0.5,
      note: "Unchanged screen",
      tags: [],
      status: "RESOLVED",
    });
    window.history.replaceState(
      null,
      "",
      `#project=example&version=build-41&screen=${PROJECT.screens[1]!.id}`,
    );
    render(<App />);
    await screen.findByRole("button", { name: /Verify pin/ });
    expect(
      screen.queryByRole("group", { name: "Before and after the fix" }),
    ).toBeNull();
  });
});

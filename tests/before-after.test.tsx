import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { versionModel } from "../src/client/versions";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

describe("previousVersion", () => {
  it("steps back one build", () => {
    const model = versionModel({ versions: ["build-41", "build-42"] });
    expect(model.previousVersion("build-42")).toBe("build-41");
    expect(model.previousVersion("build-41")).toBeUndefined();
  });

  it("keeps the size, skipping builds that lack it", () => {
    const model = versionModel({
      versions: ["b7-1440", "b7-390", "b8-1440", "b9-1440", "b9-390"],
      versionDetails: [
        { id: "b7-1440", revision: "b7", label: "1440" },
        { id: "b7-390", revision: "b7", label: "390" },
        { id: "b8-1440", revision: "b8", label: "1440" },
        { id: "b9-1440", revision: "b9", label: "1440" },
        { id: "b9-390", revision: "b9", label: "390" },
      ],
    });
    expect(model.previousVersion("b9-1440")).toBe("b8-1440");
    expect(model.previousVersion("b9-390")).toBe("b7-390");
    expect(model.previousVersion("b7-390")).toBeUndefined();
  });
});

describe("before/after toggle", () => {
  let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

  beforeEach(async () => {
    window.history.replaceState(null, "", "#");
    api = await installFakeFeedbackApi({
      ...EXAMPLE_PROJECT,
      versions: ["build-41", "build-42"],
      screens: EXAMPLE_PROJECT.screens.map((item) => ({
        ...item,
        hasCapture: true,
      })),
    });
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    window.history.replaceState(null, "", "#");
    await api.dispose();
  });

  it("flips the canvas to the previous build from the footer and with B", async () => {
    render(<App />);
    const image = await screen.findByRole("img", { name: /capture$/ });
    expect(image.getAttribute("src")).toContain("build-42");

    const footer = screen.getByRole("contentinfo", { name: "Review actions" });
    const group = within(footer).getByRole("group", {
      name: "Compare with the previous build",
    });
    const before = within(group).getByRole("button", { name: /Before/ });
    const after = within(group).getByRole("button", { name: /After/ });
    expect(after).toHaveAttribute("aria-pressed", "true");
    expect(before).toHaveAttribute(
      "title",
      expect.stringContaining("build-41"),
    );

    fireEvent.click(before);
    expect(before).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("img", { name: /capture$/ }).getAttribute("src"),
    ).toContain("build-41");
    expect(screen.queryAllByTestId("feedback-pin")).toHaveLength(0);
    expect(screen.getByText(/Before · build-41/)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "b" });
    expect(after).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("img", { name: /capture$/ }).getAttribute("src"),
    ).toContain("build-42");
  });

  it("offers Before in the overflow menu, for phones", async () => {
    render(<App />);
    await screen.findByRole("img", { name: /capture$/ });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Before · build-41" }),
    );
    expect(
      screen.getByRole("img", { name: /capture$/ }).getAttribute("src"),
    ).toContain("build-41");
  });

  it("hides the toggle on the oldest build", async () => {
    window.history.replaceState(null, "", "#project=example&version=build-41");
    render(<App />);
    await screen.findByRole("img", { name: /capture$/ });
    expect(
      screen.queryByRole("group", { name: "Compare with the previous build" }),
    ).toBeNull();
  });
});

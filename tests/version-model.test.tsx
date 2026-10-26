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
import { versionModel } from "../src/client/versions";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

describe("versionModel", () => {
  it("keeps build-41 and build-42 as two revisions", () => {
    const model = versionModel({ versions: ["build-41", "build-42"] });
    expect(model.revisionOf("build-41")).toBe("build-41");
    expect(model.revisionOf("build-42")).toBe("build-42");
    expect(model.revisions).toEqual(["build-41", "build-42"]);
    expect(model.versionsOf("build-42")).toEqual(["build-42"]);
    expect(model.labelOf("build-42")).toBe("build-42");
  });

  it("groups versions only through their registered revision and label", () => {
    const model = versionModel({
      versions: ["b7-desktop-1440", "b7-mobile-390", "b8-desktop-1440"],
      versionDetails: [
        { id: "b7-desktop-1440", revision: "b7", label: "1440" },
        { id: "b7-mobile-390", revision: "b7", label: "390" },
      ],
    });
    expect(model.revisions).toEqual(["b7", "b8-desktop-1440"]);
    expect(model.versionsOf("b7")).toEqual([
      "b7-desktop-1440",
      "b7-mobile-390",
    ]);
    expect(model.labelOf("b7-mobile-390")).toBe("390");
  });

  it("labels a version by its explicit viewport when it has no label", () => {
    const model = versionModel({
      versions: ["b9-a", "b9-b", "b9-c"],
      versionDetails: [
        { id: "b9-a", revision: "b9", viewport: 390 },
        { id: "b9-b", revision: "b9", viewport: 768, label: "tablet" },
        { id: "b9-c", viewport: 1440 },
      ],
    });
    expect(model.labelOf("b9-a")).toBe("390");
    expect(model.labelOf("b9-b")).toBe("tablet");
    expect(model.revisions).toEqual(["b9", "b9-c"]);
    expect(model.revisionOf("b9-c")).toBe("b9-c");
  });

  it("never reads a revision or size from an id suffix", () => {
    const model = versionModel({
      versions: ["build-43-390", "build-43-1440", "build-44-1440"],
    });
    expect(model.revisions).toEqual([
      "build-43-390",
      "build-43-1440",
      "build-44-1440",
    ]);
    expect(model.labelOf("build-43-390")).toBe("build-43-390");
    expect(model.previousVersion("build-44-1440")).toBe("build-43-1440");
  });
});

describe("README-style build versions", () => {
  let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

  beforeEach(async () => {
    window.history.replaceState(null, "", "#");
    api = await installFakeFeedbackApi({
      ...EXAMPLE_PROJECT,
      versions: ["build-41", "build-42"],
    });
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    window.history.replaceState(null, "", "#");
    await api.dispose();
  });

  it("offers a version picker, not a resolution filter, and lists each screen once", async () => {
    render(<App />);
    const picker = await screen.findByRole("combobox", { name: "Revision" });
    expect(picker).toHaveValue("build-42");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["build-42", "build-41"]);
    expect(screen.queryByRole("combobox", { name: "Viewport" })).toBeNull();
    expect(screen.queryByText(/Resolution/)).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    expect(
      within(rail).getAllByRole("button", { name: /^\d\d\./ }),
    ).toHaveLength(EXAMPLE_PROJECT.screens.length);
    expect(within(rail).queryByRole("button", { name: /· 4[12]/ })).toBeNull();
  });
});

describe("shared link to an older build", () => {
  let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

  beforeEach(async () => {
    window.history.replaceState(
      null,
      "",
      "#project=example&version=build-41&screen=bootstrap",
    );
    api = await installFakeFeedbackApi({
      ...EXAMPLE_PROJECT,
      versions: ["build-41", "build-42"],
    });
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    window.history.replaceState(null, "", "#");
    await api.dispose();
  });

  it("opens the linked version and offers the newer one instead of switching", async () => {
    render(<App />);
    const picker = await screen.findByRole("combobox", { name: "Revision" });
    expect(picker).toHaveValue("build-41");
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#project=example&version=build-41&screen=bootstrap",
      ),
    );
    const notice = screen.getByText(/Showing build-41 from the link/);
    expect(notice).toHaveTextContent("A newer build, build-42, is available.");

    fireEvent.click(screen.getByRole("button", { name: "Switch to build-42" }));
    expect(picker).toHaveValue("build-42");
    expect(screen.queryByText(/from the link/)).toBeNull();
    await waitFor(() => expect(window.location.hash).toContain("build-42"));
  });
});

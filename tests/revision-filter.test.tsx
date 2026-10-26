import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

beforeEach(async () => {
  window.location.hash = "";
  api = await installFakeFeedbackApi({
    ...EXAMPLE_PROJECT,
    versions: [
      "build-r1-desktop-1440",
      "build-r1-mobile-390",
      "build-r2-desktop-1440",
    ],
    versionDetails: [
      { id: "build-r1-desktop-1440", revision: "build-r1", label: "1440" },
      { id: "build-r1-mobile-390", revision: "build-r1", label: "390" },
      { id: "build-r2-desktop-1440", revision: "build-r2", label: "1440" },
    ],
  });
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await api.dispose();
});

describe("revision filter", () => {
  it("defaults to the newest revision and limits sizes to it", async () => {
    render(<App />);
    const revision = await screen.findByRole("combobox", { name: "Revision" });
    expect(revision).toHaveValue("build-r2");
    expect(
      screen.queryByRole("group", { name: "Screen size" }),
    ).not.toBeInTheDocument();
    // Builds are never labelled as a resolution or viewport (ux-3, ds-36).
    expect(
      screen.queryByRole("combobox", { name: /Viewport|Resolution/ }),
    ).toBeNull();

    fireEvent.change(revision, { target: { value: "build-r1" } });
    const sizes = await screen.findByRole("group", { name: "Screen size" });
    const buttons = within(sizes).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "390Phone",
      "1440Desktop",
    ]);
    // The size you were on carries over to the other build.
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
  });
});

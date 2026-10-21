import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILDS,
  PROJECT,
  PROJECT_NAME,
  REGISTERED_SCREENS,
} from "../scripts/playground/project.mjs";
import { App } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

const WALKTHROUGH = readFileSync(
  path.resolve(__dirname, "..", "docs", "PLAYGROUND.md"),
  "utf8",
);

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

beforeEach(async () => {
  api = await installFakeFeedbackApi({
    id: PROJECT,
    name: PROJECT_NAME,
    versions: BUILDS,
    screens: REGISTERED_SCREENS.map(({ capturePath: _, ...item }) => ({
      ...item,
      hasCapture: false,
    })),
  });
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await api.dispose();
});

// docs/PLAYGROUND.md names rail rows ("09 Settings") and header
// pickers; this fails when the app or the seed changes under it.
describe("docs/PLAYGROUND.md", () => {
  it("names rail rows that exist in the playground's screen index", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation");
    await within(nav).findAllByRole("button", { name: /^01/ });
    const rows = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "");

    const named = [
      ...WALKTHROUGH.matchAll(/\*\*(\d{2}) ([^*]+?)\*\*/g),
      ...WALKTHROUGH.matchAll(/^\| (\d{2}) ([^|]+?) +\|/gm),
    ];
    expect(named.length).toBeGreaterThan(5);
    for (const [, number, title] of named) {
      expect(rows).toContain(`${number}${title}`);
    }
  });

  it("names header pickers that the playground shows", async () => {
    render(<App />);
    for (const label of ["Revision"]) {
      expect(WALKTHROUGH).toContain(`**${label}**`);
      expect(
        await screen.findByRole("combobox", { name: label }),
      ).toBeInTheDocument();
    }
    for (const build of BUILDS) expect(WALKTHROUGH).toContain(build);
  });
});

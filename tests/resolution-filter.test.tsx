import { cleanup, render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

beforeEach(async () => {
  api = await installFakeFeedbackApi({
    ...EXAMPLE_PROJECT,
    versions: ["web-1440", "web-390"],
    versionDetails: [
      { id: "web-1440", revision: "web", label: "1440" },
      { id: "web-390", revision: "web", label: "390" },
    ],
  });
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await api.dispose();
});

describe("resolution filter", () => {
  it("lists every resolution by default and narrows the rail to one", async () => {
    render(<App />);
    const select = await screen.findByRole("combobox", { name: "Viewport" });
    expect(select).toHaveValue("all");
    const screenCount = EXAMPLE_PROJECT.screens.length;
    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("button", { name: /· 390/ })).toHaveLength(
      screenCount,
    );
    expect(within(nav).getAllByRole("button", { name: /· 1440/ })).toHaveLength(
      screenCount,
    );

    fireEvent.change(select, { target: { value: "web-390" } });
    expect(within(nav).getAllByRole("button", { name: /· 390/ })).toHaveLength(
      screenCount,
    );
    expect(
      within(nav).queryAllByRole("button", { name: /· 1440/ }),
    ).toHaveLength(0);

    fireEvent.change(select, { target: { value: "all" } });
    expect(within(nav).getAllByRole("button", { name: /· 1440/ })).toHaveLength(
      screenCount,
    );
  });

  it("numbers rows by screen so the rail and counters agree (ds-8)", async () => {
    render(<App />);
    await screen.findByRole("combobox", { name: "Viewport" });
    const nav = screen.getByRole("navigation");
    const [first, second] = EXAMPLE_PROJECT.screens;
    expect(
      within(nav).getByRole("button", { name: `01. ${first!.title} · 390` }),
    ).toBeInTheDocument();
    const row = within(nav).getByRole("button", {
      name: `02. ${second!.title} · 390`,
    });
    fireEvent.click(row);
    const total = EXAMPLE_PROJECT.screens.length;
    const place = document.querySelector(".action-bar-place")!;
    expect(place).toHaveTextContent(new RegExp(`^2/${total}$`));
    // The version is its own element, so the title never truncates it away.
    expect(row.querySelector(".screen-name")).toHaveTextContent(
      new RegExp(`^${second!.title}$`),
    );
    expect(row.querySelector(".screen-version")).toHaveTextContent("390");
  });
});

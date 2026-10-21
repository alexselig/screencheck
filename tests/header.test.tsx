import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

beforeEach(async () => {
  window.history.replaceState(null, "", "#");
  api = await installFakeFeedbackApi();
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  await api.dispose();
});

describe("workbench header (ds-23)", () => {
  it("labels a lone project instead of showing bare text", async () => {
    render(<App />);
    const banner = (await screen.findAllByRole("banner")).find((node) =>
      node.classList.contains("workbench-header"),
    )!;
    const project = await within(banner).findByText("Example project");
    expect(project.closest(".header-project")).toHaveTextContent(
      /^ProjectExample project$/,
    );
    expect(within(banner).getByRole("heading", { level: 1 })).toHaveTextContent(
      "ScreenCheck",
    );
  });
});

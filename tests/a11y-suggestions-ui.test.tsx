import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearA11yReportCache } from "../src/client/a11y-api";
import { App } from "../src/client/app";
import type { A11yReport } from "../src/shared/a11y";
import { EXAMPLE_PROJECT } from "../src/server/projects";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

const REPORT: A11yReport = {
  version: 1,
  capture: { width: 1440, height: 2000 },
  violations: [
    {
      id: "color-contrast",
      impact: "serious",
      help: "Elements must meet minimum color contrast ratio thresholds",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.14/color-contrast",
      nodes: [
        {
          target: "#faint",
          box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
          summary: "Element has insufficient color contrast of 1.6",
        },
      ],
    },
    {
      id: "region",
      impact: "moderate",
      help: "All page content should be contained by landmarks",
      nodes: [
        { target: "footer > p", box: { x: 0.5, y: 0.8, w: 0.2, h: 0.04 } },
        // No box: can't be pinned, so no ghost.
        { target: ".offscreen" },
      ],
    },
  ],
};

const screenId = EXAMPLE_PROJECT.screens[0]!.id;

describe("suggested accessibility comments", () => {
  let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

  beforeEach(async () => {
    window.history.replaceState(null, "", "#");
    clearA11yReportCache();
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

  const ghosts = () => screen.queryAllByTestId("suggestion-ghost");
  const footer = () =>
    screen.getByRole("contentinfo", { name: "Review actions" });

  it("shows nothing when the capture has no report", async () => {
    render(<App />);
    await screen.findByRole("img", { name: /capture$/ });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ghosts()).toHaveLength(0);
    expect(screen.queryByRole("switch", { name: /Suggestions/ })).toBeNull();
  });

  it("draws dashed ghosts labelled Suggested, toggled by the switch", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    expect(ghosts()[0]).toHaveTextContent("Suggested");
    expect(ghosts()[0]).toHaveAccessibleName(
      "Suggested: Elements must meet minimum color contrast ratio thresholds",
    );
    const boxes = screen.getAllByTestId("suggestion-box");
    expect(boxes[0]).toHaveClass("feedback-box", "is-suggested");
    expect(boxes[0]!.style.left).toBe("10%");
    expect(boxes[0]!.style.top).toBe("20%");
    // Ghosts are not comments.
    expect(screen.queryAllByTestId(/^feedback-pin/)).toHaveLength(0);

    const toggle = within(footer()).getByRole("switch", {
      name: /Suggestions/,
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent("2");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(ghosts()).toHaveLength(0);
    fireEvent.click(toggle);
    expect(ghosts()).toHaveLength(2);
  });

  it("hides ghosts while Before shows the previous build", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    const group = within(footer()).getByRole("group", {
      name: "Compare with the previous build",
    });
    fireEvent.click(within(group).getByRole("button", { name: /Before/ }));
    expect(ghosts()).toHaveLength(0);
    expect(screen.queryByRole("switch", { name: /Suggestions/ })).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: /After/ }));
    expect(ghosts()).toHaveLength(2);
  });

  it("opens a card with the rule, impact and fix link; Escape closes it", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    fireEvent.click(ghosts()[0]!);
    const card = screen.getByRole("dialog", {
      name: "Suggested accessibility comment",
    });
    expect(ghosts()[0]).toHaveAttribute("aria-expanded", "true");
    expect(card).toHaveTextContent("serious");
    expect(card).toHaveTextContent("color-contrast");
    expect(card).toHaveTextContent("#faint");
    expect(card).toHaveTextContent("insufficient color contrast");
    expect(
      within(card).getByRole("link", { name: "How to fix" }),
    ).toHaveAttribute("href", REPORT.violations[0]!.helpUrl);
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ghosts()).toHaveLength(2);
  });

  it("Add as comment creates a P1 a11y box pin and retires the ghost", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    fireEvent.click(ghosts()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Add as comment" }));

    await waitFor(() => expect(ghosts()).toHaveLength(1));
    const [record] = await api.storage.listFeedback("example");
    expect(record).toMatchObject({
      screenId,
      version: "build-42",
      status: "OPEN",
      box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
      tags: expect.arrayContaining(["P1", "a11y"]),
    });
    expect(record!.note).toContain(
      "Elements must meet minimum color contrast ratio thresholds",
    );
    expect(api.dismissalWrites).toEqual([
      expect.objectContaining({
        suggestionId: "color-contrast|#faint",
        feedbackId: record!.id,
      }),
    ]);
    expect(await screen.findAllByTestId(/^feedback-pin/)).not.toHaveLength(0);
  });

  it("moderate findings promote at P2", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    fireEvent.click(ghosts()[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Add as comment" }));
    await waitFor(() => expect(ghosts()).toHaveLength(1));
    const [record] = await api.storage.listFeedback("example");
    expect(record!.tags).toEqual(expect.arrayContaining(["P2", "a11y"]));
  });

  it("Dismiss hides the ghost and remembers it across reloads", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    const { unmount } = render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    fireEvent.click(ghosts()[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(ghosts()).toHaveLength(1));
    expect(api.dismissalWrites).toEqual([
      {
        version: "build-42",
        screenId,
        suggestionId: "region|footer > p",
      },
    ]);
    expect(await api.storage.listFeedback("example")).toEqual([]);

    unmount();
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ghosts()).toHaveLength(1);
    expect(ghosts()[0]).toHaveAccessibleName(/color contrast/);
  });

  it("keeps the card open with the error when dismissing fails", async () => {
    api.setA11yReport("build-42", screenId, REPORT);
    render(<App />);
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    fireEvent.click(ghosts()[0]!);
    api.failNext(500, "Disk full.", /\/suggestions/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full.");
    expect(ghosts()).toHaveLength(2);
  });
});

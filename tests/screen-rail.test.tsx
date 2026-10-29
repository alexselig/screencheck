import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  centeredScrollLeft,
  ScreenRail,
  versionTag,
} from "../src/client/components/screen-rail";

const screens = [
  {
    id: "one",
    ordinal: 1,
    title: "Public landing",
    group: "Access",
    viewport: { width: 1440, height: 1000 },
  },
  {
    id: "two",
    ordinal: 2,
    title: "Dashboard",
    group: "Portfolio",
    viewport: { width: 1440, height: 1000 },
  },
];

afterEach(cleanup);

describe("ScreenRail", () => {
  it("expands compact navigation on hover and keeps numbered accessible names", () => {
    render(
      <ScreenRail
        mode="compact"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        screens={screens}
        selectedId="one"
      />,
    );
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    expect(rail).toHaveAttribute("data-expanded", "false");
    expect(
      screen.getByRole("button", { name: "01. Public landing" }),
    ).toBeInTheDocument();
    fireEvent.mouseEnter(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
    fireEvent.mouseLeave(rail);
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("puts the open count beside the number, opposite the partial check", () => {
    render(
      <ScreenRail
        mode="compact"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        openCounts={new Map([["one", 3]])}
        partialApprovals={
          new Map([["one", "Approved at 1440; 390 still to review"]])
        }
        screens={screens}
        selectedId="one"
      />,
    );
    const first = screen.getByRole("button", {
      name: "01. Public landing (Approved at 1440; 390 still to review), 3 open",
    });
    const number = first.querySelector(".screen-number");
    expect(
      number?.querySelector("[data-testid=screen-open-count]"),
    ).toHaveTextContent("3");
    // Badges lead the digits: check outermost, then the count, then "01".
    const parts = [...(number?.querySelectorAll("*") ?? [])].filter((node) =>
      node.matches(
        "[data-testid=screen-partial-mark], [data-testid=screen-open-count], .screen-ordinal",
      ),
    );
    expect(
      parts.map((node) => node.getAttribute("data-testid") ?? node.textContent),
    ).toEqual(["screen-partial-mark", "screen-open-count", "01"]);
    const second = screen.getByRole("button", { name: "02. Dashboard" });
    expect(second.querySelector("[data-testid=screen-open-count]")).toBeNull();
  });

  it("shows only the check once a screen is approved at every size", () => {
    render(
      <ScreenRail
        approvedIds={new Set(["one"])}
        mode="compact"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        openCounts={new Map([["one", 3]])}
        screens={screens}
        selectedId="one"
      />,
    );
    const first = screen.getByRole("button", {
      name: "01. Public landing (approved), 3 open",
    });
    expect(
      first.querySelector("[data-testid=screen-approved-mark]"),
    ).not.toBeNull();
    expect(first.querySelector("[data-testid=screen-open-count]")).toBeNull();
  });

  it("draws the approved check green with a white tick", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../src/client/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.screen-approved-mark circle \{[^}]*fill: var\(--approved\);/,
    );
    expect(css).toMatch(
      /\.screen-approved-mark path \{[^}]*stroke: var\(--on-approved\);/,
    );
  });

  it("steps through screens with the up and down arrows, focus following", () => {
    const three = [
      ...screens,
      {
        id: "three",
        ordinal: 3,
        title: "Settings",
        group: "Portfolio",
        viewport: { width: 1440, height: 1000 },
      },
    ];
    const onSelect = vi.fn();
    const { rerender } = render(
      <ScreenRail
        mode="wide"
        onSelect={onSelect}
        screens={three}
        selectedId="one"
      />,
    );
    const first = screen.getByRole("button", { name: "01. Public landing" });
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("two");
    rerender(
      <ScreenRail
        mode="wide"
        onSelect={onSelect}
        screens={three}
        selectedId="two"
      />,
    );
    const second = screen.getByRole("button", { name: "02. Dashboard" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("one");

    fireEvent.keyDown(second, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("three");
    fireEvent.keyDown(second, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("one");
  });

  it("stops at the ends of the list and ignores modified arrows", () => {
    const onSelect = vi.fn();
    render(
      <ScreenRail
        mode="wide"
        onSelect={onSelect}
        screens={screens}
        selectedId="one"
      />,
    );
    const first = screen.getByRole("button", { name: "01. Public landing" });
    fireEvent.keyDown(first, { key: "ArrowUp" });
    fireEvent.keyDown(first, { key: "ArrowDown", metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("labels versions and groups when collapsed (ux-23)", () => {
    const { container } = render(
      <ScreenRail
        mode="compact"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        screens={[
          { ...screens[0]!, id: "one@@a", versionLabel: "1440 × 1000" },
          {
            ...screens[0]!,
            id: "one@@b",
            ordinal: 2,
            versionLabel: "390 × 844",
          },
        ]}
        selectedId="one@@a"
      />,
    );
    expect(
      [...container.querySelectorAll(".screen-version-tag")].map(
        (tag) => tag.textContent,
      ),
    ).toEqual(["1440", "390"]);
    expect(container.querySelector(".group-short")).toBeNull();
    expect(container.querySelector("ol h3")).toHaveAttribute("data-tone", "0");
    // Tags are visual only; the accessible names already carry the version.
    expect(container.querySelector(".screen-version-tag")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("omits the version tag when the rail lists one version", () => {
    const { container } = render(
      <ScreenRail
        mode="compact"
        onSelect={vi.fn()}
        screens={screens}
        selectedId="one"
      />,
    );
    expect(container.querySelector(".screen-version-tag")).toBeNull();
  });

  it("shortens version labels", () => {
    expect(versionTag("build-42")).toBe("42");
    expect(versionTag("1440 × 1000")).toBe("1440");
    expect(versionTag("Mobile")).toBe("Mob");
  });

  it("has no pin button; the expand arrows keep the rail open", () => {
    const onModeChange = vi.fn();
    render(
      <ScreenRail
        mode="compact"
        onModeChange={onModeChange}
        onSelect={vi.fn()}
        screens={screens}
        selectedId="one"
      />,
    );
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    fireEvent.mouseEnter(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
    expect(screen.queryByRole("button", { name: "Keep open" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand screen index" }),
    );
    expect(onModeChange).toHaveBeenCalledWith("wide");
  });

  it("centres the current screen in the strip, clamped to its ends (ds-27)", () => {
    expect(centeredScrollLeft(500, 60, 300, 1000)).toBe(380);
    expect(centeredScrollLeft(20, 60, 300, 1000)).toBe(0);
    expect(centeredScrollLeft(950, 50, 300, 1000)).toBe(700);
  });

  it("keeps the title and mode control in one sticky head (ds-9)", () => {
    render(
      <ScreenRail
        approvedIds={new Set(["one"])}
        mode="wide"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        screens={screens}
        selectedId="two"
      />,
    );
    const head = screen
      .getByRole("heading", { name: "Screen index" })
      .closest(".rail-head");
    expect(head).not.toBeNull();
    expect(head).toContainElement(
      screen.getByRole("button", { name: "Collapse screen index" }),
    );
    expect(head).not.toContainElement(
      screen.getByRole("switch", { name: /Hide approved screens/ }),
    );
    expect(head!.querySelector("ol")).toBeNull();
  });

  it("puts the settings in one group after the last screen", () => {
    render(
      <ScreenRail
        approvedIds={new Set(["one"])}
        mode="wide"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        screens={screens}
        selectedId="two"
        thumbnails={{ projectId: "demo", version: "v1", sizes: "216px" }}
      />,
    );
    const rail = screen.getByRole("navigation", { name: "Screen navigation" });
    const settings = screen.getByTestId("rail-settings");
    // Last in the rail, after the list.
    expect(rail.lastElementChild).toBe(settings);
    expect(settings.previousElementSibling?.tagName).toBe("OL");
    const switches = Array.from(settings.querySelectorAll('[role="switch"]'));
    expect(switches.map((item) => item.textContent)).toEqual([
      "Hide approved screens",
      "Show thumbnails",
    ]);
    for (const item of switches) {
      expect(item).toHaveClass("rail-filter-button");
    }
  });
});

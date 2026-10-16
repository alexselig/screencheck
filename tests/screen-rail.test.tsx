import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenRail } from "../src/client/components/screen-rail";

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

  it("puts the open count beside the number, opposite the approved check", () => {
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
    const number = first.querySelector(".screen-number");
    expect(
      number?.querySelector("[data-testid=screen-approved-mark]"),
    ).not.toBeNull();
    expect(
      number?.querySelector("[data-testid=screen-open-count]"),
    ).toHaveTextContent("3");
    // Badges lead the digits: check outermost, then the count, then "01".
    const parts = [...(number?.querySelectorAll("*") ?? [])].filter((node) =>
      node.matches(
        "[data-testid=screen-approved-mark], [data-testid=screen-open-count], .screen-ordinal",
      ),
    );
    expect(
      parts.map((node) => node.getAttribute("data-testid") ?? node.textContent),
    ).toEqual(["screen-approved-mark", "screen-open-count", "01"]);
    const second = screen.getByRole("button", { name: "02. Dashboard" });
    expect(second.querySelector("[data-testid=screen-open-count]")).toBeNull();
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
});

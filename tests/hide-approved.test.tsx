import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import { ScreenRail } from "../src/client/components/screen-rail";
import type { ReviewScreen } from "../src/shared/manifest";

const screens: ReviewScreen[] = [1, 2, 3, 4].map((ordinal) => ({
  id: `s${ordinal}`,
  ordinal,
  title: `Screen ${ordinal}`,
  description: "d",
  group: "G",
  viewport: { width: 390, height: 844 },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function rows() {
  return within(screen.getByRole("navigation"))
    .getAllByRole("button")
    .filter((button) => button.dataset.screenId)
    .map((button) => button.dataset.screenId);
}

describe("hide approved screens", () => {
  it("hides approved rows except the current one, and shows them again", () => {
    const onSelect = vi.fn();
    render(
      <ScreenRail
        approvedIds={new Set(["s2", "s3"])}
        mode="wide"
        onSelect={onSelect}
        screens={screens}
        selectedId="s3"
      />,
    );
    expect(rows()).toEqual(["s1", "s2", "s3", "s4"]);

    const toggle = screen.getByRole("button", {
      name: "Hide approved screens",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(rows()).toEqual(["s1", "s3", "s4"]);
    expect(
      screen.getByRole("button", { name: "Show approved screens (2)" }),
    ).toHaveAttribute("aria-pressed", "true");

    // ↑ from s3 skips the hidden s2.
    fireEvent.keyDown(screen.getByRole("button", { name: /Screen 3/ }), {
      key: "ArrowUp",
    });
    expect(onSelect).toHaveBeenCalledWith("s1");

    fireEvent.click(
      screen.getByRole("button", { name: "Show approved screens (2)" }),
    );
    expect(rows()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("remembers the choice and hides the button when nothing is approved", () => {
    const first = render(
      <ScreenRail
        approvedIds={new Set(["s2"])}
        mode="wide"
        onSelect={() => {}}
        screens={screens}
        selectedId="s1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Hide approved screens" }),
    );
    first.unmount();

    render(
      <ScreenRail
        approvedIds={new Set(["s2"])}
        mode="wide"
        onSelect={() => {}}
        screens={screens}
        selectedId="s1"
      />,
    );
    expect(rows()).toEqual(["s1", "s3", "s4"]);
    cleanup();

    render(
      <ScreenRail
        approvedIds={new Set()}
        mode="wide"
        onSelect={() => {}}
        screens={screens}
        selectedId="s1"
      />,
    );
    expect(
      screen.queryByRole("button", { name: /approved screens/ }),
    ).not.toBeInTheDocument();
  });
});

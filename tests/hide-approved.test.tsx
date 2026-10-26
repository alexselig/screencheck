import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

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

    const toggle = screen.getByRole("switch", {
      name: /Hide approved screens/,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(rows()).toEqual(["s1", "s3", "s4"]);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent("2 hidden");

    // ↑ from s3 skips the hidden s2.
    fireEvent.keyDown(screen.getByRole("button", { name: /Screen 3/ }), {
      key: "ArrowUp",
    });
    expect(onSelect).toHaveBeenCalledWith("s1");

    fireEvent.click(toggle);
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
      screen.getByRole("switch", { name: /Hide approved screens/ }),
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
      screen.queryByRole("switch", { name: /approved screens/ }),
    ).not.toBeInTheDocument();
  });
});

describe("hide approved screens with Prev/Next", () => {
  let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

  beforeEach(async () => {
    window.history.replaceState(null, "", "#");
    api = await installFakeFeedbackApi();
    await api.storage.setApproval("example", {
      version: "live",
      screenId: "bootstrap",
      approved: true,
    });
    localStorage.setItem("screencheck:hide-approved-screens", "1");
  });

  afterEach(async () => {
    window.history.replaceState(null, "", "#");
    await api.dispose();
  });

  it("skips hidden approved screens with Next and the arrow keys", async () => {
    render(<App />);
    const rail = await screen.findByRole("navigation", {
      name: "Screen navigation",
    });
    expect(
      await within(rail).findByRole("switch", {
        name: /Hide approved screens/,
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(rail).queryByRole("button", { name: /Session bootstrap/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next screen" }));
    expect(
      within(rail).getByRole("button", { name: /Populated dashboard/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(rail).queryByRole("button", { name: /Session bootstrap/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Next screen" })).toBeDisabled();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(
      within(rail).getByRole("button", { name: /Public landing/ }),
    ).toHaveAttribute("aria-current", "page");
  });
});

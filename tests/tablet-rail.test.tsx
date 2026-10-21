import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/client/app";
import { TABLET_QUERY } from "../src/client/components/screen-rail";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;
let tablet = false;
const listeners = new Set<() => void>();

beforeEach(async () => {
  window.history.replaceState(null, "", "#");
  api = await installFakeFeedbackApi();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === TABLET_QUERY && tablet;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  listeners.clear();
  tablet = false;
  localStorage.clear();
  window.history.replaceState(null, "", "#");
  await api.dispose();
});

const rail = () =>
  screen.findByRole("navigation", { name: "Screen navigation" });

describe("tablet rail (ds-26)", () => {
  it("opens compact between 901 and 1200px", async () => {
    tablet = true;
    render(<App />);
    expect(await rail()).toHaveAttribute("data-mode", "compact");
  });

  it("stays wide on a desktop and follows the window across the range", async () => {
    render(<App />);
    expect(await rail()).toHaveAttribute("data-mode", "wide");
    tablet = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(await rail()).toHaveAttribute("data-mode", "compact");
    tablet = false;
    act(() => listeners.forEach((listener) => listener()));
    expect(await rail()).toHaveAttribute("data-mode", "wide");
  });
});

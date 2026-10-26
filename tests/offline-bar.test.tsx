import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  OfflineBar,
  downloadReview,
  reviewFileName,
} from "../src/client/components/offline-bar";
import { createOfflineApi } from "../src/client/offline-api";
import type { OfflineBundle } from "../src/shared/bundle";

const bundle: OfflineBundle = {
  format: 1,
  id: "shop-1",
  createdAt: "2026-10-26T09:30:00.000Z",
  project: { id: "shop", name: "Shop", versions: ["v1"], screens: [] },
  feedback: [],
  approvals: [],
  captions: [],
  captures: {},
  elements: {},
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

describe("offline bar (#13)", () => {
  it("counts new comments and exports them", async () => {
    const api = createOfflineApi(bundle, { storage: memoryStorage() });
    const onExport = vi.fn();
    render(<OfflineBar api={api} onExport={onExport} />);
    expect(
      screen.getByRole("region", { name: "Offline review" }),
    ).toHaveTextContent("Bundled 2026-10-26");
    const button = screen.getByRole("button", { name: "Export review" });
    expect(button).toBeDisabled();
    expect(screen.getByText("0 new comments")).toBeInTheDocument();
    await act(async () => {
      await api.fetch("/api/projects/shop/feedback", {
        method: "POST",
        body: JSON.stringify({
          clientMutationId: "4f0f3c55-8f61-4a43-9d47-3e9a3d0c1a01",
          screenId: "home",
          version: "v1",
          x: 0.5,
          y: 0.5,
          note: "Hello",
        }),
      });
    });
    expect(screen.getByText("1 new comment")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onExport).toHaveBeenCalledWith(api);
  });

  it("downloads the review as a JSON file", () => {
    const api = createOfflineApi(bundle, {
      storage: memoryStorage(),
      now: () => new Date("2026-10-27T08:05:00.000Z"),
    });
    const createObjectURL = vi.fn(() => "blob:review");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL: revoke });
    const clicked: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
    const review = downloadReview(api);
    expect(review.kind).toBe("screencheck-review");
    expect(clicked).toEqual(["shop-review-2026-10-27-08-05.json"]);
    expect(reviewFileName("shop", review.exportedAt)).toBe(clicked[0]);
    click.mockRestore();
  });
});

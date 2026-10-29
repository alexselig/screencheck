import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RailResizer } from "../src/client/components/rail-resizer";
import {
  readShowThumbnails,
  writeShowThumbnails,
} from "../src/client/components/rail-settings";
import { ScreenRail } from "../src/client/components/screen-rail";
import { ScreenThumbnail } from "../src/client/components/screen-thumbnail";
import { createThumbnailQueue } from "../src/client/thumbnails";
import {
  RAIL_MAX,
  RAIL_MIN,
  clampRailWidth,
  dragOutcome,
  railMax,
  railThumbnailSizes,
  railWidthStyle,
  readRailWidth,
  writeRailWidth,
} from "../src/client/use-rail-width";

const screens = [
  {
    id: "one",
    ordinal: 1,
    title: "Public landing",
    group: "Access",
    viewport: { width: 1440, height: 900 },
  },
  {
    id: "two",
    ordinal: 2,
    title: "Dashboard",
    group: "Portfolio",
    viewport: { width: 390, height: 844 },
  },
];

const thumbnails = { projectId: "demo", version: "v1", sizes: "216px" };

// jsdom has no PointerEvent; a MouseEvent carries what the resizer reads.
class PointerEventShim extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

beforeEach(() => {
  localStorage.clear();
  if (typeof PointerEvent === "undefined") {
    vi.stubGlobal("PointerEvent", PointerEventShim);
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("rail width", () => {
  it("clamps between 220 and half the window, never past 640", () => {
    expect(railMax(1440)).toBe(RAIL_MAX);
    expect(railMax(1000)).toBe(500);
    expect(railMax(300)).toBe(RAIL_MIN);
    expect(clampRailWidth(100, 1440)).toBe(RAIL_MIN);
    expect(clampRailWidth(460.4, 1440)).toBe(460);
    expect(clampRailWidth(900, 1000)).toBe(500);
  });

  it("snaps to the compact strip when dragged below 160", () => {
    expect(dragOutcome(159, 1440)).toEqual({ compact: true });
    expect(dragOutcome(160, 1440)).toEqual({ compact: false, width: 220 });
    expect(dragOutcome(460, 1440)).toEqual({ compact: false, width: 460 });
  });

  it("remembers the width, and forgets it on reset", () => {
    expect(readRailWidth()).toBeNull();
    writeRailWidth(460.2);
    expect(localStorage.getItem("screencheck:rail-width")).toBe("460");
    expect(readRailWidth()).toBe(460);
    writeRailWidth(null);
    expect(localStorage.getItem("screencheck:rail-width")).toBeNull();
    localStorage.setItem("screencheck:rail-width", "wide");
    expect(readRailWidth()).toBeNull();
  });

  it("carries the width as a CSS variable and sizes thumbnails from it", () => {
    expect(railWidthStyle(null)).toBeUndefined();
    expect(railWidthStyle(460)).toEqual({ "--rail-width": "460px" });
    expect(railThumbnailSizes(null)).toBe("216px");
    expect(railThumbnailSizes(460)).toBe("396px");
  });

  it("survives storage that throws", () => {
    const failing = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRailWidth()).toBeNull();
    expect(readShowThumbnails()).toBe(false);
    expect(() => writeRailWidth(300)).not.toThrow();
    expect(() => writeShowThumbnails(true)).not.toThrow();
    failing.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("RailResizer", () => {
  function renderResizer(width = 280) {
    const onChange = vi.fn();
    const onCompact = vi.fn();
    render(
      <div className="workbench-grid">
        <div className="rail-column">
          <RailResizer
            max={640}
            onChange={onChange}
            onCompact={onCompact}
            width={width}
          />
        </div>
      </div>,
    );
    return {
      handle: screen.getByRole("separator", { name: "Resize screen index" }),
      onChange,
      onCompact,
    };
  }

  it("is a focusable separator with its range", () => {
    const { handle } = renderResizer(300);
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    expect(handle).toHaveAttribute("aria-valuemin", "220");
    expect(handle).toHaveAttribute("aria-valuemax", "640");
  });

  it("steps with the arrows, jumps with Home and End, resets with Enter", () => {
    vi.stubGlobal("innerWidth", 1440);
    const { handle, onChange } = renderResizer(300);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      316,
      284,
      364,
      236,
      220,
      640,
      null,
    ]);
  });

  it("keeps its keys from moving between screens", () => {
    const { handle } = renderResizer();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    window.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });

  it("resets on double-click", () => {
    const { handle, onChange } = renderResizer(460);
    fireEvent.doubleClick(handle);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("moves the grid's variable while dragging and commits once, on release", () => {
    vi.stubGlobal("innerWidth", 1440);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { handle, onChange } = renderResizer(280);
    const grid = handle.closest<HTMLElement>(".workbench-grid")!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 280, pointerId: 1 });
    expect(grid.dataset.resizing).toBe("true");
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 460, pointerId: 1 });
    // One frame per burst of moves.
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(grid.style.getPropertyValue("--rail-width")).toBe("460px");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { clientX: 460, pointerId: 1 });
    expect(grid.dataset.resizing).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(460);
  });

  it("collapses to the compact strip when dragged below 160", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { handle, onChange, onCompact } = renderResizer(280);
    fireEvent.pointerDown(handle, { button: 0, clientX: 280, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Show thumbnails", () => {
  function renderRail(props: Partial<Parameters<typeof ScreenRail>[0]> = {}) {
    return render(
      <ScreenRail
        mode="wide"
        onModeChange={vi.fn()}
        onSelect={vi.fn()}
        screens={screens}
        selectedId="one"
        thumbnails={thumbnails}
        {...props}
      />,
    );
  }

  it("shows a thumbnail per row and remembers the choice", () => {
    renderRail();
    const toggle = screen.getByRole("switch", { name: "Show thumbnails" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryAllByTestId("screen-thumbnail")).toHaveLength(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("screencheck:show-thumbnails")).toBe("1");
    const thumbs = screen.getAllByTestId("screen-thumbnail");
    expect(thumbs).toHaveLength(2);
    // Boxed at each screen's own viewport ratio before anything loads.
    expect(thumbs[0]!.style.aspectRatio).toBe("1440 / 900");
    expect(thumbs[1]!.style.aspectRatio).toBe("390 / 844");
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId("screen-thumbnail")).toHaveLength(0);
    expect(localStorage.getItem("screencheck:show-thumbnails")).toBe("0");
  });

  it("starts with thumbnails on when they were left on", () => {
    writeShowThumbnails(true);
    renderRail();
    expect(screen.getAllByTestId("screen-thumbnail")).toHaveLength(2);
  });

  it("has no thumbnails or settings in compact mode, and keeps the setting", () => {
    writeShowThumbnails(true);
    renderRail({ mode: "compact" });
    expect(screen.queryAllByTestId("screen-thumbnail")).toHaveLength(0);
    expect(screen.queryByTestId("rail-settings")).toBeNull();
    expect(readShowThumbnails()).toBe(true);
  });

  it("offers no thumbnails without a source (the phone strip)", () => {
    writeShowThumbnails(true);
    renderRail({ thumbnails: undefined });
    expect(
      screen.queryByRole("switch", { name: "Show thumbnails" }),
    ).toBeNull();
    expect(screen.queryAllByTestId("screen-thumbnail")).toHaveLength(0);
  });
});

describe("ScreenThumbnail", () => {
  it("loads nothing until its row nears the visible rail", () => {
    let fire: (() => void) | undefined;
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) {
        fire = () =>
          callback(
            [{ isIntersecting: true, target: element } as never],
            this as never,
          );
      }
      observe(target: Element) {
        element = target;
      }
      unobserve() {}
      disconnect() {}
    }
    let element: Element | undefined;
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    render(
      <ScreenThumbnail
        projectId="demo"
        screenId="one"
        sizes="216px"
        version="v1"
        viewport={{ width: 1440, height: 900 }}
      />,
    );
    const box = screen.getByTestId("screen-thumbnail");
    expect(box.querySelector("img")).toBeNull();
    act(() => fire!());
    const image = box.querySelector("img")!;
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("fetchpriority", "low");
    expect(image).toHaveAttribute("sizes", "216px");
    expect(image.getAttribute("srcset")).toBe(
      "/api/projects/demo/thumbnails/v1/one?w=400 400w, /api/projects/demo/thumbnails/v1/one?w=800 800w",
    );
  });
});

describe("thumbnail queue", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("runs at most two jobs at once", async () => {
    const queue = createThumbnailQueue({ ready: async () => {} });
    let running = 0;
    let most = 0;
    const gates = Array.from({ length: 5 }, deferred);
    const results = gates.map((gate, index) =>
      queue.enqueue(`job-${index}`, async () => {
        running += 1;
        most = Math.max(most, running);
        await gate.promise;
        running -= 1;
        return index;
      }),
    );
    await settle();
    expect(queue.active).toBe(2);
    expect(queue.pending).toBe(3);
    for (const gate of gates) {
      gate.resolve();
      await settle();
    }
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(2);
  });

  it("waits while the main capture is still loading", async () => {
    const canvas = deferred();
    const queue = createThumbnailQueue({ ready: () => canvas.promise });
    const run = vi.fn(async () => "done");
    const result = queue.enqueue("job", run);
    await settle();
    expect(run).not.toHaveBeenCalled();
    canvas.resolve();
    expect(await result).toBe("done");
  });

  it("makes each thumbnail once, and tries a failed one again", async () => {
    const queue = createThumbnailQueue({ ready: async () => {} });
    const run = vi.fn(async () => "made");
    const [first, second] = [
      queue.enqueue("same", run),
      queue.enqueue("same", run),
    ];
    expect(first).toBe(second);
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => {
      throw new Error("no");
    });
    await expect(queue.enqueue("bad", failing)).rejects.toThrow("no");
    await settle();
    await expect(queue.enqueue("bad", failing)).rejects.toThrow("no");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

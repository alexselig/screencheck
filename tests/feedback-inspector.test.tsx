import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeedbackInspector } from "../src/client/components/feedback-inspector";
import type {
  CreateFeedbackInput,
  FeedbackRecord,
  UpdateFeedbackInput,
} from "../src/shared/feedback";

const reviewScreens = [
  {
    id: "landing",
    ordinal: 1,
    title: "Public landing",
    group: "Access",
    viewport: { width: 1440, height: 1000 },
  },
];

function feedback(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    id: "feedback-1",
    projectId: "demo",
    screenId: "landing",
    version: "live",
    x: 0.25,
    y: 0.75,
    note: "Clarify the primary action.",
    tags: ["P1"],
    status: "OPEN",
    createdAt: "2026-10-05T20:00:00.000Z",
    updatedAt: "2026-10-05T20:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function renderInspector({
  initialFeedback = [feedback()],
  draftPin = null as { x: number; y: number } | null,
  onCreate = vi.fn(async (input: CreateFeedbackInput) =>
    feedback({
      id: input.clientMutationId,
      x: input.x,
      y: input.y,
      note: input.note,
      tags: input.tags ?? [],
    }),
  ),
  onUpdate = vi.fn(async (id: string, input: UpdateFeedbackInput) =>
    feedback({
      id,
      ...(input.patch as Partial<FeedbackRecord>),
      updatedAt: "2026-10-05T20:00:01.000Z",
    }),
  ),
  onRecoverDraft = vi.fn(),
}: {
  initialFeedback?: FeedbackRecord[];
  draftPin?: { x: number; y: number } | null;
  onCreate?: (input: CreateFeedbackInput) => Promise<FeedbackRecord>;
  onUpdate?: (
    id: string,
    input: UpdateFeedbackInput,
  ) => Promise<FeedbackRecord>;
  onRecoverDraft?: (pin: { x: number; y: number }) => void;
} = {}) {
  function Fixture() {
    const [records, setRecords] = useState(initialFeedback);
    const [selectedId, setSelectedId] = useState<string | null>(
      initialFeedback[0]?.id ?? null,
    );
    return (
      <FeedbackInspector
        draftPin={draftPin}
        feedback={records}
        onCancelDraft={vi.fn()}
        onCreate={async (input) => {
          const created = await onCreate(input);
          setRecords((current) => [...current, created]);
          return created;
        }}
        onRecoverDraft={onRecoverDraft}
        onSelectFeedback={setSelectedId}
        onUpdate={async (id, input) => {
          const updated = await onUpdate(id, input);
          setRecords((current) =>
            current.map((item) => (item.id === id ? updated : item)),
          );
          return updated;
        }}
        projectId="demo"
        screens={reviewScreens}
        selectedFeedbackId={selectedId}
        selectedScreenId="landing"
        version="live"
      />
    );
  }
  return { ...render(<Fixture />), onCreate, onUpdate, onRecoverDraft };
}

describe("FeedbackInspector", () => {
  it("debounces note saves for 500ms", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn(async (id: string, input: UpdateFeedbackInput) =>
      feedback({
        id,
        ...(input.patch as Partial<FeedbackRecord>),
        updatedAt: "2026-10-05T20:00:01.000Z",
      }),
    );
    renderInspector({ onUpdate });

    fireEvent.change(screen.getByRole("textbox", { name: "Feedback note" }), {
      target: { value: "Use a direct call to action." },
    });
    await act(async () => vi.advanceTimersByTime(499));
    expect(onUpdate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));

    expect(onUpdate).toHaveBeenCalledWith("feedback-1", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: { note: "Use a direct call to action." },
    });
  });

  it("requires a reply and saves it to the thread when marking feedback fixed", async () => {
    const onUpdate = vi.fn(async (id: string, input: UpdateFeedbackInput) =>
      feedback({
        id,
        ...(input.patch as Partial<FeedbackRecord>),
        updatedAt: "2026-10-05T20:00:01.000Z",
      }),
    );
    renderInspector({ onUpdate });

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Aligned the illustration with the sign-in button." },
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Feedback status" }),
      {
        target: { value: "RESOLVED" },
      },
    );

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("feedback-1", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: {
        status: "RESOLVED",
        message: {
          note: "Aligned the illustration with the sign-in button.",
          role: "reviewer",
        },
      },
    });
  });

  it("rebases a pending note debounce after an immediate status flush", async () => {
    vi.useFakeTimers();
    const onUpdate = vi
      .fn<(id: string, input: UpdateFeedbackInput) => Promise<FeedbackRecord>>()
      .mockResolvedValueOnce(
        feedback({
          status: "IN_PROGRESS",
          updatedAt: "2026-10-05T20:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(
        feedback({
          note: "Pending note",
          status: "IN_PROGRESS",
          updatedAt: "2026-10-05T20:00:02.000Z",
        }),
      );
    renderInspector({ onUpdate });
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback note" }), {
      target: { value: "Pending note" },
    });

    fireEvent.change(
      screen.getByRole("combobox", { name: "Feedback status" }),
      {
        target: { value: "IN_PROGRESS" },
      },
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTime(500));

    expect(onUpdate).toHaveBeenNthCalledWith(1, "feedback-1", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: { status: "IN_PROGRESS" },
    });
    expect(onUpdate).toHaveBeenNthCalledWith(2, "feedback-1", {
      expectedUpdatedAt: "2026-10-05T20:00:01.000Z",
      patch: { note: "Pending note" },
    });
  });

  it("never repaints a focused textarea from an external record update", () => {
    let refreshRecords = () => {};
    function Fixture() {
      const [records, setRecords] = useState([feedback()]);
      refreshRecords = () =>
        setRecords([
          feedback({
            note: "Server replacement",
            updatedAt: "2026-10-05T20:00:05.000Z",
          }),
        ]);
      return (
        <FeedbackInspector
          draftPin={null}
          feedback={records}
          onCancelDraft={vi.fn()}
          onCreate={vi.fn()}
          onRecoverDraft={vi.fn()}
          onSelectFeedback={vi.fn()}
          onUpdate={vi.fn()}
          projectId="demo"
          screens={reviewScreens}
          selectedFeedbackId="feedback-1"
          selectedScreenId="landing"
          version="live"
        />
      );
    }
    render(<Fixture />);
    const note = screen.getByRole("textbox", { name: "Feedback note" });
    note.focus();
    fireEvent.change(note, { target: { value: "My in-progress edit" } });

    act(() => refreshRecords());

    expect(note).toHaveValue("My in-progress edit");
    expect(note).toHaveFocus();
  });

  it("recovers a locally saved draft after reload", () => {
    localStorage.setItem(
      "screencheck.feedback-recovery.v1:demo",
      JSON.stringify({
        "create:live:landing": {
          kind: "create",
          screenId: "landing",
          version: "live",
          x: 0.4,
          y: 0.6,
          note: "Recovered note",
          tags: ["P2"],
        },
      }),
    );
    const onRecoverDraft = vi.fn();

    renderInspector({ initialFeedback: [], onRecoverDraft });

    expect(onRecoverDraft).toHaveBeenCalledWith({ x: 0.4, y: 0.6 });
    expect(screen.getByRole("textbox", { name: "Feedback note" })).toHaveValue(
      "Recovered note",
    );
  });

  it("chunks comments by status then priority and hides empty chunks", () => {
    render(
      <FeedbackInspector
        draftPin={null}
        feedback={[
          feedback(),
          feedback({
            id: "feedback-2",
            tags: ["P0", "Hover"],
            status: "IN_PROGRESS",
            note: "Fix hover behavior.",
            createdAt: "2026-10-05T20:01:00.000Z",
          }),
          feedback({
            id: "feedback-3",
            tags: [],
            note: "No priority yet.",
            createdAt: "2026-10-05T20:02:00.000Z",
          }),
        ]}
        onCancelDraft={vi.fn()}
        onCreate={vi.fn()}
        onRecoverDraft={vi.fn()}
        onSelectFeedback={vi.fn()}
        onUpdate={vi.fn()}
        projectId="demo"
        screens={reviewScreens}
        selectedFeedbackId={null}
        selectedScreenId="landing"
        version="live"
      />,
    );

    expect(screen.queryByRole("combobox", { name: /filter/i })).toBeNull();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    const inProgress = screen.getByRole("region", { name: "In progress" });
    expect(screen.queryByRole("region", { name: "Fixed" })).toBeNull();

    expect(
      within(backlog).getByRole("group", { name: "Backlog P1" }),
    ).toHaveTextContent("Clarify the primary action.");
    expect(
      within(backlog).queryByRole("group", { name: "Backlog P0" }),
    ).toBeNull();
    // Untagged comments sit in the section without a group heading.
    expect(within(backlog).getByText("No priority yet.")).toBeInTheDocument();
    expect(within(backlog).getAllByRole("group")).toHaveLength(1);

    const urgent = within(inProgress).getByRole("group", {
      name: "In progress P0",
    });
    expect(urgent).toHaveTextContent("Fix hover behavior.");
    expect(urgent).toHaveTextContent("Hover");
  });

  it("collapses status sections independently from pin visibility and remembers them", () => {
    const onTogglePinStatus = vi.fn();
    const first = render(
      <FeedbackInspector
        draftPin={null}
        feedback={[feedback()]}
        hiddenPinStatuses={[]}
        onCancelDraft={vi.fn()}
        onCreate={vi.fn()}
        onRecoverDraft={vi.fn()}
        onSelectFeedback={vi.fn()}
        onTogglePinStatus={onTogglePinStatus}
        onUpdate={vi.fn()}
        projectId="demo"
        screens={reviewScreens}
        selectedFeedbackId={null}
        selectedScreenId="landing"
        version="live"
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Collapse Backlog comments",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Clarify the primary action.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show Backlog pins" }));
    expect(onTogglePinStatus).toHaveBeenCalledWith("OPEN");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    first.unmount();
    render(
      <FeedbackInspector
        draftPin={null}
        feedback={[feedback()]}
        onCancelDraft={vi.fn()}
        onCreate={vi.fn()}
        onRecoverDraft={vi.fn()}
        onSelectFeedback={vi.fn()}
        onUpdate={vi.fn()}
        projectId="demo"
        screens={reviewScreens}
        selectedFeedbackId={null}
        selectedScreenId="landing"
        version="live"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Expand Backlog comments" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("puts a new draft in an open Backlog section and scrolls the editor into view", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    localStorage.setItem(
      "screencheck:collapsed-feedback-statuses",
      JSON.stringify(["OPEN"]),
    );

    renderInspector({
      draftPin: { x: 0.4, y: 0.6 },
      initialFeedback: [
        feedback({ status: "IN_PROGRESS", tags: ["P0"], note: "Old edit" }),
      ],
    });

    expect(
      screen.getByRole("button", { name: "Collapse Backlog comments" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Feedback note" })).toHaveValue(
      "",
    );
    expect(screen.getByRole("button", { name: "P1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("textbox", { name: "Feedback note" }),
    ).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("shows the comment count to the right of the Feedback title", () => {
    renderInspector({
      initialFeedback: [
        feedback(),
        feedback({ id: "feedback-2", note: "Second" }),
      ],
    });

    // A plain div, not a second banner landmark (ux-22).
    const header = document.querySelector<HTMLElement>(
      ".feedback-inspector-header",
    )!;
    expect(within(header).getByText("Feedback")).toBeInTheDocument();
    expect(within(header).getByText("2 comments")).toHaveClass(
      "feedback-inspector-count",
    );
  });

  it("sets one priority tag at a time and adds free-text tags", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn(async (id: string, input: UpdateFeedbackInput) =>
      feedback({
        id,
        ...(input.patch as Partial<FeedbackRecord>),
        updatedAt: "2026-10-05T20:00:01.000Z",
      }),
    );
    renderInspector({ onUpdate });

    expect(screen.getByRole("button", { name: "P1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "P0" }));
    expect(screen.getByRole("button", { name: "P1" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const input = screen.getByRole("textbox", { name: "Add tag" });
    fireEvent.change(input, { target: { value: "Copy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "Remove tag Copy" }),
    ).toBeVisible();

    await act(async () => vi.advanceTimersByTime(500));
    expect(onUpdate).toHaveBeenLastCalledWith("feedback-1", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: { tags: ["P0", "Copy"] },
    });
  });
});

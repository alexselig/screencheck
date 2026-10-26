import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeedbackInspector } from "../src/client/components/feedback-inspector";
import {
  MentionText,
  ReviewerNameMenuItem,
} from "../src/client/components/reviewer-name";
import { patchFeedback, postFeedback } from "../src/client/feedback-api";
import {
  REVIEWER_NAME_KEY,
  readReviewerName,
  withReviewerAuthor,
  withReviewerMessageAuthor,
  writeReviewerName,
} from "../src/client/reviewer";
import type { FeedbackRecord } from "../src/shared/feedback";

function record(overrides: Partial<FeedbackRecord>): FeedbackRecord {
  return {
    id: "a",
    projectId: "demo",
    screenId: "landing",
    version: "live",
    x: 0.5,
    y: 0.5,
    note: "Note",
    tags: ["P1"],
    status: "OPEN",
    thread: [],
    createdAt: "2026-10-05T20:00:00.000Z",
    updatedAt: "2026-10-05T20:00:00.000Z",
    ...overrides,
  };
}

function inspector(props: {
  feedback?: FeedbackRecord[];
  selectedFeedbackId?: string | null;
  draftPin?: { x: number; y: number } | null;
}) {
  return (
    <FeedbackInspector
      draftPin={props.draftPin ?? null}
      feedback={props.feedback ?? []}
      onCancelDraft={vi.fn()}
      onCreate={vi.fn()}
      onRecoverDraft={vi.fn()}
      onSelectFeedback={vi.fn()}
      onUpdate={vi.fn()}
      projectId="demo"
      screens={[]}
      selectedFeedbackId={props.selectedFeedbackId ?? null}
      selectedScreenId="landing"
      version="live"
    />
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("reviewer name store", () => {
  it("remembers a cleaned name in this browser and forgets an empty one", () => {
    expect(readReviewerName()).toBe("");
    expect(writeReviewerName("  Ada\u0000  Lovelace ")).toBe("Ada Lovelace");
    expect(localStorage.getItem(REVIEWER_NAME_KEY)).toBe("Ada Lovelace");
    expect(readReviewerName()).toBe("Ada Lovelace");
    expect(writeReviewerName("z".repeat(80))).toHaveLength(60);
    writeReviewerName("   ");
    expect(localStorage.getItem(REVIEWER_NAME_KEY)).toBeNull();
    expect(readReviewerName()).toBe("");
  });
});

describe("author stamping in the client", () => {
  const create = {
    clientMutationId: "11111111-1111-4111-8111-111111111111",
    screenId: "landing",
    version: "live",
    x: 0.5,
    y: 0.5,
    note: "Footer floats.",
  };
  const update = {
    expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
    patch: { message: { note: "@agent look", role: "reviewer" as const } },
  };

  it("leaves requests alone without a name", () => {
    expect(withReviewerAuthor(create)).toEqual(create);
    expect(withReviewerMessageAuthor(update)).toEqual(update);
  });

  it("stamps new comments and reviewer messages, never agent ones", () => {
    writeReviewerName("Ada");
    expect(withReviewerAuthor(create).author).toBe("Ada");
    expect(withReviewerMessageAuthor(update).patch.message?.author).toBe("Ada");
    const agent = {
      ...update,
      patch: { message: { note: "Done", role: "agent" as const } },
    };
    expect(withReviewerMessageAuthor(agent)).toEqual(agent);
    expect(
      withReviewerMessageAuthor({
        ...update,
        patch: { status: "IN_PROGRESS" as const },
      }).patch,
    ).toEqual({ status: "IN_PROGRESS" });
  });

  it("sends the name with POST and PATCH", async () => {
    writeReviewerName("Ada");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            feedback: record({ author: "Ada" }),
          }),
          { status: 200 },
        );
      }),
    );
    await postFeedback("demo", create);
    await patchFeedback("demo", "a", update);
    expect(bodies[0]).toMatchObject({ author: "Ada" });
    expect(bodies[1]).toMatchObject({
      patch: { message: { author: "Ada", role: "reviewer" } },
    });
  });
});

describe("reviewer name in the feedback editor", () => {
  it("asks for a name inline the first time, then remembers it", () => {
    render(inspector({ draftPin: { x: 0.5, y: 0.5 } }));
    const editor = screen.getByRole("region", { name: "Feedback editor" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const field = within(editor).getByRole("textbox", { name: "Your name" });
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.blur(field);
    expect(localStorage.getItem(REVIEWER_NAME_KEY)).toBe("Ada");
    expect(editor).toHaveTextContent("Commenting as Ada");
    expect(within(editor).queryByRole("textbox", { name: "Your name" })).toBe(
      null,
    );

    cleanup();
    render(inspector({ draftPin: { x: 0.4, y: 0.4 } }));
    const next = screen.getByRole("region", { name: "Feedback editor" });
    expect(next).toHaveTextContent("Commenting as Ada");
    fireEvent.click(
      within(next).getByRole("button", { name: "Change your name (Ada)" }),
    );
    const change = within(next).getByRole("textbox", { name: "Your name" });
    fireEvent.change(change, { target: { value: "Ada L" } });
    fireEvent.keyDown(change, { key: "Enter" });
    expect(readReviewerName()).toBe("Ada L");
    expect(next).toHaveTextContent("Commenting as Ada L");
  });

  it("shows who left a comment, and nothing for older comments", () => {
    render(
      inspector({
        feedback: [
          record({ id: "a", note: "With name", author: "Ada" }),
          record({
            id: "b",
            note: "Without name",
            createdAt: "2026-10-05T20:01:00.000Z",
          }),
        ],
      }),
    );
    const named = screen.getByRole("button", { name: /With name/ });
    expect(named.querySelector(".feedback-comment-byline")).toHaveTextContent(
      /^Ada · /,
    );
    const older = screen.getByRole("button", { name: /Without name/ });
    expect(older.querySelector(".feedback-comment-byline")).toBeNull();
  });

  it("shows the author of each thread message with mention chips", () => {
    writeReviewerName("Ada Lovelace");
    render(
      inspector({
        selectedFeedbackId: "a",
        feedback: [
          record({
            thread: [
              {
                id: "m1",
                role: "reviewer",
                author: "Bob",
                note: "@agent and @ada please check",
                at: "2026-10-05T21:00:00.000Z",
              },
            ],
          }),
        ],
      }),
    );
    const thread = screen.getByRole("list", { name: "Thread" });
    expect(thread).toHaveTextContent("Reviewer · Bob ·");
    const chips = thread.querySelectorAll(".mention-chip");
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "@agent",
      "@ada",
    ]);
    expect(chips[0]).toHaveClass("is-agent");
    expect(chips[1]).toHaveClass("is-self");
  });
});

describe("mention chips", () => {
  it("highlights @agent and @names and leaves the rest as text", () => {
    const { container } = render(
      <MentionText text="Thanks @Agent, cc @bob. mail ada@example.com" />,
    );
    expect(container).toHaveTextContent(
      "Thanks @Agent, cc @bob. mail ada@example.com",
    );
    const chips = container.querySelectorAll(".mention-chip");
    expect([...chips].map((chip) => chip.getAttribute("data-mention"))).toEqual(
      ["agent", "bob"],
    );
  });
});

describe("Your name… in the menu", () => {
  it("edits the name in place and closes the menu", () => {
    const onDone = vi.fn();
    render(
      <div role="menu">
        <ReviewerNameMenuItem onDone={onDone} />
      </div>,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Your name…" }));
    const field = screen.getByLabelText("Your name");
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(readReviewerName()).toBe("Grace");
    expect(onDone).toHaveBeenCalled();
    expect(
      screen.getByRole("menuitem", { name: "Your name · Grace" }),
    ).toBeInTheDocument();
  });
});

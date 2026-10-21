import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/client/app";
import { installFakeFeedbackApi } from "./helpers/fake-feedback-api";

let api: Awaited<ReturnType<typeof installFakeFeedbackApi>>;

const base = {
  projectId: "example",
  screenId: "landing",
  version: "live",
  tags: ["P1"],
  createdAt: "2026-10-05T19:00:00.000Z",
  updatedAt: "2026-10-05T19:00:00.000Z",
};
const fixedId = "22222222-2222-4222-8222-222222222222";
const fixed = {
  ...base,
  id: fixedId,
  x: 0.6,
  y: 0.6,
  note: "Footer floats mid-page.",
  status: "RESOLVED",
  thread: [
    {
      id: "m1",
      role: "agent",
      author: "Copilot",
      note: "Pinned the footer to the end.",
      at: "2026-10-05T19:10:00.000Z",
      status: "RESOLVED",
    },
  ],
};
const open = {
  ...base,
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-10-05T18:00:00.000Z",
  x: 0.2,
  y: 0.2,
  note: "Header wraps.",
  status: "OPEN",
  thread: [
    {
      id: "m1",
      role: "agent",
      author: "Copilot",
      note: "Looking into it.",
      at: "2026-10-05T19:10:00.000Z",
    },
    {
      id: "m2",
      role: "reviewer",
      author: "Reviewer",
      note: "Only on narrow screens.",
      at: "2026-10-05T19:20:00.000Z",
    },
  ],
};

beforeEach(async () => {
  api = await installFakeFeedbackApi();
  await api.storage.importFeedback("example", [open, fixed] as never);
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await api.dispose();
});

async function stored(id: string) {
  return (await api.storage.listFeedback("example")).find(
    (item) => item.id === id,
  )!;
}

describe("verify step", () => {
  it("verifies a fixed comment from its card and moves it to Verified", async () => {
    render(<App />);
    const fixedSection = await screen.findByRole("region", { name: "Fixed" });
    expect(
      within(fixedSection).getByText("Pinned the footer to the end."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(fixedSection).getByRole("button", { name: "Verify pin 2" }),
    );

    await waitFor(async () =>
      expect((await stored(fixedId)).status).toBe("VERIFIED"),
    );
    const verified = await screen.findByRole("region", { name: "Verified" });
    expect(
      within(verified).getByText("Footer floats mid-page."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Fixed" })).toBeNull();
    expect(
      within(verified).queryByRole("button", { name: /Verify pin/ }),
    ).toBeNull();
    // Verified pins are hidden by default, with their own switch.
    expect(
      within(verified).getByRole("button", { name: "Show Verified pins" }),
    ).toBeInTheDocument();
    expect(
      screen
        .queryAllByTestId("feedback-pin")
        .map((pin) => pin.getAttribute("aria-label")),
    ).toEqual(["Pin 1: Header wraps."]);
    fireEvent.click(screen.getByRole("button", { name: "Show Verified pins" }));
    expect(
      screen.getByRole("button", {
        name: "Pin 2 (verified): Footer floats mid-page.",
      }),
    ).toHaveClass("is-verified");
  });

  it("offers Reopen on Verified cards and requires a reason (ux-15)", async () => {
    render(<App />);
    const fixedSection = await screen.findByRole("region", { name: "Fixed" });
    fireEvent.click(
      within(fixedSection).getByRole("button", { name: "Verify pin 2" }),
    );
    const verified = await screen.findByRole("region", { name: "Verified" });
    await waitFor(async () =>
      expect((await stored(fixedId)).status).toBe("VERIFIED"),
    );
    fireEvent.click(
      await within(verified).findByRole("button", { name: "Reopen pin 2" }),
    );
    const confirm = within(verified).getByRole("button", { name: "Reopen" });
    expect(confirm).toBeDisabled();
    fireEvent.change(
      within(verified).getByRole("textbox", { name: "Why reopen pin 2?" }),
      { target: { value: "   " } },
    );
    expect(confirm).toBeDisabled();
    fireEvent.change(
      within(verified).getByRole("textbox", { name: "Why reopen pin 2?" }),
      { target: { value: "Regressed in build-42." } },
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(async () =>
      expect((await stored(fixedId)).status).toBe("OPEN"),
    );
    expect((await stored(fixedId)).thread?.at(-1)).toEqual(
      expect.objectContaining({
        role: "reviewer",
        note: "Regressed in build-42.",
      }),
    );
  });

  it("reopens with a reason, keeping the thread", async () => {
    render(<App />);
    const fixedSection = await screen.findByRole("region", { name: "Fixed" });
    fireEvent.click(
      within(fixedSection).getByRole("button", { name: "Reopen pin 2" }),
    );
    fireEvent.change(
      within(fixedSection).getByRole("textbox", { name: "Why reopen pin 2?" }),
      { target: { value: "Still floats on mobile." } },
    );
    fireEvent.click(
      within(fixedSection).getByRole("button", { name: "Reopen" }),
    );

    await waitFor(async () =>
      expect((await stored(fixedId)).status).toBe("OPEN"),
    );
    const record = await stored(fixedId);
    expect(record.thread).toEqual([
      fixed.thread[0],
      expect.objectContaining({
        role: "reviewer",
        note: "Still floats on mobile.",
        status: "OPEN",
      }),
    ]);
    const backlog = await screen.findByRole("region", { name: "Backlog" });
    await waitFor(() =>
      expect(
        within(backlog).getByText("Still floats on mobile."),
      ).toBeInTheDocument(),
    );
  });

  it("asks before approving a screen with unverified fixes", async () => {
    render(<App />);
    await screen.findByText("Footer floats mid-page.");
    const approve = await screen.findByRole("button", {
      name: "Approve screen",
    });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);

    const confirm = screen.getByRole("group", { name: "Confirm approval" });
    expect(confirm).toHaveTextContent("1 fix not verified. Approve anyway?");
    expect(await api.storage.listApprovals("example")).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("group", { name: "Confirm approval" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Approve screen" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Confirm approval" })).getByRole(
        "button",
        { name: "Approve" },
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Screen approved" }),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(await api.storage.listApprovals("example")).toHaveLength(1),
    );
  });
});

describe("approval confirm focus (ux-12)", () => {
  async function openConfirm() {
    render(<App />);
    await screen.findByText("Footer floats mid-page.");
    const approve = await screen.findByRole("button", {
      name: "Approve screen",
    });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    return screen.getByRole("group", { name: "Confirm approval" });
  }

  it("cancels on Escape and returns focus to the approval toggle", async () => {
    const confirm = await openConfirm();
    const cancel = within(confirm).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(
      screen.queryByRole("group", { name: "Confirm approval" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Approve screen" }),
    ).toHaveFocus();
    expect(await api.storage.listApprovals("example")).toEqual([]);
  });

  it("returns focus to the toggle after approving anyway", async () => {
    const confirm = await openConfirm();
    fireEvent.click(within(confirm).getByRole("button", { name: "Approve" }));
    const toggle = await screen.findByRole("button", {
      name: "Screen approved",
    });
    expect(toggle).toHaveFocus();
  });
});

describe("approve shortcut", () => {
  it("asks first on Cmd+A when fixes are unverified; a second press approves", async () => {
    render(<App />);
    await screen.findByText("Footer floats mid-page.");
    const approve = await screen.findByRole("button", {
      name: "Approve screen",
    });
    await waitFor(() => expect(approve).toBeEnabled());

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(
      screen.getByRole("group", { name: "Confirm approval" }),
    ).toHaveTextContent("1 fix not verified. Approve anyway?");
    expect(await api.storage.listApprovals("example")).toEqual([]);

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(
      await screen.findByRole("button", { name: "Screen approved" }),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(await api.storage.listApprovals("example")).toHaveLength(1),
    );
  });
});

describe("threads", () => {
  it("shows only the latest message on a collapsed card", async () => {
    render(<App />);
    const card = await screen.findByRole("button", { name: /Header wraps\./ });
    expect(within(card).getAllByTestId("feedback-reply")).toHaveLength(1);
    expect(card).toHaveTextContent("Only on narrow screens.");
    expect(card).not.toHaveTextContent("Looking into it.");
  });

  it("shows the whole thread in the editor and adds a reviewer reply", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Header wraps."));
    const editor = await screen.findByRole("region", {
      name: "Feedback editor",
    });
    const thread = within(editor).getByRole("list", { name: "Thread" });
    expect(within(thread).getAllByRole("listitem")).toHaveLength(2);
    expect(thread).toHaveTextContent("Reply · Copilot ·");
    expect(thread).toHaveTextContent("Reviewer ·");

    const send = within(editor).getByRole("button", { name: "Reply" });
    expect(send).toBeDisabled();
    const box = within(editor).getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "Also at 390px." } });
    fireEvent.click(send);

    await waitFor(() =>
      expect(within(thread).getAllByRole("listitem")).toHaveLength(3),
    );
    expect(thread).toHaveTextContent("Also at 390px.");
    expect(box).toHaveValue("");
    const record = await stored(open.id);
    expect(record.status).toBe("OPEN");
    expect(record.thread!.at(-1)).toMatchObject({
      role: "reviewer",
      author: "Reviewer",
      note: "Also at 390px.",
    });
    expect(record.thread!.at(-1)).not.toHaveProperty("status");
  });

  it("asks for a reply before closing from the status picker", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Header wraps."));
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Feedback status" }),
      { target: { value: "WONT_FIX" } },
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add a reply before closing this feedback.",
    );
    expect((await stored(open.id)).status).toBe("OPEN");
  });
});

describe("focus after actions (ux-7)", () => {
  const note = () => screen.getByRole("textbox", { name: "Feedback note" });

  it("moves focus into the editor after selecting a pin or a card", async () => {
    render(<App />);
    const pin = await screen.findByRole("button", {
      name: "Pin 1: Header wraps.",
    });
    pin.focus();
    fireEvent.click(pin);
    await waitFor(() => expect(note()).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Collapse comment 1" }));
    const card = await screen.findByText("Header wraps.", {
      selector: ".feedback-comment strong",
    });
    await waitFor(() => expect(card.closest("button")).toHaveFocus());
    fireEvent.click(card);
    await waitFor(() => expect(note()).toHaveFocus());
  });

  it("collapsing a Fixed comment (hidden pin) focuses its card", async () => {
    render(<App />);
    const fixedSection = await screen.findByRole("region", { name: "Fixed" });
    fireEvent.click(
      within(fixedSection).getByText("Footer floats mid-page.", {
        selector: ".feedback-comment strong",
      }),
    );
    await waitFor(() => expect(note()).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Collapse comment 2" }));
    await waitFor(() =>
      expect(
        within(fixedSection)
          .getByText("Footer floats mid-page.", {
            selector: ".feedback-comment strong",
          })
          .closest("button"),
      ).toHaveFocus(),
    );
  });

  it("Verify focuses the card in its new section", async () => {
    render(<App />);
    const fixedSection = await screen.findByRole("region", { name: "Fixed" });
    const verify = within(fixedSection).getByRole("button", {
      name: "Verify pin 2",
    });
    verify.focus();
    fireEvent.click(verify);
    const verified = await screen.findByRole("region", { name: "Verified" });
    await waitFor(() =>
      expect(
        within(verified)
          .getByText("Footer floats mid-page.", {
            selector: ".feedback-comment strong",
          })
          .closest("button"),
      ).toHaveFocus(),
    );
  });

  it("Reply returns focus to the reply box", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByText("Header wraps.", {
        selector: ".feedback-comment strong",
      }),
    );
    const reply = await screen.findByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "Thanks." } });
    const send = screen.getByRole("button", { name: "Reply" });
    send.focus();
    fireEvent.click(send);
    await waitFor(() => expect(reply).toHaveValue(""));
    await waitFor(() => expect(reply).toHaveFocus());
  });

  it("delete confirm focuses Keep, and Confirm delete moves to the next card", async () => {
    render(<App />);
    await screen.findByText("Header wraps.", {
      selector: ".feedback-comment strong",
    });
    const x = screen.getByRole("button", { name: "Delete comment 1" });
    x.focus();
    fireEvent.click(x);
    const keep = screen.getByRole("button", { name: "Keep" });
    expect(keep).toHaveFocus();
    fireEvent.click(keep);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete comment 1" }),
      ).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete comment 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.queryByText("Header wraps.")).toBeNull());
    await waitFor(() =>
      expect(
        screen
          .getByText("Footer floats mid-page.", {
            selector: ".feedback-comment strong",
          })
          .closest("button"),
      ).toHaveFocus(),
    );
  });
});

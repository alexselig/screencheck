import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistEditorTools,
  RoundSummaryDialog,
  SummariseRoundMenuItem,
} from "../src/client/components/assist";
import { resetAssistStatus } from "../src/client/use-assist";

type Handler = (body: Record<string, unknown>) => unknown;

function stubAssist(
  status: { enabled: boolean; available: boolean },
  routes: Record<string, Handler> = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/assist") {
      return new Response(JSON.stringify(status), { status: 200 });
    }
    const action = url.replace("/api/assist/", "");
    const handler = routes[action];
    if (!handler) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const on = { enabled: true, available: true };

function tools(
  overrides: Partial<Parameters<typeof AssistEditorTools>[0]> = {},
) {
  const props = {
    projectId: "demo",
    version: "v1",
    screenId: "landing",
    editingId: null,
    note: "button hard to see",
    tags: ["P1", "Copy"],
    pinNumbers: new Map([["other", 2]]),
    onApplyNote: vi.fn(),
    onApplyTags: vi.fn(),
    ...overrides,
  };
  render(<AssistEditorTools {...props} />);
  return props;
}

beforeEach(() => resetAssistStatus());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI assist UI", () => {
  it("shows nothing when assist is off or the CLI is unavailable", async () => {
    for (const status of [
      { enabled: false, available: false },
      { enabled: true, available: false },
    ]) {
      resetAssistStatus();
      const fetchMock = stubAssist(status);
      tools();
      render(<SummariseRoundMenuItem onOpen={() => {}} />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.queryByRole("button", { name: /rewrite/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /suggest/i })).toBeNull();
      expect(screen.queryByRole("menuitem")).toBeNull();
      cleanup();
    }
  });

  it("hides assist when the server can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    tools();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /rewrite/i })).toBeNull();
  });

  it("offers a rewrite and applies it only on accept", async () => {
    stubAssist(on, {
      rewrite: () => ({ instruction: "Raise the button contrast to 4.5:1." }),
    });
    const props = tools();
    fireEvent.click(
      await screen.findByRole("button", { name: "Rewrite for agent" }),
    );
    expect(
      await screen.findByText("Raise the button contrast to 4.5:1."),
    ).toBeInTheDocument();
    expect(props.onApplyNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use rewrite" }));
    expect(props.onApplyNote).toHaveBeenCalledWith(
      "Raise the button contrast to 4.5:1.",
    );
    expect(
      screen.queryByText("Raise the button contrast to 4.5:1."),
    ).toBeNull();
  });

  it("dismisses a rewrite without touching the note", async () => {
    stubAssist(on, { rewrite: () => ({ instruction: "Do X." }) });
    const props = tools();
    fireEvent.click(
      await screen.findByRole("button", { name: "Rewrite for agent" }),
    );
    await screen.findByText("Do X.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss rewrite" }));
    expect(screen.queryByText("Do X.")).toBeNull();
    expect(props.onApplyNote).not.toHaveBeenCalled();
  });

  it("suggests tags and applies them only on accept", async () => {
    const fetchMock = stubAssist(on, {
      suggest: () => ({ priority: "P0", tags: ["Contrast"] }),
    });
    const props = tools();
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggest tags" }),
    );
    expect(await screen.findByText("Contrast")).toBeInTheDocument();
    expect(props.onApplyTags).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply tags" }));
    expect(props.onApplyTags).toHaveBeenCalledWith(["P0", "Copy", "Contrast"]);
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("suggest"));
    expect(new Headers(call![1]!.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("shows a possible duplicate by pin number", async () => {
    stubAssist(on, {
      duplicates: (body) =>
        body.note ? { duplicates: [{ id: "other", score: 0.8 }] } : {},
    });
    tools({ note: "contrast on the continue button is low" });
    expect(
      await screen.findByText(/possible duplicate of #2/i, undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
  });

  it("opens a round summary from the menu and copies it", async () => {
    stubAssist(on, { summary: () => ({ markdown: "## Round\n- 2 open" }) });
    const onOpen = vi.fn();
    render(<SummariseRoundMenuItem onOpen={onOpen} />);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Summarise round…" }),
    );
    expect(onOpen).toHaveBeenCalled();
    cleanup();

    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const onClose = vi.fn();
    render(
      <RoundSummaryDialog projectId="demo" version="v1" onClose={onClose} />,
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Summary markdown")).toHaveValue(
        "## Round\n- 2 open",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("## Round\n- 2 open");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

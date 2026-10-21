import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalBar } from "../src/client/components/approval-bar";
import { VerifyActions } from "../src/client/components/verify-actions";
import {
  MAX_OWN_REVISIONS,
  ownRevisionTracker,
} from "../src/client/use-feedback-store";

afterEach(cleanup);

describe("own revision tracker (ux-19)", () => {
  it("rebases a queued write onto this tab's newest save", () => {
    const own = ownRevisionTracker();
    own.saved("a", "r0", "r1");
    own.saved("a", "r1", "r2");
    expect(own.latest("a", "r0")).toBe("r2");
    expect(own.latest("a", "r1")).toBe("r2");
    expect(own.latest("a", "r2")).toBe("r2");
    // A revision written elsewhere is left alone, so the server reports the
    // conflict.
    expect(own.latest("a", "elsewhere")).toBe("elsewhere");
  });

  it("keeps a bounded history per comment and forgets deleted ones", () => {
    const own = ownRevisionTracker();
    for (let n = 0; n < 200; n += 1) own.saved("a", `r${n}`, `r${n + 1}`);
    expect(own.replacedCount("a")).toBe(MAX_OWN_REVISIONS);
    expect(own.latest("a", "r199")).toBe("r200");
    own.saved("b", "x0", "x1");
    own.forget("a");
    expect(own.size).toBe(1);
    own.clear();
    expect(own.size).toBe(0);
  });

  it("starts over when a save did not follow this tab's last one", () => {
    const own = ownRevisionTracker();
    own.saved("a", "r0", "r1");
    own.saved("a", "theirs", "r2");
    expect(own.latest("a", "r0")).toBe("r0");
    expect(own.latest("a", "theirs")).toBe("r2");
  });
});

describe("ApprovalBar", () => {
  it("asks before approving over unverified fixes", () => {
    const onAskConfirm = vi.fn();
    const onToggle = vi.fn();
    const props = {
      approved: false,
      disabled: false,
      unverifiedFixes: 2,
      onToggle,
      onAskConfirm,
      onCloseConfirm: vi.fn(),
    };
    const { rerender } = render(<ApprovalBar {...props} confirming={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve screen/ }));
    expect(onAskConfirm).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();

    rerender(<ApprovalBar {...props} confirming />);
    expect(
      screen.getByRole("group", { name: "Confirm approval" }),
    ).toHaveTextContent("2 fixes not verified. Approve anyway?");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), {
      key: "Escape",
    });
    expect(props.onCloseConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("toggles straight away with nothing unverified", () => {
    const onToggle = vi.fn();
    render(
      <ApprovalBar
        approved
        confirming={false}
        disabled={false}
        onAskConfirm={vi.fn()}
        onCloseConfirm={vi.fn()}
        onToggle={onToggle}
        unverifiedFixes={0}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Screen approved/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("VerifyActions", () => {
  it("offers Verify only on fixed comments", () => {
    const props = {
      pin: 3,
      reopening: false,
      reopenDraft: "",
      onReopenDraftChange: vi.fn(),
      onVerify: vi.fn(),
      onStartReopen: vi.fn(),
      onConfirmReopen: vi.fn(),
      onCancelReopen: vi.fn(),
    };
    const { rerender } = render(<VerifyActions {...props} status="RESOLVED" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify pin 3" }));
    expect(props.onVerify).toHaveBeenCalledOnce();
    rerender(<VerifyActions {...props} status="VERIFIED" />);
    expect(screen.queryByRole("button", { name: "Verify pin 3" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reopen pin 3" }));
    expect(props.onStartReopen).toHaveBeenCalledOnce();
  });

  it("needs a reason before reopening", () => {
    const onConfirmReopen = vi.fn();
    const props = {
      pin: 1,
      status: "RESOLVED" as const,
      reopening: true,
      onReopenDraftChange: vi.fn(),
      onVerify: vi.fn(),
      onStartReopen: vi.fn(),
      onConfirmReopen,
      onCancelReopen: vi.fn(),
    };
    const { rerender } = render(<VerifyActions {...props} reopenDraft="  " />);
    expect(screen.getByRole("button", { name: "Reopen" })).toBeDisabled();
    rerender(<VerifyActions {...props} reopenDraft=" Still broken " />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onConfirmReopen).toHaveBeenCalledWith("Still broken");
  });
});

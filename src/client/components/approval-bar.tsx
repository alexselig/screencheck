import type { RefObject } from "react";

import { SHORTCUTS } from "../shortcuts";

// The approve toggle at the foot of the inspector. With unverified fixes on
// the screen, approving asks first; Esc or Cancel backs out.
export function ApprovalBar({
  approved,
  disabled,
  confirming,
  unverifiedFixes,
  toggleRef,
  onToggle,
  onAskConfirm,
  onCloseConfirm,
}: {
  approved: boolean;
  disabled: boolean;
  confirming: boolean;
  unverifiedFixes: number;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onAskConfirm: () => void;
  onCloseConfirm: () => void;
}) {
  const label = SHORTCUTS.approve.label;
  return (
    <div className="screen-approval">
      {confirming && !approved && unverifiedFixes > 0 ? (
        <div
          aria-label="Confirm approval"
          className="screen-approval-confirm"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onCloseConfirm();
          }}
          role="group"
        >
          <span>
            {unverifiedFixes} fix{unverifiedFixes === 1 ? "" : "es"} not
            verified. Approve anyway?
          </span>
          <button
            className="screen-approval-anyway"
            onClick={() => {
              onCloseConfirm();
              onToggle();
            }}
            type="button"
          >
            Approve
          </button>
          <button autoFocus onClick={onCloseConfirm} type="button">
            Cancel
          </button>
        </div>
      ) : (
        <button
          aria-pressed={approved}
          className="screen-approval-toggle"
          ref={toggleRef}
          disabled={disabled}
          onClick={() => {
            if (!approved && unverifiedFixes > 0) onAskConfirm();
            else onToggle();
          }}
          aria-keyshortcuts={SHORTCUTS.approve.aria}
          title={`${approved ? "Click to unapprove" : "Approve screen"} (${label})`}
          type="button"
        >
          <span aria-hidden="true" className="screen-approval-box">
            {approved ? "✓" : ""}
          </span>
          {approved ? "Screen approved" : "Approve screen"}
          <kbd aria-hidden="true">{label}</kbd>
        </button>
      )}
    </div>
  );
}

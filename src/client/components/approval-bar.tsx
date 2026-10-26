import { useState, type RefObject } from "react";

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
  allSizes,
  onApproveAll,
  sizeLabel,
}: {
  approved: boolean;
  disabled: boolean;
  confirming: boolean;
  unverifiedFixes: number;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onAskConfirm: () => void;
  onCloseConfirm: () => void;
  // Every size of this screen, when it has more than one.
  allSizes?: SizeApproval[];
  onApproveAll?: () => void;
  // The size the toggle approves, when the screen has several.
  sizeLabel?: string;
}) {
  const at = sizeLabel ? ` at ${sizeLabel}` : "";
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
          title={`${approved ? "Click to unapprove" : `Approve screen${at}`} (${label})`}
          type="button"
        >
          <span aria-hidden="true" className="screen-approval-box">
            {approved ? "✓" : ""}
          </span>
          {approved ? `Screen approved${at}` : `Approve screen${at}`}
          <kbd aria-hidden="true">{label}</kbd>
        </button>
      )}
      {allSizes && allSizes.length > 1 && onApproveAll ? (
        <ApproveAllSizes
          disabled={disabled}
          onApproveAll={onApproveAll}
          sizes={allSizes}
        />
      ) : null}
    </div>
  );
}

export type SizeApproval = {
  label: string;
  approved: boolean;
  unverifiedFixes: number;
};

// Approves every size still to review, asking first when any of them has
// fixes nobody has verified, as the single toggle does.
function ApproveAllSizes({
  sizes,
  disabled,
  onApproveAll,
}: {
  sizes: SizeApproval[];
  disabled: boolean;
  onApproveAll: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pending = sizes.filter((size) => !size.approved);
  const unverified = pending.filter((size) => size.unverifiedFixes > 0);
  if (confirming && unverified.length > 0) {
    return (
      <div
        aria-label="Confirm approval of all sizes"
        className="screen-approval-confirm"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setConfirming(false);
        }}
        role="group"
      >
        <span>
          {unverified
            .map(
              (size) =>
                `${size.label}: ${size.unverifiedFixes} fix${size.unverifiedFixes === 1 ? "" : "es"} not verified`,
            )
            .join("; ")}
          . Approve all anyway?
        </span>
        <button
          className="screen-approval-anyway"
          onClick={() => {
            setConfirming(false);
            onApproveAll();
          }}
          type="button"
        >
          Approve
        </button>
        <button autoFocus onClick={() => setConfirming(false)} type="button">
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      className="screen-approval-all"
      disabled={disabled || pending.length === 0}
      onClick={() => {
        if (unverified.length > 0) setConfirming(true);
        else onApproveAll();
      }}
      title={
        pending.length === 0
          ? "Every size is approved"
          : `Approve ${pending.map((size) => size.label).join(", ")}`
      }
      type="button"
    >
      {pending.length === 0 ? "All sizes approved" : "Approve all sizes"}
    </button>
  );
}

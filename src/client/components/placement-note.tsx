import type { FeedbackRecord, FeedbackScope } from "../../shared/feedback";
import { scopeOf } from "../../shared/feedback";
import { pinnedAtOf } from "../all-sizes";

// "All sizes · Pinned at 1440" and "Check placement" under a comment's note.
export function PlacementLine({ item }: { item: FeedbackRecord }) {
  const pinnedAt = pinnedAtOf(item);
  const allSizes = scopeOf(item) === "all";
  const check = item.checkPlacement === true;
  if (!allSizes && !check) return null;
  return (
    <span className="feedback-placement" data-testid="feedback-placement">
      {allSizes ? (
        <span className="feedback-scope">
          All sizes{pinnedAt ? ` · Pinned at ${pinnedAt}` : ""}
        </span>
      ) : null}
      {check ? (
        <span
          className="feedback-check-placement"
          title="This comment was carried from an older build and its element moved or wasn't found. Check the pin still points at the right thing."
        >
          Check placement
        </span>
      ) : null}
    </span>
  );
}

// Clears a carried comment's "Check placement" flag.
export function PlacementOk({
  item,
  pin,
  onConfirm,
  framed = false,
}: {
  item: FeedbackRecord;
  pin: number;
  onConfirm: () => void;
  framed?: boolean;
}) {
  if (item.checkPlacement !== true) return null;
  const button = (
    <button
      aria-label={`Placement OK for pin ${pin}`}
      className="feedback-placement-ok"
      onClick={onConfirm}
      type="button"
    >
      Placement OK
    </button>
  );
  // On a closed card the button hangs under it, inside the same frame.
  return framed ? (
    <div className="feedback-placement-actions">{button}</div>
  ) : (
    button
  );
}

// This size / All sizes, for a comment on a screen with several sizes.
export function ScopeChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: FeedbackScope;
  onChange: (scope: FeedbackScope) => void;
  disabled?: boolean;
}) {
  return (
    <div
      aria-label="Comment applies to"
      className="segmented feedback-scope-choice"
      role="group"
    >
      {(
        [
          ["size", "This size"],
          ["all", "All sizes"],
        ] as const
      ).map(([scope, label]) => (
        <button
          aria-pressed={value === scope}
          disabled={disabled}
          key={scope}
          onClick={() => {
            if (value !== scope) onChange(scope);
          }}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

import type { FeedbackStatus } from "../../shared/feedback";

// Verify / Reopen on a fixed or verified comment. Reopening asks why, since
// the reason is the agent's next instruction.
export function VerifyActions({
  pin,
  status,
  reopening,
  reopenDraft,
  message,
  onReopenDraftChange,
  onVerify,
  onStartReopen,
  onConfirmReopen,
  onCancelReopen,
}: {
  pin: number;
  status: FeedbackStatus;
  reopening: boolean;
  reopenDraft: string;
  message?: string;
  onReopenDraftChange: (value: string) => void;
  onVerify: () => void;
  onStartReopen: () => void;
  onConfirmReopen: (note: string) => void;
  onCancelReopen: () => void;
}) {
  return (
    <div
      aria-label={`Check the fix for pin ${pin}`}
      className="feedback-verify"
      role="group"
    >
      {reopening ? (
        <label>
          Why reopen?
          <textarea
            aria-label={`Why reopen pin ${pin}?`}
            autoFocus
            onChange={(event) => onReopenDraftChange(event.target.value)}
            placeholder="What still needs to change?"
            value={reopenDraft}
          />
        </label>
      ) : null}
      <div className="feedback-verify-buttons">
        {reopening ? (
          <>
            <button
              className="feedback-reopen-confirm"
              // Reopening without a reason tells the agent nothing.
              disabled={!reopenDraft.trim()}
              onClick={() => {
                const note = reopenDraft.trim();
                if (note) onConfirmReopen(note);
              }}
              type="button"
            >
              Reopen
            </button>
            <button onClick={onCancelReopen} type="button">
              Cancel
            </button>
          </>
        ) : (
          <>
            {status === "RESOLVED" ? (
              <button
                aria-label={`Verify pin ${pin}`}
                className="feedback-verify-button"
                onClick={onVerify}
                type="button"
              >
                Verify
              </button>
            ) : null}
            <button
              aria-label={`Reopen pin ${pin}`}
              onClick={onStartReopen}
              type="button"
            >
              Reopen
            </button>
          </>
        )}
      </div>
      {message ? (
        <span aria-live="polite" className="feedback-verify-state">
          {message}
        </span>
      ) : null}
    </div>
  );
}

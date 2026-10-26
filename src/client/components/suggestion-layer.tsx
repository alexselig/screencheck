import { useEffect, useRef } from "react";

import type { Suggestion } from "../../shared/a11y";
import type { SuggestionsState } from "../use-suggestions";
import { PinBoxOutline } from "./pin-layer";

const cardId = (suggestion: Suggestion) =>
  `suggestion-card-${suggestion.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

// Ghost pins for automated accessibility findings: a dashed box on the
// element and a "Suggested" tab that opens a small card. Rendered inside the
// feedback pin layer, so they share its coordinates.
export function SuggestionLayer({
  state,
  hidden,
}: {
  state: SuggestionsState;
  hidden: boolean;
}) {
  if (hidden || !state.show || !state.suggestions.length) return null;
  const { open } = state;
  return (
    <>
      {state.suggestions.map((suggestion) => {
        const isOpen = open?.id === suggestion.id;
        return [
          <PinBoxOutline
            box={suggestion.box}
            className={`is-suggested${isOpen ? " is-selected" : ""}`}
            key={`${suggestion.id}-box`}
            testId="suggestion-box"
          />,
          <button
            aria-controls={isOpen ? cardId(suggestion) : undefined}
            aria-expanded={isOpen}
            aria-label={`Suggested: ${suggestion.help}`}
            className={`suggestion-ghost${suggestion.box.y < 0.02 ? " is-inside" : ""}`}
            data-ghost-id={suggestion.id}
            data-testid="suggestion-ghost"
            key={suggestion.id}
            onClick={() => state.setOpenId(isOpen ? null : suggestion.id)}
            style={{
              left: `${suggestion.box.x * 100}%`,
              top: `${suggestion.box.y * 100}%`,
            }}
            type="button"
          >
            Suggested
          </button>,
        ];
      })}
      {open ? <SuggestionCard state={state} suggestion={open} /> : null}
    </>
  );
}

function SuggestionCard({
  state,
  suggestion,
}: {
  state: SuggestionsState;
  suggestion: Suggestion;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [suggestion.id]);

  const close = () => {
    state.setOpenId(null);
    document
      .querySelector<HTMLElement>(
        `[data-ghost-id="${CSS.escape(suggestion.id)}"]`,
      )
      ?.focus();
  };
  const { box } = suggestion;
  const below = box.y + box.h < 0.7;
  return (
    <div
      aria-label="Suggested accessibility comment"
      className="suggestion-card"
      data-testid="suggestion-card"
      id={cardId(suggestion)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
      role="dialog"
      style={{
        left: `min(${box.x * 100}%, calc(100% - var(--suggestion-card-width)))`,
        ...(below
          ? { top: `${(box.y + box.h) * 100}%` }
          : { bottom: `${(1 - box.y) * 100}%` }),
      }}
    >
      <div className="suggestion-card-head">
        <span className="suggestion-card-eyebrow">
          Suggested{suggestion.impact ? ` · ${suggestion.impact}` : ""}
        </span>
        <button
          aria-label="Close suggestion"
          className="suggestion-card-close"
          onClick={close}
          type="button"
        >
          ×
        </button>
      </div>
      <p className="suggestion-card-help">{suggestion.help}</p>
      <p className="suggestion-card-meta">
        <code>{suggestion.ruleId}</code> on <code>{suggestion.target}</code>
      </p>
      {suggestion.summary ? (
        <p className="suggestion-card-summary">{suggestion.summary}</p>
      ) : null}
      {suggestion.helpUrl ? (
        <a
          className="suggestion-card-link"
          href={suggestion.helpUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          How to fix
        </a>
      ) : null}
      {state.error ? (
        <p className="suggestion-card-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="suggestion-card-actions">
        <button
          className="suggestion-card-promote"
          disabled={state.busy}
          onClick={() => void state.promote(suggestion)}
          ref={primary}
          type="button"
        >
          Add as comment
        </button>
        <button
          className="suggestion-card-dismiss"
          disabled={state.busy}
          onClick={() => void state.dismiss(suggestion)}
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// "Suggestions" on/off, shown only when the screen has some.
export function SuggestionsToggle({
  state,
  hidden,
}: {
  state: SuggestionsState;
  hidden: boolean;
}) {
  const count = state.suggestions.length;
  if (hidden || !count) return null;
  return (
    <button
      aria-checked={state.show}
      className="suggestions-switch"
      onClick={() => {
        state.setShow(!state.show);
        state.setOpenId(null);
      }}
      role="switch"
      title={`${state.show ? "Hide" : "Show"} suggested accessibility comments`}
      type="button"
    >
      <span aria-hidden="true" className="suggestions-switch-track" />
      Suggestions
      <span className="suggestions-switch-count">{count}</span>
    </button>
  );
}

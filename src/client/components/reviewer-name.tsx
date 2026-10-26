import { useId, useRef, useState, type KeyboardEvent } from "react";

import { AUTHOR_MAX_LENGTH } from "../../shared/feedback";
import { splitMentions } from "../../shared/mentions";
import {
  normalizeReviewerName,
  useReviewerName,
  writeReviewerName,
} from "../reviewer";

// Inline in the feedback editor: asks for a name the first time, without a
// modal, then stays out of the way as "Commenting as …".
export function ReviewerNameField() {
  const name = useReviewerName();
  // Shown until this editor closes, so it doesn't vanish mid-sentence.
  const [editing, setEditing] = useState(() => !name);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  function save() {
    const saved = writeReviewerName(draft);
    setDraft(saved);
    if (saved) setEditing(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  }

  if (!editing && name) {
    return (
      <p className="reviewer-name-line">
        Commenting as <strong>{name}</strong>
        <button
          aria-label={`Change your name (${name})`}
          className="reviewer-name-change"
          onClick={() => {
            setDraft(name);
            setEditing(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          type="button"
        >
          Change
        </button>
      </p>
    );
  }
  return (
    <label className="reviewer-name-field">
      Your name
      <input
        aria-label="Your name"
        autoComplete="name"
        maxLength={AUTHOR_MAX_LENGTH}
        onBlur={save}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Shown on your comments"
        ref={inputRef}
        value={draft}
      />
    </label>
  );
}

// "Your name…" in the "…" menu: edits the name in place, inside the menu.
export function ReviewerNameMenuItem({ onDone }: { onDone: () => void }) {
  const name = useReviewerName();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputId = useId();

  function save() {
    writeReviewerName(draft);
    setEditing(false);
    onDone();
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        role="menuitem"
        type="button"
      >
        {name ? `Your name · ${name}` : "Your name…"}
      </button>
    );
  }
  return (
    <form
      className="reviewer-name-menu-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={inputId}>Your name</label>
      <input
        autoComplete="name"
        autoFocus
        id={inputId}
        maxLength={AUTHOR_MAX_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }
        }}
        placeholder="Shown on your comments"
        value={draft}
      />
      <button type="submit">Save</button>
    </form>
  );
}

function isSelf(mention: string, name: string) {
  const self = normalizeReviewerName(name).toLowerCase();
  if (!self) return false;
  const wanted = mention.toLowerCase();
  return wanted === self.replace(/\s+/g, "") || wanted === self.split(" ")[0];
}

// A note with `@agent` and `@name` shown as chips.
export function MentionText({ text }: { text: string }) {
  const name = useReviewerName();
  return (
    <>
      {splitMentions(text).map((segment, index) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <span
            className={[
              "mention-chip",
              segment.name.toLowerCase() === "agent" ? "is-agent" : "",
              isSelf(segment.name, name) ? "is-self" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-mention={segment.name.toLowerCase()}
            key={index}
          >
            {segment.text}
          </span>
        ),
      )}
    </>
  );
}

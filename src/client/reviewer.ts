import { useSyncExternalStore } from "react";

import {
  AUTHOR_MAX_LENGTH,
  cleanAuthorName,
  type CreateFeedbackInput,
  type UpdateFeedbackInput,
} from "../shared/feedback";

// Who is reviewing in this browser. No accounts: the name lives in
// localStorage and is stamped on the comments and replies sent from here.
export const REVIEWER_NAME_KEY = "screencheck:reviewer-name";
const CHANGE_EVENT = "screencheck:reviewer-name-change";

export function normalizeReviewerName(value: string): string {
  return cleanAuthorName(value).slice(0, AUTHOR_MAX_LENGTH).trim();
}

export function readReviewerName(): string {
  if (typeof window === "undefined") return "";
  try {
    return normalizeReviewerName(
      window.localStorage.getItem(REVIEWER_NAME_KEY) ?? "",
    );
  } catch {
    return "";
  }
}

// An empty name forgets it. Returns the name as stored.
export function writeReviewerName(value: string): string {
  const name = normalizeReviewerName(value);
  try {
    if (name) window.localStorage.setItem(REVIEWER_NAME_KEY, name);
    else window.localStorage.removeItem(REVIEWER_NAME_KEY);
  } catch {
    // Storage can be full or blocked; the name just isn't remembered.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return name;
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === REVIEWER_NAME_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useReviewerName(): string {
  return useSyncExternalStore(subscribe, readReviewerName, () => "");
}

// A new comment carries the reviewer's name, when one is set.
export function withReviewerAuthor(
  input: CreateFeedbackInput,
): CreateFeedbackInput {
  const name = readReviewerName();
  return name && !input.author ? { ...input, author: name } : input;
}

// So does a reviewer message added to a thread. Agent messages keep theirs.
export function withReviewerMessageAuthor(
  input: UpdateFeedbackInput,
): UpdateFeedbackInput {
  const { message } = input.patch;
  const name = readReviewerName();
  if (!name || !message || message.author || message.role === "agent") {
    return input;
  }
  return {
    ...input,
    patch: { ...input.patch, message: { ...message, author: name } },
  };
}

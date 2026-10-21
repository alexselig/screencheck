import { STATUS_LABELS } from "../shared/feedback";

// Friendly names an agent is likely to use, mapped to API values. Anything
// else is upper-snake-cased and passed through, so statuses added later (for
// example VERIFIED) work without a change here.
const STATUS_ALIASES: Record<string, string> = {
  backlog: "OPEN",
  open: "OPEN",
  todo: "OPEN",
  "in-progress": "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  "in progress": "IN_PROGRESS",
  fixed: "RESOLVED",
  resolved: "RESOLVED",
  done: "RESOLVED",
  "wont-fix": "WONT_FIX",
  wont_fix: "WONT_FIX",
  "won't-fix": "WONT_FIX",
  "won't fix": "WONT_FIX",
  "wont fix": "WONT_FIX",
  verified: "VERIFIED",
};

export const OPEN_STATUSES = ["OPEN", "IN_PROGRESS"] as const;
export const CLOSING_STATUSES = ["RESOLVED", "WONT_FIX"] as const;

// Only a person reviewing the screen may set these.
export const REVIEWER_ONLY_STATUSES = ["VERIFIED"] as const;

export function toApiStatus(value: string): string {
  const trimmed = value.trim();
  const alias = STATUS_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[\s-]+/g, "_");
}

export function statusLabel(status: string): string {
  const known = (STATUS_LABELS as Record<string, string>)[status];
  if (known) return known;
  return status
    .toLowerCase()
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function isOpenStatus(status: string) {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

export function isClosingStatus(status: string) {
  return (CLOSING_STATUSES as readonly string[]).includes(status);
}

export function isReviewerOnlyStatus(status: string) {
  return (REVIEWER_ONLY_STATUSES as readonly string[]).includes(status);
}

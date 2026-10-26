import type { ScreenApproval } from "../shared/approvals";
import { isOpenFeedback, type FeedbackRecord } from "../shared/feedback";

// A size is a version within a revision; its label names the width
// ("390", "1440", "390 × 844"). Sizes are ordered narrowest first.
export type Size = {
  version: string;
  label: string;
  width?: number;
  name?: "Phone" | "Tablet" | "Desktop";
};

// Only a width-shaped label is a width: "390", "1440px", "390 × 844". A
// build name such as "build-2024" is not.
export function sizeWidth(label: string) {
  const match = /^(\d{3,4})(?:\s*px|w)?(?:\s*[×x]\s*\d{3,5})?$/i.exec(
    label.trim(),
  );
  return match ? Number(match[1]) : undefined;
}

export function sizeName(width: number | undefined): Size["name"] {
  if (width === undefined) return undefined;
  if (width <= 480) return "Phone";
  if (width <= 1024) return "Tablet";
  return "Desktop";
}

export function sizesOf(
  versions: readonly string[],
  labelOf: (version: string) => string,
): Size[] {
  return versions
    .map((version, index) => {
      const label = labelOf(version);
      const width = sizeWidth(label);
      return { size: { version, label, width, name: sizeName(width) }, index };
    })
    .sort(
      (a, b) =>
        (a.size.width ?? Infinity) - (b.size.width ?? Infinity) ||
        a.index - b.index,
    )
    .map(({ size }) => size);
}

// "390", "390 and 768", "390, 768 and 1440".
export function listLabels(labels: readonly string[]) {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export type ScreenRollup = {
  // Open comments across every size.
  openCounts: Map<string, number>;
  // Screens approved at every size; Hide approved hides only these.
  approvedIds: Set<string>;
  // Screens approved at some sizes, with the tooltip that says which.
  partialApprovals: Map<string, string>;
};

export function rollUpSizes(
  screenIds: readonly string[],
  sizes: readonly Size[],
  feedback: readonly FeedbackRecord[],
  approvals: readonly ScreenApproval[],
): ScreenRollup {
  const versions = new Set(sizes.map((size) => size.version));
  const openCounts = new Map<string, number>();
  for (const item of feedback) {
    if (versions.has(item.version) && isOpenFeedback(item)) {
      openCounts.set(item.screenId, (openCounts.get(item.screenId) ?? 0) + 1);
    }
  }
  const approved = new Set(
    approvals.map((item) => `${item.screenId}@@${item.version}`),
  );
  const approvedIds = new Set<string>();
  const partialApprovals = new Map<string, string>();
  for (const id of screenIds) {
    const done = sizes.filter((size) => approved.has(`${id}@@${size.version}`));
    if (done.length === 0) continue;
    if (done.length === sizes.length) {
      approvedIds.add(id);
      continue;
    }
    const pending = sizes.filter((size) => !done.includes(size));
    partialApprovals.set(
      id,
      `Approved at ${listLabels(done.map((size) => size.label))}; ${listLabels(
        pending.map((size) => size.label),
      )} still to review`,
    );
  }
  return { openCounts, approvedIds, partialApprovals };
}

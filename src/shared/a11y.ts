import { z } from "zod";

import { pinBoxSchema, pinFromBox, type PinBox } from "./pin-box";
import type { PriorityTag } from "./feedback";

// Accessibility findings written beside a capture (`<capture>.a11y.json`) by
// `captureFullPage(..., { a11y: true })`: axe-core's WCAG 2 A/AA violations,
// each failing element boxed in fractions of the capture like an element map.
// The review UI shows them as ghost pins a reviewer can promote to a real
// comment or dismiss; nothing here is ever a comment on its own.

export const A11Y_TAG = "a11y";
export const A11Y_NOTE_MAX_LENGTH = 2000;

export const a11yImpactSchema = z.enum([
  "minor",
  "moderate",
  "serious",
  "critical",
]);
export type A11yImpact = z.infer<typeof a11yImpactSchema>;

export const a11yNodeSchema = z.object({
  // axe's CSS selector for the element; with the rule id, it names a finding.
  target: z.string().min(1),
  // Missing when the element has no visible box in the capture.
  box: pinBoxSchema.optional(),
  // axe's "Fix any of the following" text, shortened.
  summary: z.string().optional(),
});

export const a11yViolationSchema = z.object({
  id: z.string().min(1),
  impact: a11yImpactSchema.nullable().optional(),
  help: z.string().min(1),
  helpUrl: z.string().optional(),
  description: z.string().optional(),
  nodes: z.array(a11yNodeSchema),
});

export const a11yReportSchema = z.object({
  version: z.literal(1),
  engine: z.object({ name: z.string(), version: z.string() }).optional(),
  capture: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  url: z.string().optional(),
  violations: z.array(a11yViolationSchema),
});

export type A11yNode = z.infer<typeof a11yNodeSchema>;
export type A11yViolation = z.infer<typeof a11yViolationSchema>;
export type A11yReport = z.infer<typeof a11yReportSchema>;

// `shop/checkout.png` -> `shop/checkout.a11y.json`.
export function a11yReportPathFor(capturePath: string) {
  return `${capturePath.replace(/\.[^./\\]*$/, "")}.a11y.json`;
}

// One ghost pin: a violation on one element.
export type Suggestion = {
  id: string;
  ruleId: string;
  impact: A11yImpact | null;
  help: string;
  helpUrl?: string;
  summary?: string;
  target: string;
  box: PinBox;
};

export function suggestionId(ruleId: string, target: string) {
  return `${ruleId}|${target}`;
}

// Elements without a box can't be pinned, so they are left out.
export function suggestionsFromReport(
  report: A11yReport | null | undefined,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();
  for (const violation of report?.violations ?? []) {
    for (const node of violation.nodes) {
      if (!node.box) continue;
      const id = suggestionId(violation.id, node.target);
      if (seen.has(id)) continue;
      seen.add(id);
      suggestions.push({
        id,
        ruleId: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        ...(violation.helpUrl ? { helpUrl: violation.helpUrl } : {}),
        ...(node.summary ? { summary: node.summary } : {}),
        target: node.target,
        box: node.box,
      });
    }
  }
  return suggestions;
}

export function suggestionPriority(impact: A11yImpact | null): PriorityTag {
  return impact === "serious" || impact === "critical" ? "P1" : "P2";
}

// The comment a promoted suggestion becomes: a box pin on the element,
// tagged so it can be filtered, carrying axe's help text and link.
export function suggestionToFeedback(suggestion: Suggestion) {
  const lines = [
    `${suggestion.help} (${suggestion.ruleId}${suggestion.impact ? `, ${suggestion.impact}` : ""})`,
    `Element: ${suggestion.target}`,
  ];
  if (suggestion.helpUrl) lines.push(suggestion.helpUrl);
  return {
    ...pinFromBox(suggestion.box),
    note: lines.join("\n").slice(0, A11Y_NOTE_MAX_LENGTH),
    tags: [suggestionPriority(suggestion.impact), A11Y_TAG],
  };
}

// A suggestion the reviewer dismissed or promoted, per version and screen.
const key = z.string().min(1).max(200);
export const suggestionDismissalSchema = z.object({
  version: key,
  screenId: key,
  suggestionId: z.string().min(1).max(1000),
  // Set when the suggestion was promoted to this comment.
  feedbackId: z.string().min(1).max(200).optional(),
  dismissedAt: z.iso.datetime(),
});

// `dismissed: false` brings a suggestion back.
export const setSuggestionDismissalInputSchema = z.object({
  version: key,
  screenId: key,
  suggestionId: z.string().min(1).max(1000),
  dismissed: z.boolean().optional().default(true),
  feedbackId: z.string().min(1).max(200).optional(),
});

export type SuggestionDismissal = z.infer<typeof suggestionDismissalSchema>;
export type SetSuggestionDismissalInput = z.input<
  typeof setSuggestionDismissalInputSchema
>;

export function dismissedSuggestionIds(
  dismissals: readonly SuggestionDismissal[],
  version: string,
  screenId: string,
) {
  return new Set(
    dismissals
      .filter((item) => item.version === version && item.screenId === screenId)
      .map((item) => item.suggestionId),
  );
}

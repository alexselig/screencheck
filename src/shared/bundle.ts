import { z } from "zod";

import type { ScreenApproval } from "./approvals";
import type { ScreenCaption } from "./captions";
import type { ElementMap } from "./elements";
import type { FeedbackRecord } from "./feedback";
import type { PublicProject } from "./projects";

// What `screencheck bundle` hands the offline viewer. It is loaded through a
// classic <script> (bundle.js) rather than fetched, because browsers block
// fetch() and module scripts on file:// pages.
export const BUNDLE_FORMAT = 1;

export type OfflineBundle = {
  format: typeof BUNDLE_FORMAT;
  // Unique per bundle; scopes the reviewer's local comments.
  id: string;
  createdAt: string;
  project: PublicProject;
  feedback: FeedbackRecord[];
  approvals: ScreenApproval[];
  captions: ScreenCaption[];
  // "version/screenId" -> path of the capture inside the bundle.
  captures: Record<string, string>;
  // "version/screenId" -> element map.
  elements: Record<string, ElementMap>;
};

export function bundleCaptureKey(version: string, screenId: string) {
  return `${version}/${screenId}`;
}

// The file a reviewer sends back from the offline viewer.
export const REVIEW_EXPORT_KIND = "screencheck-review";

export const reviewExportSchema = z.object({
  kind: z.literal(REVIEW_EXPORT_KIND),
  format: z.literal(1),
  projectId: z.string().min(1),
  bundleId: z.string().min(1),
  exportedAt: z.string(),
  records: z.array(z.unknown()),
});

export type ReviewExport = z.infer<typeof reviewExportSchema>;

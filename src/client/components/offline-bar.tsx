import { useSyncExternalStore } from "react";

import type { OfflineApi } from "../offline-api";

export function reviewFileName(projectId: string, exportedAt: string) {
  const stamp = exportedAt.slice(0, 16).replace(/[:T]/g, "-");
  return `${projectId}-review-${stamp}.json`;
}

// Saves the reviewer's comments as a JSON file. Blob downloads work on
// file:// pages, where nothing can be posted anywhere.
export function downloadReview(api: OfflineApi, doc: Document = document) {
  const review = api.exportReview();
  const blob = new Blob([JSON.stringify(review, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = reviewFileName(review.projectId, review.exportedAt);
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return review;
}

// The strip above an offline review: what this is, how many comments are
// waiting in this browser, and the way to send them back.
export function OfflineBar({
  api,
  onExport = downloadReview,
}: {
  api: OfflineApi;
  onExport?: (api: OfflineApi) => void;
}) {
  const count = useSyncExternalStore(
    api.subscribe,
    () => api.localRecords().length,
  );
  const created = api.bundle.createdAt.slice(0, 10);
  return (
    <div aria-label="Offline review" className="offline-bar" role="region">
      <span className="offline-bar-label">Offline review</span>
      <span className="offline-bar-meta">
        Bundled {created}. New comments stay in this browser until you export
        them.
      </span>
      <span className="offline-bar-count" aria-live="polite">
        {count} new comment{count === 1 ? "" : "s"}
      </span>
      <button
        className="offline-bar-export"
        disabled={count === 0}
        onClick={() => onExport(api)}
        type="button"
      >
        Export review
      </button>
    </div>
  );
}

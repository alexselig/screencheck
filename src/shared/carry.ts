import { isOpenFeedback, type FeedbackRecord } from "./feedback";
import type { PublicVersion } from "./projects";

// Carry forward: when a newer build is registered, open comments move to the
// same size in it, so a new build doesn't reset the review. This plans the
// moves; the server re-anchors and applies them.

// Versions in registration order, grouped as the client groups them: a
// version's revision is its `revision` (else its own id), its size the
// `label`, else the `viewport` width, else the id.
export function sizeModel(versions: readonly PublicVersion[]) {
  const byId = new Map(versions.map((item) => [item.id, item]));
  const revisionOf = (id: string) => byId.get(id)?.revision ?? id;
  const labelOf = (id: string) => {
    const item = byId.get(id);
    return item?.label ?? (item?.viewport ? String(item.viewport) : id);
  };
  const revisions = [...new Set(versions.map((item) => revisionOf(item.id)))];
  const versionsOf = (revision: string) =>
    versions.map((item) => item.id).filter((id) => revisionOf(id) === revision);
  return { byId, revisionOf, labelOf, revisions, versionsOf };
}

// The same size in the newest build, when `version` is from an older one.
// Builds of one version each (no sizes) match one another.
export function newestSameSize(
  versions: readonly PublicVersion[],
  version: string,
): string | undefined {
  const model = sizeModel(versions);
  if (!model.byId.has(version)) return undefined;
  const newest = model.revisions.at(-1);
  if (newest === undefined || model.revisionOf(version) === newest) {
    return undefined;
  }
  const candidates = model.versionsOf(newest);
  const single = model.versionsOf(model.revisionOf(version)).length === 1;
  return (
    candidates.find((id) => model.labelOf(id) === model.labelOf(version)) ??
    (single && candidates.length === 1 ? candidates[0] : undefined)
  );
}

export type CarryPlan = { record: FeedbackRecord; to: string };

export function planCarry(
  feedback: readonly FeedbackRecord[],
  versions: readonly PublicVersion[],
): CarryPlan[] {
  const plans: CarryPlan[] = [];
  for (const record of feedback) {
    if (!isOpenFeedback(record)) continue;
    const to = newestSameSize(versions, record.version);
    if (to) plans.push({ record, to });
  }
  return plans;
}

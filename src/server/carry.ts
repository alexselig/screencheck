import { elementMapSchema, type ElementMap } from "../shared/elements";
import { planCarry } from "../shared/carry";
import { reanchorPin, sourceElement } from "../shared/reanchor";
import type { ProjectCatalog } from "./projects";
import type { CarryMove, FeedbackStorage } from "./storage";

// Moves a project's open comments onto the newest build, re-anchored by the
// element maps of both captures. Run lazily whenever feedback is read, so a
// build registered by `init`, `capture` or by hand is picked up the same way.
// Returns the comments it moved.
export async function carryOpenFeedback(
  storage: FeedbackStorage,
  catalog: Pick<ProjectCatalog, "versionDetails" | "elements" | "capture">,
  projectId: string,
) {
  const versions = await catalog.versionDetails(projectId);
  if (!versions || versions.length < 2) return [];
  const { feedback, rejected } = await storage.inspectFeedback(projectId);
  // A damaged store is reported, not rewritten.
  if (rejected.length > 0) return [];
  // A comment only moves to a build that has a capture of its screen.
  const captured = new Map<string, Promise<boolean>>();
  const hasCapture = (version: string, screenId: string) => {
    const key = `${version}\0${screenId}`;
    let pending = captured.get(key);
    if (!pending) {
      pending = catalog
        .capture(projectId, version, screenId)
        .then(Boolean)
        .catch(() => false);
      captured.set(key, pending);
    }
    return pending;
  };
  const planned = planCarry(feedback, versions);
  const ready = await Promise.all(
    planned.map((plan) => hasCapture(plan.to, plan.record.screenId)),
  );
  const plans = planned.filter((_, index) => ready[index]);
  if (plans.length === 0) return [];

  const maps = new Map<string, Promise<ElementMap | null>>();
  const mapOf = (version: string, screenId: string) => {
    const key = `${version}\0${screenId}`;
    let pending = maps.get(key);
    if (!pending) {
      pending = catalog
        .elements(projectId, version, screenId)
        .then((text) => {
          if (text === null) return null;
          const parsed = elementMapSchema.safeParse(JSON.parse(text));
          return parsed.success ? parsed.data : null;
        })
        .catch(() => null);
      maps.set(key, pending);
    }
    return pending;
  };

  const moves: CarryMove[] = await Promise.all(
    plans.map(async ({ record, to }) => {
      const [source, target] = await Promise.all([
        mapOf(record.version, record.screenId),
        mapOf(to, record.screenId),
      ]);
      const from = sourceElement(record, source);
      const placed = reanchorPin(record, from, target);
      const element = placed.element ?? from;
      return {
        id: record.id,
        from: record.version,
        to,
        x: placed.x,
        y: placed.y,
        ...(placed.box ? { box: placed.box } : {}),
        ...(element ? { element } : {}),
        checkPlacement: placed.placement !== "matched",
      };
    }),
  );
  return storage.carryFeedback(projectId, moves);
}

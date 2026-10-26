import { useEffect, useMemo, useState } from "react";

import { createPinNumbers } from "../shared/export";
import { scopeOf, type FeedbackRecord } from "../shared/feedback";
import { pinBoxOf, type PinBox } from "../shared/pin-box";
import { reanchorPin, sourceElement } from "../shared/reanchor";
import { fetchElementMap } from "./element-map-api";
import type { Size } from "./sizes";

// An all-sizes comment is stored once, on the size it was pinned on. Every
// other size of the same revision shows it too: the same record (same id, so
// status, thread and verify are shared), moved onto that size and re-anchored
// to the element it was pinned to.

export type ShownFeedback = FeedbackRecord & {
  // The size label it was pinned at, on a size it is shown on as a copy.
  pinnedAt?: string;
};

type Placed = { x: number; y: number; box?: PinBox };

export function pinnedAtOf(item: FeedbackRecord): string | undefined {
  const value = (item as ShownFeedback).pinnedAt;
  return typeof value === "string" ? value : undefined;
}

const placedKey = (id: string, version: string) => `${id}\0${version}`;

// The records as seen from `version`: all-sizes comments pinned on a sibling
// size move onto it. Without sibling sizes nothing changes.
export function feedbackAtSize(
  feedback: readonly FeedbackRecord[],
  sizes: readonly Size[],
  version: string,
  placed: ReadonlyMap<string, Placed> = new Map(),
): ShownFeedback[] {
  const labels = new Map(sizes.map((size) => [size.version, size.label]));
  if (sizes.length < 2 || !labels.has(version)) return [...feedback];
  return feedback.map((item) => {
    if (
      item.version === version ||
      !labels.has(item.version) ||
      scopeOf(item) !== "all"
    ) {
      return item;
    }
    const where = placed.get(placedKey(item.id, version));
    const { box: _box, ...rest } = item;
    const box = where ? where.box : pinBoxOf(item);
    return {
      ...rest,
      version,
      x: where?.x ?? item.x,
      y: where?.y ?? item.y,
      ...(box ? { box } : {}),
      pinnedAt: labels.get(item.version)!,
    };
  });
}

// Positions of the screen's all-sizes comments on each other size, from the
// element maps of both sizes. Missing maps keep the % position.
function usePlacements(
  projectId: string,
  feedback: readonly FeedbackRecord[],
  sizes: readonly Size[],
  screenId: string,
) {
  const [placed, setPlaced] = useState<ReadonlyMap<string, Placed>>(
    () => new Map(),
  );
  const versions = useMemo(
    () => new Set(sizes.map((size) => size.version)),
    [sizes],
  );
  const pinned = useMemo(
    () =>
      sizes.length < 2
        ? []
        : feedback.filter(
            (item) =>
              item.screenId === screenId &&
              versions.has(item.version) &&
              scopeOf(item) === "all",
          ),
    [feedback, sizes, versions, screenId],
  );
  const signature = pinned
    .map((item) => `${item.id}@${item.version}:${item.x},${item.y}`)
    .join("|");
  useEffect(() => {
    if (pinned.length === 0) return;
    let live = true;
    const map = (version: string) =>
      fetchElementMap(projectId, version, screenId);
    void (async () => {
      const next = new Map<string, Placed>();
      await Promise.all(
        pinned.flatMap((item) =>
          sizes
            .filter((size) => size.version !== item.version)
            .map(async (size) => {
              const [origin, target] = await Promise.all([
                map(item.version),
                map(size.version),
              ]);
              const where = reanchorPin(
                item,
                sourceElement(item, origin),
                target,
              );
              next.set(placedKey(item.id, size.version), {
                x: where.x,
                y: where.y,
                ...(where.box ? { box: where.box } : {}),
              });
            }),
        ),
      );
      if (live) setPlaced(next);
    })();
    return () => {
      live = false;
    };
    // `signature` stands in for the pinned records' identity and position.
  }, [projectId, screenId, sizes, signature]);
  return placed;
}

export function useAllSizesFeedback({
  projectId,
  feedback,
  sizes,
  version,
  screenId,
}: {
  projectId: string;
  feedback: readonly FeedbackRecord[];
  sizes: readonly Size[];
  version: string;
  screenId: string;
}) {
  const placed = usePlacements(projectId, feedback, sizes, screenId);
  const shown = useMemo(
    () => feedbackAtSize(feedback, sizes, version, placed),
    [feedback, sizes, version, placed],
  );
  const pinNumbers = useMemo(() => createPinNumbers(shown), [shown]);
  // Compare sizes shows every size at once, each with its own numbering.
  const atSize = useMemo(() => {
    const cache = new Map<
      string,
      { feedback: ShownFeedback[]; pinNumbers: Map<string, number> }
    >();
    return (other: string) => {
      let entry = cache.get(other);
      if (!entry) {
        const list = feedbackAtSize(feedback, sizes, other, placed);
        entry = { feedback: list, pinNumbers: createPinNumbers(list) };
        cache.set(other, entry);
      }
      return entry;
    };
  }, [feedback, sizes, placed]);
  return { feedback: shown, pinNumbers, atSize };
}

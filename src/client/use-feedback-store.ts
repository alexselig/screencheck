import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";

import type {
  CreateFeedbackInput,
  FeedbackRecord,
  UpdateFeedbackInput,
} from "../shared/feedback";
import {
  FeedbackApiError,
  patchFeedback,
  postFeedback,
  removeFeedback,
} from "./feedback-api";

// Revisions this tab replaced, so a write queued behind its own save is
// rebased onto that save. Only the newest few per comment are kept: a queued
// write never trails by more than a handful of autosaves.
export const MAX_OWN_REVISIONS = 20;

export function ownRevisionTracker() {
  const own = new Map<string, { latest: string; replaced: string[] }>();
  return {
    latest(id: string, expected: string) {
      const entry = own.get(id);
      return entry?.replaced.includes(expected) ? entry.latest : expected;
    },
    saved(id: string, expected: string, updated: string) {
      const entry = own.get(id);
      const replaced =
        entry &&
        (entry.latest === expected || entry.replaced.includes(expected))
          ? [...entry.replaced, entry.latest]
          : [expected];
      own.set(id, {
        latest: updated,
        replaced: [...new Set(replaced)].slice(-MAX_OWN_REVISIONS),
      });
    },
    forget(id: string) {
      own.delete(id);
    },
    clear() {
      own.clear();
    },
    get size() {
      return own.size;
    },
    replacedCount(id: string) {
      return own.get(id)?.replaced.length ?? 0;
    },
  };
}

// Feedback writes for one project. Writes run one at a time; a change made
// elsewhere still surfaces as a 409 conflict, and the server's current copy
// replaces the local one.
export function useFeedbackStore({
  projectId,
  setRecords,
  onDeleted,
}: {
  projectId: string;
  setRecords: Dispatch<SetStateAction<FeedbackRecord[]>>;
  onDeleted?: (id: string) => void;
}) {
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const revisionsRef = useRef(ownRevisionTracker());
  useEffect(() => {
    revisionsRef.current.clear();
  }, [projectId]);

  const upsertRecord = useCallback(
    (record: FeedbackRecord) => {
      setRecords((current) =>
        current.some((item) => item.id === record.id)
          ? current.map((item) => (item.id === record.id ? record : item))
          : [...current, record],
      );
    },
    [setRecords],
  );

  const enqueue = useCallback(<T>(operation: () => Promise<T>) => {
    const run = chainRef.current.catch(() => undefined).then(operation);
    chainRef.current = run;
    return run;
  }, []);

  const withConflictRefresh = useCallback(
    async <T>(operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof FeedbackApiError && error.current) {
          upsertRecord(error.current);
        }
        throw error;
      }
    },
    [upsertRecord],
  );

  const createFeedback = useCallback(
    (input: CreateFeedbackInput) =>
      enqueue(async () => {
        const created = await postFeedback(projectId, input);
        upsertRecord(created);
        return created;
      }),
    [enqueue, projectId, upsertRecord],
  );

  const updateFeedback = useCallback(
    (id: string, input: UpdateFeedbackInput) =>
      enqueue(() =>
        withConflictRefresh(async () => {
          const expectedUpdatedAt = revisionsRef.current.latest(
            id,
            input.expectedUpdatedAt,
          );
          const updated = await patchFeedback(projectId, id, {
            ...input,
            expectedUpdatedAt,
          });
          revisionsRef.current.saved(id, expectedUpdatedAt, updated.updatedAt);
          upsertRecord(updated);
          return updated;
        }),
      ),
    [enqueue, projectId, upsertRecord, withConflictRefresh],
  );

  const deleteFeedback = useCallback(
    (id: string, expectedUpdatedAt: string) =>
      enqueue(() =>
        withConflictRefresh(async () => {
          await removeFeedback(
            projectId,
            id,
            revisionsRef.current.latest(id, expectedUpdatedAt),
          );
          revisionsRef.current.forget(id);
          setRecords((current) => current.filter((item) => item.id !== id));
          onDeleted?.(id);
        }),
      ),
    [enqueue, onDeleted, projectId, setRecords, withConflictRefresh],
  );

  return { upsertRecord, createFeedback, updateFeedback, deleteFeedback };
}

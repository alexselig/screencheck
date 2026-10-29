import { useCallback, useEffect, useMemo, useState } from "react";

import {
  dismissedSuggestionIds,
  suggestionsFromReport,
  suggestionToFeedback,
  type A11yReport,
  type Suggestion,
  type SuggestionDismissal,
} from "../shared/a11y";
import type { CreateFeedbackInput, FeedbackRecord } from "../shared/feedback";
import {
  fetchA11yReport,
  fetchDismissedSuggestions,
  putSuggestionDismissal,
} from "./a11y-api";

// Accessibility findings for the screen on the canvas, as ghost pins. Only
// the reviewer turns one into a comment ("Add as comment") or hides it
// ("Dismiss"); both are remembered per project, version and screen.
export function useSuggestions({
  projectId,
  version,
  screenId,
  createFeedback,
  onPromoted,
}: {
  projectId: string;
  version: string;
  screenId: string;
  createFeedback: (input: CreateFeedbackInput) => Promise<FeedbackRecord>;
  onPromoted?: (record: FeedbackRecord) => void;
}) {
  const key = `${projectId}\0${version}\0${screenId}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    report: A11yReport | null;
  } | null>(null);
  const [dismissed, setDismissed] = useState<SuggestionDismissal[]>([]);
  const [show, setShow] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !version || !screenId) return;
    let cancelled = false;
    void fetchA11yReport(projectId, version, screenId).then((report) => {
      if (!cancelled) setLoaded({ key, report });
    });
    return () => {
      cancelled = true;
    };
  }, [key, projectId, version, screenId]);

  useEffect(() => {
    setOpenId(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void fetchDismissedSuggestions(projectId).then((list) => {
      if (!cancelled) setDismissed(list);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const report = loaded?.key === key ? loaded.report : null;
  const suggestions = useMemo(() => {
    const hidden = dismissedSuggestionIds(dismissed, version, screenId);
    return suggestionsFromReport(report).filter((item) => !hidden.has(item.id));
  }, [report, dismissed, version, screenId]);
  const open = suggestions.find((item) => item.id === openId) ?? null;

  const record = useCallback(
    async (suggestion: Suggestion, feedbackId?: string) => {
      const optimistic: SuggestionDismissal = {
        version,
        screenId,
        suggestionId: suggestion.id,
        ...(feedbackId ? { feedbackId } : {}),
        dismissedAt: new Date().toISOString(),
      };
      setDismissed((current) => [...current, optimistic]);
      try {
        setDismissed(
          await putSuggestionDismissal(projectId, {
            version,
            screenId,
            suggestionId: suggestion.id,
            ...(feedbackId ? { feedbackId } : {}),
          }),
        );
      } catch (failure) {
        setDismissed((current) =>
          current.filter((item) => item !== optimistic),
        );
        throw failure;
      }
    },
    [projectId, version, screenId],
  );

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      setOpenId(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const dismiss = useCallback(
    (suggestion: Suggestion) => run(() => record(suggestion)),
    [record, run],
  );

  const promote = useCallback(
    (suggestion: Suggestion) =>
      run(async () => {
        const created = await createFeedback({
          clientMutationId: crypto.randomUUID(),
          screenId,
          version,
          ...suggestionToFeedback(suggestion),
          status: "OPEN",
        });
        // The comment exists now; a failed dismissal only leaves the ghost.
        await record(suggestion, created.id).catch(() => undefined);
        onPromoted?.(created);
      }),
    [createFeedback, onPromoted, record, run, screenId, version],
  );

  return {
    suggestions,
    show,
    setShow,
    open,
    setOpenId: (id: string | null) => {
      setError(null);
      setOpenId(id);
    },
    busy,
    error,
    dismiss,
    promote,
  };
}

export type SuggestionsState = ReturnType<typeof useSuggestions>;

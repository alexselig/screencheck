import {
  a11yReportSchema,
  suggestionDismissalSchema,
  type A11yReport,
  type SetSuggestionDismissalInput,
} from "../shared/a11y";
import { ACTOR_HEADER, REVIEWER_ACTOR } from "../shared/feedback";
import { a11yReportUrl } from "../shared/projects";

// Accessibility reports are optional (only captures taken with --a11y have
// one), so like element maps every failure resolves to null.
const cache = new Map<string, Promise<A11yReport | null>>();

export function fetchA11yReport(
  projectId: string,
  version: string,
  screenId: string,
): Promise<A11yReport | null> {
  const key = `${projectId}\0${version}\0${screenId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const response = await fetch(a11yReportUrl(projectId, version, screenId));
      if (!response.ok) {
        if (response.status !== 404) cache.delete(key);
        return null;
      }
      const parsed = a11yReportSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      cache.delete(key);
      return null;
    }
  })();
  cache.set(key, pending);
  return pending;
}

export function clearA11yReportCache() {
  cache.clear();
}

function suggestionsUrl(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/suggestions`;
}

const dismissalsSchema = suggestionDismissalSchema.array();

// No dismissals file (or an offline bundle) reads as none dismissed.
export async function fetchDismissedSuggestions(projectId: string) {
  try {
    const response = await fetch(suggestionsUrl(projectId));
    if (!response.ok) return [];
    const parsed = dismissalsSchema.safeParse(
      ((await response.json()) as { dismissed?: unknown }).dismissed,
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function putSuggestionDismissal(
  projectId: string,
  input: SetSuggestionDismissalInput,
) {
  let response: Response;
  try {
    response = await fetch(suggestionsUrl(projectId), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [ACTOR_HEADER]: REVIEWER_ACTOR,
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error("The ScreenCheck server is not reachable.");
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    dismissed?: unknown;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }
  return dismissalsSchema.parse(payload.dismissed);
}

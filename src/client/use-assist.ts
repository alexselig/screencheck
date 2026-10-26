import { useEffect, useState } from "react";

import { ACTOR_HEADER, REVIEWER_ACTOR } from "../shared/feedback";

type Status = { enabled: boolean; available: boolean };

// One probe per page load: the server caches the CLI check, and a missing or
// disabled assist is a normal state, so any failure just means "off".
let statusPromise: Promise<boolean> | null = null;

function probe() {
  statusPromise ??= (async () => {
    try {
      const response = await fetch("/api/assist");
      if (!response.ok) return false;
      const status = (await response.json()) as Partial<Status>;
      return status.enabled === true && status.available === true;
    } catch {
      return false;
    }
  })();
  return statusPromise;
}

export function resetAssistStatus() {
  statusPromise = null;
}

// True once the server says assist is on and the Copilot CLI answers.
export function useAssist() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void probe().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

export async function assistRequest<T>(
  action: "rewrite" | "suggest" | "duplicates" | "summary",
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/assist/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ACTOR_HEADER]: REVIEWER_ACTOR,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new Error("The ScreenCheck server is not reachable.");
  }
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `Assist failed (${response.status}).`);
  }
  return payload;
}

import type { IncomingMessage } from "node:http";

import { z } from "zod";

import { AssistError, findDuplicates, type AssistService } from "./assist";
import type { FeedbackStorage } from "./storage";

export type { AssistService };

const NOTE_MAX = 4000;
const noteSchema = z.object({ note: z.string().trim().min(1).max(NOTE_MAX) });
const roundSchema = z.object({
  projectId: z.string().min(1),
  version: z.string().min(1),
});
const duplicatesSchema = roundSchema.extend({
  screenId: z.string().min(1),
  note: z.string().max(NOTE_MAX),
  // The comment being edited, so it is not its own duplicate.
  id: z.string().min(1).optional(),
});

const ASSIST_STATUS: Record<AssistError["code"], number> = {
  ASSIST_UNAVAILABLE: 503,
  ASSIST_TIMEOUT: 504,
  ASSIST_FAILED: 502,
};

type Context = {
  assist: AssistService | undefined;
  storage: FeedbackStorage;
  assertOrigin: () => void;
  readBody: () => Promise<unknown>;
  fail: (status: number, message: string) => Error;
};

// GET /api/assist and POST /api/assist/{rewrite,suggest,duplicates,summary}.
// Every POST passes the same Origin check as other mutations: they spend the
// reviewer's Copilot requests, so another site must not trigger them.
export async function handleAssist(
  request: IncomingMessage,
  pathname: string,
  { assist, storage, assertOrigin, readBody, fail }: Context,
): Promise<{ status: number; body: unknown }> {
  const action = pathname.replace(/^\/api\/assist\/?/, "").replace(/\/$/, "");
  if (!action) {
    if (request.method !== "GET") throw fail(405, "Method not allowed.");
    if (!assist)
      return { status: 200, body: { enabled: false, available: false } };
    const { available } = await assist.available();
    return { status: 200, body: { enabled: true, available } };
  }
  if (!["rewrite", "suggest", "duplicates", "summary"].includes(action)) {
    throw fail(404, "Not found.");
  }
  if (request.method !== "POST") throw fail(405, "Method not allowed.");
  assertOrigin();
  if (!assist) {
    throw fail(
      404,
      "AI assist is off. Start ScreenCheck with `screencheck serve --assist` (or SCREENCHECK_ASSIST=1).",
    );
  }
  const body = await readBody();

  if (action === "duplicates") {
    const input = duplicatesSchema.parse(body);
    const feedback = await storage.listFeedback(input.projectId);
    return {
      status: 200,
      body: {
        duplicates: findDuplicates(feedback, {
          version: input.version,
          screenId: input.screenId,
          note: input.note,
          excludeId: input.id,
        }),
      },
    };
  }

  const status = await assist.available();
  if (!status.available) {
    throw fail(
      503,
      `The Copilot CLI is not available${status.error ? `: ${status.error}` : "."}`,
    );
  }
  try {
    if (action === "rewrite") {
      const { note } = noteSchema.parse(body);
      return { status: 200, body: { instruction: await assist.rewrite(note) } };
    }
    if (action === "suggest") {
      const { note } = noteSchema.parse(body);
      return { status: 200, body: await assist.suggest(note) };
    }
    const input = roundSchema.parse(body);
    const feedback = await storage.listFeedback(input.projectId);
    return {
      status: 200,
      body: { markdown: await assist.summary({ ...input, feedback }) },
    };
  } catch (error) {
    if (error instanceof AssistError) {
      throw fail(ASSIST_STATUS[error.code], error.message);
    }
    throw error;
  }
}

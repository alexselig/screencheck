import {
  ApiError,
  ToolError,
  type ApiClient,
  type ApiFeedback,
} from "./client";
import { latestReply, roleLabel } from "./comments";
import { statusLabel } from "./status";

export class StatusChangedError extends ToolError {
  constructor(
    message: string,
    readonly current: ApiFeedback,
  ) {
    super(message);
  }
}

// Patches a comment, re-reading and retrying once if someone edited it in the
// meantime. A retry never overrides a status the reviewer just set: if the
// status changed under the agent (Verified, Won't fix, reopened) and the patch
// would change it again, only the note is added and the caller gets an error
// naming the reviewer's change.
export async function patchWithRetry(
  api: Pick<ApiClient, "patchFeedback" | "listFeedback">,
  projectId: string,
  current: ApiFeedback,
  patch: Record<string, unknown>,
) {
  let record = current;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await api.patchFeedback(
        projectId,
        record.id,
        record.updatedAt,
        patch,
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      const fresh = (await api.listFeedback(projectId)).find(
        (item) => item.id === record.id,
      );
      if (!fresh) throw new ToolError(`Comment ${record.id} was deleted.`);
      if (patch.status !== undefined && fresh.status !== record.status) {
        throw await statusConflict(api, projectId, record, fresh, patch);
      }
      record = fresh;
    }
  }
  throw new ToolError("The comment kept changing; try again.");
}

async function statusConflict(
  api: Pick<ApiClient, "patchFeedback">,
  projectId: string,
  seen: ApiFeedback,
  fresh: ApiFeedback,
  patch: Record<string, unknown>,
) {
  const latest = latestReply(fresh);
  const who =
    latest?.role === "reviewer" && latest.author
      ? `${roleLabel(latest.role)} ${latest.author}`
      : "The reviewer";
  const change = `${who} changed comment ${fresh.id} from ${statusLabel(seen.status)} to ${statusLabel(fresh.status)} while you were working, so your status change to ${statusLabel(String(patch.status))} was not applied.`;
  const { status: _status, ...rest } = patch;
  if (Object.keys(rest).length === 0) {
    return new StatusChangedError(
      `${change} Read the comment again before changing it.`,
      fresh,
    );
  }
  try {
    const saved = await api.patchFeedback(
      projectId,
      fresh.id,
      fresh.updatedAt,
      rest,
    );
    return new StatusChangedError(
      `${change} Your note was added without a status change; read the comment again before changing it.`,
      saved,
    );
  } catch {
    return new StatusChangedError(
      `${change} Your note was not saved either; read the comment again and retry.`,
      fresh,
    );
  }
}

// `reply --recapture` and the MCP reply's `recapture: true`: once a fix is
// in, capture that one screen again with the project's capture config, so
// the verify card can show the old and new capture side by side.
import { stat } from "node:fs/promises";
import path from "node:path";

import type { ConfigCaptureJob } from "./capture";
import {
  type ConfigCaptureIo,
  loadCaptureConfig,
  runConfigCapture,
} from "./capture-config";

export const CONFIG_NAMES = [
  "screencheck.config.mjs",
  "screencheck.config.js",
  "screencheck.config.json",
];

export type Capture = (
  job: ConfigCaptureJob,
  io: ConfigCaptureIo,
) => Promise<unknown>;

export type RecaptureIo = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  recapture?: Capture;
};

export type RecaptureResult = {
  ok: boolean;
  skipped?: boolean;
  revision?: string;
  lines: string[];
};

// The config `screencheck capture --config` would use: an explicit file,
// else screencheck.config.mjs / .js / .json in the working folder.
export async function findCaptureConfig(cwd: string, explicit?: string) {
  const candidates = explicit
    ? [path.resolve(cwd, explicit)]
    : CONFIG_NAMES.map((name) => path.join(cwd, name));
  for (const file of candidates) {
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Not there; try the next name.
    }
  }
  return null;
}

export async function recaptureScreen(
  target: {
    projectId: string;
    screenId: string;
    // The revision the comment was made on, to warn before overwriting it.
    commentRevision?: string;
    revision?: string;
    config?: string;
  },
  {
    cwd = process.cwd(),
    env = process.env,
    recapture = runConfigCapture,
  }: RecaptureIo = {},
): Promise<RecaptureResult> {
  const lines: string[] = [];
  const file = await findCaptureConfig(cwd, target.config);
  if (!file) {
    lines.push(
      target.config
        ? `No capture config at ${target.config}; skipped the recapture.`
        : `No capture config (${CONFIG_NAMES.join(", ")}) in ${cwd}, so skipped the recapture. Run from the project folder or pass --config <file>.`,
    );
    return { ok: true, skipped: true, lines };
  }
  const shown = path.relative(cwd, file) || file;
  try {
    const config = await loadCaptureConfig(file, shown);
    if (config.project.id !== target.projectId) {
      lines.push(
        `${shown} is for project "${config.project.id}", not "${target.projectId}"; skipped the recapture.`,
      );
      return { ok: true, skipped: true, lines };
    }
    if (!config.screens.some((screen) => screen.id === target.screenId)) {
      lines.push(
        `${shown} has no screen "${target.screenId}"; skipped the recapture.`,
      );
      return { ok: true, skipped: true, lines };
    }
    const revision = target.revision ?? config.version;
    await recapture(
      {
        config: file,
        screen: target.screenId,
        ...(target.revision ? { version: target.revision } : {}),
      },
      { cwd, env, log: (line) => lines.push(line) },
    );
    lines.push(`Recaptured ${target.screenId} into ${revision}.`);
    if (revision && revision === target.commentRevision) {
      lines.push(
        `Note: this replaced the capture the comment was made on, so there is no before to compare. Pass a new revision (--revision, or "revision" over MCP) to keep both.`,
      );
    }
    return { ok: true, ...(revision ? { revision } : {}), lines };
  } catch (error) {
    lines.push(
      `Recapture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, lines };
  }
}

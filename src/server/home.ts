import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOME_DIR_NAME = ".screencheck";
// The tool was called Screen Review Workbench; its folder is still read when
// no ~/.screencheck exists yet, so renaming never strands saved feedback.
export const LEGACY_HOME_DIR_NAME = ".screen-review-workbench";

// Where all state lives: feedback/, projects/ and server.json.
// SCREENCHECK_HOME moves all three at once (a sandbox, a test run, CI);
// SCREENCHECK_DATA and SCREENCHECK_PROJECTS still override their own folder.
export function appHome(
  home?: string,
  exists = existsSync,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (home === undefined && env.SCREENCHECK_HOME) {
    return resolve(env.SCREENCHECK_HOME);
  }
  const base = home ?? homedir();
  const current = join(base, HOME_DIR_NAME);
  const legacy = join(base, LEGACY_HOME_DIR_NAME);
  if (!exists(current) && exists(legacy)) return legacy;
  return current;
}

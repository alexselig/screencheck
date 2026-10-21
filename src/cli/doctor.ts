// `screencheck doctor [<project>] [--restore] [--quarantine]`: checks each
// project's store files and repairs the two failures that take a project
// offline: a damaged file (restored from its `.bak`) and invalid records
// (moved to feedback.rejected.json).
import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";

import { defaultDataRoot } from "../server/index";
import { createFeedbackStorage, STORE_FILES } from "../server/storage";

export const DOCTOR_USAGE = `Usage:
  screencheck doctor [<project>] [--restore] [--quarantine] [--data <dir>]

Checks feedback.json, approvals.json and captions.json for every project
(or one) and reports anything unreadable.
  --restore     Replace a damaged file with its last good backup (<file>.bak);
                the damaged file is kept as <file>.damaged-<time>
  --quarantine  Move invalid feedback records to feedback.rejected.json so
                the rest of the project can be edited again
  --data <dir>  Feedback folder (default $SCREENCHECK_DATA, else
                ~/.screencheck/feedback)`;

async function projectIds(dataRoot: string) {
  try {
    return (await readdir(dataRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function runDoctor(
  argv: string[],
  { log = console.log }: { log?: (line: string) => void } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      restore: { type: "boolean" },
      quarantine: { type: "boolean" },
      data: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return (log(DOCTOR_USAGE), 0);
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  const dataRoot = values.data ?? defaultDataRoot();
  const storage = createFeedbackStorage({ dataRoot });
  const projects = positionals[0]
    ? [positionals[0]]
    : await projectIds(dataRoot);
  if (!projects.length) {
    log(`No feedback yet in ${dataRoot}.`);
    return 0;
  }

  let unhealthy = 0;
  for (const project of projects) {
    if (values.restore) {
      for (const file of STORE_FILES) {
        const outcome = await storage.restoreBackup(project, file);
        if (outcome === "restored") {
          log(`${project}/${file}: restored from ${file}.bak`);
        }
      }
    }
    if (values.quarantine) {
      const moved = await storage.quarantineFeedback(project).catch(() => []);
      if (moved.length) {
        log(
          `${project}/feedback.json: moved ${moved.length} invalid record${moved.length === 1 ? "" : "s"} to feedback.rejected.json`,
        );
      }
    }
    for (const result of await storage.checkStore(project)) {
      if (result.ok) {
        log(`${project}/${result.file}: ok (${result.count})`);
        continue;
      }
      unhealthy += 1;
      log(`${project}/${result.file}: ${result.problem}`);
    }
  }
  return unhealthy ? 1 : 0;
}

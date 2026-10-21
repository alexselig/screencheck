import type { z } from "zod";

// `screens[1].group`, `feedback[3].thread[0].note`, or `root`.
export function formatIssuePath(path: readonly PropertyKey[]) {
  let text = "";
  for (const part of path) {
    if (typeof part === "number") text += `[${part}]`;
    else text += text ? `.${String(part)}` : String(part);
  }
  return text || "root";
}

// One line per issue, e.g. "screens[1].group: Invalid input: expected string".
export function formatZodError(error: z.ZodError, prefix: PropertyKey[] = []) {
  return error.issues
    .map(
      (issue) =>
        `${formatIssuePath([...prefix, ...issue.path])}: ${issue.message}`,
    )
    .join("; ");
}

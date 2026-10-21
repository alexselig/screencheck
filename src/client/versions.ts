import type { PublicProject } from "../shared/projects";

// How a project's versions group in the header and rail. Grouping is only
// ever explicit: a version joins a revision through its registered
// `revision`, and its short name comes from `label`. A version id is never
// split on its own, so "build-41" and "build-42" stay two revisions.
export function versionModel(
  project: Pick<PublicProject, "versions" | "versionDetails">,
) {
  const details = new Map(
    (project.versionDetails ?? []).map((item) => [item.id, item]),
  );
  const revisionOf = (version: string) =>
    details.get(version)?.revision ?? version;
  const labelOf = (version: string) => details.get(version)?.label ?? version;
  const revisions = [...new Set(project.versions.map(revisionOf))];
  const versionsOf = (revision: string) =>
    project.versions.filter((version) => revisionOf(version) === revision);
  return { revisionOf, labelOf, revisions, versionsOf };
}

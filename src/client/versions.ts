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
  // The same screen size in the nearest earlier build that has it. Unlabelled
  // builds hold one version each, so they match one another.
  const previousVersion = (version: string) => {
    const at = revisions.indexOf(revisionOf(version));
    const single = versionsOf(revisionOf(version)).length === 1;
    for (let index = at - 1; index >= 0; index -= 1) {
      const candidates = versionsOf(revisions[index]!);
      const match =
        candidates.find((item) => labelOf(item) === labelOf(version)) ??
        (single && candidates.length === 1 ? candidates[0] : undefined);
      if (match) return match;
    }
    return undefined;
  };
  return { revisionOf, labelOf, revisions, versionsOf, previousVersion };
}

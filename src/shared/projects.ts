import type { ReviewScreen } from "./manifest";

// What the browser sees of a registered project: no file paths, proxy
// settings, or injected headers.
export type PublicScreen = Pick<
  ReviewScreen,
  "id" | "ordinal" | "title" | "description" | "group" | "viewport" | "liveUrl"
> & { hasCapture: boolean };

// Optional grouping for a version: captures of one build at several
// viewports share a `revision` and each carries a short `label` ("1440",
// "mobile"). Without them a version is its own revision.
export type PublicVersion = {
  id: string;
  revision?: string;
  label?: string;
};

export type PublicProject = {
  id: string;
  name: string;
  versions: string[];
  versionDetails?: PublicVersion[];
  screens: PublicScreen[];
};

export type ProjectList = {
  projects: PublicProject[];
  problems: string[];
  // Sent only when no project is registered, for the empty state.
  projectsRoot?: string;
};

export function captureUrl(
  projectId: string,
  version: string,
  screenId: string,
) {
  return `/api/projects/${encodeURIComponent(projectId)}/captures/${encodeURIComponent(version)}/${encodeURIComponent(screenId)}`;
}

export function elementMapUrl(
  projectId: string,
  version: string,
  screenId: string,
) {
  return `/api/projects/${encodeURIComponent(projectId)}/elements/${encodeURIComponent(version)}/${encodeURIComponent(screenId)}`;
}

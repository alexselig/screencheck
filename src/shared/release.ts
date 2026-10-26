// The state of one review round: how many screens are approved, what is still
// open, and what changed since the round before. Pure, so the CLI (reading
// storage directly) and the MCP server (reading the API) report the same thing.
//
// A round is a revision. Captures of one build at several sizes share a
// `revision` and each carries a `label`; without them a version is its own
// revision. A screen is approved for the round only when every size that
// shows it is approved.

export const RELEASE_STATUS_SCHEMA = 1;

export const GATE_PRIORITIES = ["P0", "P1", "P2", "any"] as const;
export type GatePriority = (typeof GATE_PRIORITIES)[number];

const PRIORITIES = ["P0", "P1", "P2"] as const;
const OPEN_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);
const CLOSED_STATUSES = new Set(["RESOLVED", "VERIFIED", "WONT_FIX"]);

export type ReleaseInput = {
  project: {
    id: string;
    versions: string[];
    versionDetails?: { id: string; revision?: string; label?: string }[];
    screens: { id: string; ordinal: number; title: string }[];
  };
  feedback: {
    id: string;
    version: string;
    screenId: string;
    status: string;
    tags: readonly string[];
  }[];
  approvals: { version: string; screenId: string }[];
  // Screen ids with a capture, per version. A version with no entry, or with
  // no captures at all (a live-only registration), shows every screen;
  // otherwise it shows its captured screens plus any a comment or approval
  // points at.
  captures?: Record<string, readonly string[]>;
  // Defaults to the latest revision.
  target?: { revision?: string; version?: string };
  gate?: { maxPriority?: GatePriority; allowUnapproved?: boolean };
};

export type OpenCounts = {
  total: number;
  P0: number;
  P1: number;
  P2: number;
  none: number;
};

export type ScreenCounts = {
  total: number;
  approved: number;
  unapproved: number;
};

export type ReleaseChanges = {
  since: string;
  screensAdded: string[];
  screensRemoved: string[];
  // Comments filed on this round (any status).
  commentsOpened: number;
  // Comments on the previous round that are now Fixed, Verified or Won't fix.
  commentsClosed: number;
  // Comments on the previous round still in Backlog or In progress.
  commentsStillOpen: number;
};

export type ReleaseSize = {
  version: string;
  label: string;
  previous: string | null;
  screens: ScreenCounts;
  open: OpenCounts;
  fixedNotVerified: number;
  changes: ReleaseChanges | null;
};

export type ReleaseScreen = {
  id: string;
  ordinal: number;
  title: string;
  approved: boolean;
  open: number;
  sizes: { version: string; label: string; approved: boolean }[];
};

export type ReleaseGate = {
  pass: boolean;
  reasons: string[];
  maxPriority: GatePriority;
  allowUnapproved: boolean;
};

export type ReleaseStatus = {
  schema: typeof RELEASE_STATUS_SCHEMA;
  project: string;
  revision: string;
  versions: string[];
  previous: { revision: string; versions: string[] } | null;
  screens: ScreenCounts;
  open: OpenCounts;
  fixedNotVerified: number;
  changes: ReleaseChanges | null;
  sizes: ReleaseSize[];
  screenList: ReleaseScreen[];
  gate: ReleaseGate;
};

type Feedback = ReleaseInput["feedback"][number];

// Mirrors the client's version model (src/client/versions.ts): grouping is
// only ever explicit, through `revision` and `label`.
function versionModel(project: ReleaseInput["project"]) {
  const details = new Map(
    (project.versionDetails ?? []).map((item) => [item.id, item]),
  );
  const revisionOf = (version: string) =>
    details.get(version)?.revision ?? version;
  const labelOf = (version: string) => details.get(version)?.label ?? version;
  const revisions = [...new Set(project.versions.map(revisionOf))];
  const versionsOf = (revision: string) =>
    project.versions.filter((version) => revisionOf(version) === revision);
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

function priorityOf(tags: readonly string[]) {
  return PRIORITIES.find((priority) => tags.includes(priority)) ?? "none";
}

export function countOpen(feedback: readonly Feedback[]): OpenCounts {
  const counts: OpenCounts = { total: 0, P0: 0, P1: 0, P2: 0, none: 0 };
  for (const item of feedback) {
    if (!OPEN_STATUSES.has(item.status)) continue;
    counts.total += 1;
    counts[priorityOf(item.tags)] += 1;
  }
  return counts;
}

function fixedNotVerified(feedback: readonly Feedback[]) {
  return feedback.filter((item) => item.status === "RESOLVED").length;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function summarizeRelease(input: ReleaseInput): ReleaseStatus {
  const { project } = input;
  const model = versionModel(project);
  const known = (list: readonly string[]) => list.join(", ");

  let revision: string;
  let versions: string[];
  if (input.target?.version) {
    const version = input.target.version;
    if (!project.versions.includes(version)) {
      throw new Error(
        `Project ${project.id} has no version "${version}". Versions: ${known(project.versions)}.`,
      );
    }
    revision = model.revisionOf(version);
    versions = [version];
  } else if (input.target?.revision) {
    revision = input.target.revision;
    if (!model.revisions.includes(revision)) {
      throw new Error(
        `Project ${project.id} has no revision "${revision}". Revisions: ${known(model.revisions)}.`,
      );
    }
    versions = model.versionsOf(revision);
  } else {
    const latest = model.revisions.at(-1);
    if (!latest) throw new Error(`Project ${project.id} has no versions.`);
    revision = latest;
    versions = model.versionsOf(latest);
  }

  const allScreens = project.screens.map((screen) => screen.id);
  // A screen belongs to a version when it has a capture there, or when a
  // comment or approval already points at it.
  const screensIn = (version: string) => {
    const captured = input.captures?.[version];
    if (!captured?.length) return allScreens;
    const referenced = new Set([
      ...captured,
      ...input.feedback
        .filter((item) => item.version === version)
        .map((item) => item.screenId),
      ...input.approvals
        .filter((item) => item.version === version)
        .map((item) => item.screenId),
    ]);
    return allScreens.filter((id) => referenced.has(id));
  };
  const approved = (version: string, screenId: string) =>
    input.approvals.some(
      (item) => item.version === version && item.screenId === screenId,
    );
  const feedbackIn = (list: readonly string[]) =>
    input.feedback.filter((item) => list.includes(item.version));

  function changes(
    since: string,
    current: readonly string[],
    previous: readonly string[],
  ): ReleaseChanges {
    const now = new Set(current.flatMap(screensIn));
    const before = new Set(previous.flatMap(screensIn));
    const earlier = feedbackIn(previous);
    return {
      since,
      screensAdded: allScreens.filter((id) => now.has(id) && !before.has(id)),
      screensRemoved: allScreens.filter((id) => before.has(id) && !now.has(id)),
      commentsOpened: feedbackIn(current).length,
      commentsClosed: earlier.filter((item) => CLOSED_STATUSES.has(item.status))
        .length,
      commentsStillOpen: earlier.filter((item) =>
        OPEN_STATUSES.has(item.status),
      ).length,
    };
  }

  const sizes: ReleaseSize[] = versions.map((version) => {
    const shown = screensIn(version);
    const approvedCount = shown.filter((id) => approved(version, id)).length;
    const inVersion = feedbackIn([version]);
    const previous = model.previousVersion(version) ?? null;
    return {
      version,
      label: model.labelOf(version),
      previous,
      screens: {
        total: shown.length,
        approved: approvedCount,
        unapproved: shown.length - approvedCount,
      },
      open: countOpen(inVersion),
      fixedNotVerified: fixedNotVerified(inVersion),
      changes: previous ? changes(previous, [version], [previous]) : null,
    };
  });

  const inRound = feedbackIn(versions);
  const screenList: ReleaseScreen[] = project.screens.flatMap((screen) => {
    const shownIn = versions.filter((version) =>
      screensIn(version).includes(screen.id),
    );
    if (!shownIn.length) return [];
    const perSize = shownIn.map((version) => ({
      version,
      label: model.labelOf(version),
      approved: approved(version, screen.id),
    }));
    return [
      {
        id: screen.id,
        ordinal: screen.ordinal,
        title: screen.title,
        approved: perSize.every((size) => size.approved),
        open: countOpen(inRound.filter((item) => item.screenId === screen.id))
          .total,
        sizes: perSize,
      },
    ];
  });
  const approvedScreens = screenList.filter((screen) => screen.approved).length;

  // The previous round: for a single version, the versions its sizes came
  // from; for a revision, the whole revision before it.
  let previous: ReleaseStatus["previous"] = null;
  if (input.target?.version) {
    const before = sizes[0]!.previous;
    if (before) {
      previous = { revision: model.revisionOf(before), versions: [before] };
    }
  } else {
    const at = model.revisions.indexOf(revision);
    if (at > 0) {
      const before = model.revisions[at - 1]!;
      previous = { revision: before, versions: model.versionsOf(before) };
    }
  }

  const open = countOpen(inRound);
  const maxPriority = input.gate?.maxPriority ?? "P0";
  const allowUnapproved = input.gate?.allowUnapproved ?? false;
  const reasons: string[] = [];
  if (maxPriority === "any") {
    if (open.total) reasons.push(`${plural(open.total, "open comment")}`);
  } else {
    for (const priority of PRIORITIES.slice(
      0,
      PRIORITIES.indexOf(maxPriority) + 1,
    )) {
      if (open[priority]) {
        reasons.push(`${plural(open[priority], `open ${priority} comment`)}`);
      }
    }
  }
  const unapproved = screenList.filter((screen) => !screen.approved);
  if (!allowUnapproved && unapproved.length) {
    const multiSize = versions.length > 1;
    const names = unapproved.map((screen) => {
      const name = `${String(screen.ordinal).padStart(2, "0")} ${screen.title}`;
      if (!multiSize) return name;
      const missing = screen.sizes
        .filter((size) => !size.approved)
        .map((size) => size.label);
      return `${name} (${missing.join(", ")})`;
    });
    reasons.push(
      `${unapproved.length} ${unapproved.length === 1 ? "screen" : "screens"} not approved: ${names.join(", ")}`,
    );
  }

  return {
    schema: RELEASE_STATUS_SCHEMA,
    project: project.id,
    revision,
    versions,
    previous,
    screens: {
      total: screenList.length,
      approved: approvedScreens,
      unapproved: screenList.length - approvedScreens,
    },
    open,
    fixedNotVerified: fixedNotVerified(inRound),
    changes: previous
      ? changes(previous.revision, versions, previous.versions)
      : null,
    sizes,
    screenList,
    gate: { pass: reasons.length === 0, reasons, maxPriority, allowUnapproved },
  };
}

function describeOpen(open: OpenCounts) {
  return `${open.total} (P0 ${open.P0}, P1 ${open.P1}, P2 ${open.P2}, none ${open.none})`;
}

function describeChanges(changes: ReleaseChanges) {
  const added = changes.screensAdded.length
    ? `${plural(changes.screensAdded.length, "screen")} added (${changes.screensAdded.join(", ")})`
    : "0 screens added";
  const removed = changes.screensRemoved.length
    ? `${changes.screensRemoved.length} removed (${changes.screensRemoved.join(", ")})`
    : "0 removed";
  return `Since ${changes.since}: ${added}, ${removed}; ${plural(changes.commentsOpened, "comment")} opened, ${changes.commentsClosed} closed, ${changes.commentsStillOpen} still open`;
}

// The human-readable report. `withGate` adds the PASS/FAIL block.
export function formatRelease(status: ReleaseStatus, withGate: boolean) {
  const [first] = status.sizes;
  let heading = `${status.project} · version ${first!.version}`;
  if (status.sizes.length > 1) {
    heading = `${status.project} · revision ${status.revision} (${status.sizes.length} sizes: ${status.sizes.map((size) => size.label).join(", ")})`;
  } else if (status.revision !== first!.version) {
    heading = `${status.project} · revision ${status.revision}, size ${first!.label} (version ${first!.version})`;
  }
  const lines = [
    heading,
    `  ${plural(status.screens.total, "screen")}, ${status.screens.approved} approved`,
    `  Open comments: ${describeOpen(status.open)}`,
    `  Fixed, not verified: ${status.fixedNotVerified}`,
    `  ${status.changes ? describeChanges(status.changes) : "First round: nothing to compare with"}`,
  ];
  if (status.sizes.length > 1) {
    const width = Math.max(...status.sizes.map((size) => size.label.length));
    lines.push("  Per size:");
    for (const size of status.sizes) {
      lines.push(
        `    ${size.label.padEnd(width)}  ${plural(size.screens.total, "screen")}, ${size.screens.approved} approved; open ${describeOpen(size.open)}; ${size.fixedNotVerified} fixed, not verified`,
      );
    }
  }
  if (withGate) {
    lines.push(`Gate: ${status.gate.pass ? "PASS" : "FAIL"}`);
    for (const reason of status.gate.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}

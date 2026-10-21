import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import {
  FeedbackInspector,
  feedbackPinId,
  pinDotClassName,
} from "./components/feedback-inspector";
import { ExportDialog } from "./components/export-dialog";
import {
  FullscreenReview,
  type FullscreenDrawer,
} from "./components/fullscreen-review";
import { ScreenCaption } from "./components/screen-caption";
import {
  ScreenRail,
  readHideApproved,
  visibleRailScreens,
  writeHideApproved,
  type RailMode,
} from "./components/screen-rail";
import { isApproved, type ScreenApproval } from "../shared/approvals";
import { captionFor, type ScreenCaption as Caption } from "../shared/captions";
import { createPinNumbers } from "../shared/export";
import {
  FEEDBACK_STATUSES,
  isOpenFeedback,
  normalizePinCoordinates,
  type FeedbackRecord,
  type FeedbackStatus,
} from "../shared/feedback";
import {
  captureUrl,
  type ProjectList,
  type PublicProject,
  type PublicScreen,
} from "../shared/projects";
import {
  fetchApprovals,
  fetchCaptions,
  fetchFeedback,
  fetchProjects,
  migrateLegacyFeedback,
  putApproval,
  putCaption,
} from "./feedback-api";
import { SHORTCUTS, useShortcuts } from "./shortcuts";
import { useFeedbackStore } from "./use-feedback-store";
import { versionModel } from "./versions";

type Place = { project?: string; version?: string; screen?: string };

function readPlace(): Place {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return {
    project: params.get("project") ?? undefined,
    version: params.get("version") ?? undefined,
    screen: params.get("screen") ?? undefined,
  };
}

type NoticeKind =
  | "migration"
  | "approvals-load"
  | "captions-load"
  | "caption-save"
  | "approval-save";
type Notice = { kind: NoticeKind; text: string };
const SAVE_NOTICES = new Set<NoticeKind>(["caption-save", "approval-save"]);

// A comment about the whole screen sits at its top left.
const WHOLE_SCREEN_PIN = { x: 0.02, y: 0.02 };

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

const CLOSED_DRAWER: FullscreenDrawer = { open: false, pinned: false };

function revisionName(revision: string) {
  return revision.replace(/^local-/, "");
}

// Keeps a side column in view while the page scrolls. A column shorter than
// the window sticks to the top; a taller one scrolls with the page until its
// end is reached, so the page is the only scroll area.
function useFollowPage(ref: RefObject<HTMLElement | null>, gap = 0) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const room = window.innerHeight - gap;
      element.style.top = `${Math.min(0, room - element.offsetHeight)}px`;
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref, gap]);
}

type LoadState =
  { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

const HIDDEN_PINS_KEY = "screencheck:hidden-pin-statuses";

// Fixed and Verified pins are hidden until the reviewer asks to see them.
const DEFAULT_HIDDEN_PINS: FeedbackStatus[] = ["RESOLVED", "VERIFIED"];
// Statuses that existed when the choice was saved as a bare list.
const LEGACY_KNOWN_STATUSES: FeedbackStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "WONT_FIX",
];

// Saved as {hidden, known}; a status added since the choice was saved (not in
// `known`) takes its default, so a new Verified section starts hidden.
export function readHiddenPinStatuses(): FeedbackStatus[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_PINS_KEY);
    if (raw === null) return [...DEFAULT_HIDDEN_PINS];
    const parsed: unknown = JSON.parse(raw);
    let hidden: unknown[];
    let known: unknown[];
    if (Array.isArray(parsed)) {
      hidden = parsed;
      known = LEGACY_KNOWN_STATUSES;
    } else if (
      typeof parsed === "object" &&
      parsed !== null &&
      "hidden" in parsed &&
      Array.isArray(parsed.hidden)
    ) {
      hidden = parsed.hidden;
      known =
        "known" in parsed && Array.isArray(parsed.known) ? parsed.known : [];
    } else {
      return [...DEFAULT_HIDDEN_PINS];
    }
    return FEEDBACK_STATUSES.filter((status) =>
      known.includes(status)
        ? hidden.includes(status)
        : DEFAULT_HIDDEN_PINS.includes(status),
    );
  } catch {
    return [...DEFAULT_HIDDEN_PINS];
  }
}

function writeHiddenPinStatuses(hidden: FeedbackStatus[]) {
  window.localStorage.setItem(
    HIDDEN_PINS_KEY,
    JSON.stringify({ hidden, known: FEEDBACK_STATUSES }),
  );
}

export function App() {
  const [list, setList] = useState<ProjectList | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((loaded) => {
        if (!cancelled) setList(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setList({
          projects: [],
          problems: [
            `Projects could not load (${error instanceof Error ? error.message : "unknown error"}).`,
          ],
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!list) {
    return (
      <main className="workbench-shell">
        <p className="workbench-banner" role="status">
          Loading projects…
        </p>
      </main>
    );
  }
  if (list.projects.length === 0) return <NoProjects list={list} />;
  return <Workbench projects={list.projects} projectProblems={list.problems} />;
}

const MINIMAL_REGISTRATION = `{
  "id": "my-app",
  "name": "My app",
  "versions": [{ "id": "build-1", "captureRoot": "/path/to/captures" }],
  "screens": [
    {
      "id": "home",
      "ordinal": 1,
      "title": "Home",
      "group": "Main",
      "capturePath": "home.png",
      "viewport": { "width": 1440, "height": 1000 }
    }
  ]
}`;

// A fresh install: say where projects go and how to add one, rather than
// showing a placeholder that looks like a broken demo.
function NoProjects({ list }: { list: ProjectList }) {
  const [copied, setCopied] = useState(false);
  const folder = list.projectsRoot ?? "~/.screencheck/projects";
  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div>
          <span className="eyebrow">Design review</span>
          <h1>ScreenCheck</h1>
        </div>
      </header>
      {list.problems.map((problem) => (
        <p
          className="workbench-banner workbench-banner-error"
          key={problem}
          role="alert"
        >
          {problem}
        </p>
      ))}
      <section aria-labelledby="no-projects-title" className="no-projects">
        <h2 id="no-projects-title">No projects yet</h2>
        <p>
          Add one JSON file per project to <code>{folder}</code>, then reload.
          Each version points at the folder its captures already live in.
        </p>
        <pre aria-label="Minimal project file">{MINIMAL_REGISTRATION}</pre>
        <button
          onClick={() => {
            void navigator.clipboard
              ?.writeText(MINIMAL_REGISTRATION)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy example"}
        </button>
        <p>
          To look around first, run <code>npm run playground</code> for a seeded
          demo.
        </p>
      </section>
    </main>
  );
}

function Workbench({
  projects,
  projectProblems,
}: {
  projects: PublicProject[];
  projectProblems: string[];
}) {
  const [railMode, setRailMode] = useState<RailMode>("wide");
  const initialPlace = useMemo(readPlace, []);
  const [projectId, setProjectId] = useState(initialPlace.project ?? "");
  // A shared link or reload opens the version in the URL; when a newer
  // build exists the header offers to switch rather than switching silently.
  const [versionChoice, setVersionChoice] = useState(
    initialPlace.version ?? "",
  );
  const [newerDismissed, setNewerDismissed] = useState(false);
  const [selectedChoice, setSelectedId] = useState(initialPlace.screen ?? "");
  // "all" lists every resolution in the rail; a version narrows it to one.
  const [resolutionChoice, setResolutionChoice] = useState("all");
  const project =
    projects.find((item) => item.id === projectId) ?? projects[0]!;
  const screens: PublicScreen[] = project.screens;
  const [revisionChoice, setRevisionChoice] = useState("");
  const versions = useMemo(
    () => versionModel(project),
    [project.versions, project.versionDetails],
  );
  const { revisionOf, labelOf, revisions } = versions;
  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  const newestRevision = revisions.at(-1)!;
  const revision = revisions.includes(revisionChoice)
    ? revisionChoice
    : !revisionChoice && project.versions.includes(versionChoice)
      ? revisionOf(versionChoice)
      : newestRevision;
  const newerBuild =
    !newerDismissed &&
    (!initialPlace.project || project.id === initialPlace.project) &&
    initialPlace.version !== undefined &&
    project.versions.includes(initialPlace.version) &&
    revision === revisionOf(initialPlace.version) &&
    revision !== newestRevision;
  const revisionVersions = useMemo(
    () => versions.versionsOf(revision),
    [versions, revision],
  );
  const resolution = revisionVersions.includes(resolutionChoice)
    ? resolutionChoice
    : "all";
  const version =
    resolution !== "all"
      ? resolution
      : revisionVersions.includes(versionChoice)
        ? versionChoice
        : revisionVersions.at(-1)!;
  const selectedId = screens.some((item) => item.id === selectedChoice)
    ? selectedChoice
    : screens[0]!.id;
  const [fullscreen, setFullscreen] = useState(false);
  const [drawer, setDrawer] = useState<FullscreenDrawer>(CLOSED_DRAWER);
  const [feedbackRecords, setFeedbackRecords] = useState<FeedbackRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const clearNotice = useCallback((kind: NoticeKind) => {
    setNotice((current) => (current?.kind === kind ? null : current));
  }, []);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [visibleFeedback, setVisibleFeedback] =
    useState<FeedbackRecord[]>(feedbackRecords);
  const [addingFeedback, setAddingFeedback] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // null until loaded; the approve toggle stays disabled until then.
  const [approvals, setApprovals] = useState<ScreenApproval[] | null>(null);
  const approvalRequest = useRef(0);
  const [captions, setCaptions] = useState<Caption[] | null>(null);
  const captionRequest = useRef(0);
  const [hiddenPinStatuses, setHiddenPinStatuses] = useState<FeedbackStatus[]>(
    readHiddenPinStatuses,
  );
  // Keyboard pin placement: a crosshair the arrow keys move over the frame.
  const [crosshair, setCrosshair] = useState({ x: 0.5, y: 0.5 });
  const frameRef = useRef<HTMLDivElement>(null);
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(
    null,
  );
  const selected = screens.find((item) => item.id === selectedId)!;
  const [captureFailed, setCaptureFailed] = useState(false);
  // A full-page capture can be taller than the registered viewport, so the
  // frame takes the loaded image's own proportions rather than stretching it.
  const [captureSize, setCaptureSize] = useState<{
    key: string;
    width: number;
    height: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  useFollowPage(panelRef, 64);

  useEffect(() => {
    const params = new URLSearchParams({
      project: project.id,
      version,
      screen: selectedId,
    });
    window.history.replaceState(null, "", `#${params}`);
  }, [projects, project.id, version, selectedId]);

  useEffect(() => setCaptureFailed(false), [project.id, version, selectedId]);

  // Follow links and edits to the address while the app is open.
  useEffect(() => {
    const follow = () => {
      const place = readPlace();
      if (place.project) setProjectId(place.project);
      if (place.version) {
        setVersionChoice(place.version);
        setRevisionChoice(versionsRef.current.revisionOf(place.version));
      }
      if (place.screen) setSelectedId(place.screen);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const pinNumbers = useMemo(
    () => createPinNumbers(feedbackRecords),
    [feedbackRecords],
  );
  const ready = loadState.kind === "ready";
  const openCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of feedbackRecords) {
      if (item.version === version && isOpenFeedback(item)) {
        counts.set(item.screenId, (counts.get(item.screenId) ?? 0) + 1);
      }
    }
    return counts;
  }, [feedbackRecords, version]);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: "loading" });
    (async () => {
      try {
        const warning = await migrateLegacyFeedback(project.id);
        const records = await fetchFeedback(project.id);
        if (cancelled) return;
        setFeedbackRecords(records);
        setNotice(warning ? { kind: "migration", text: warning } : null);
        setLoadState({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setLoadState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Feedback could not load.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt, projects, project.id]);

  useEffect(() => {
    let cancelled = false;
    setApprovals(null);
    fetchApprovals(project.id).then(
      (list) => {
        if (!cancelled) setApprovals(list);
      },
      (error: unknown) => {
        if (cancelled) return;
        setNotice({
          kind: "approvals-load",
          text: `Screen approvals could not load: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, projects, project.id]);

  useEffect(() => {
    let cancelled = false;
    setCaptions(null);
    fetchCaptions(project.id).then(
      (list) => {
        if (!cancelled) setCaptions(list);
      },
      (error: unknown) => {
        if (cancelled) return;
        setNotice({
          kind: "captions-load",
          text: `Screen descriptions could not load: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, projects, project.id]);

  useEffect(() => {
    if (!fullscreen) setDrawer(CLOSED_DRAWER);
  }, [fullscreen]);

  const placingPin = addingFeedback && !draftPin;
  useEffect(() => {
    if (!placingPin) return;
    setCrosshair({ x: 0.5, y: 0.5 });
    frameRef.current?.focus({ preventScroll: true });
  }, [placingPin]);

  const placePin = useCallback((pin: { x: number; y: number }) => {
    setDraftPin(pin);
    setSelectedFeedbackId(null);
  }, []);

  const clearSelectionOnDelete = useCallback((id: string) => {
    setSelectedFeedbackId((current) => (current === id ? null : current));
  }, []);
  const { createFeedback, updateFeedback, deleteFeedback } = useFeedbackStore({
    projectId: project.id,
    setRecords: setFeedbackRecords,
    onDeleted: clearSelectionOnDelete,
  });

  const togglePinStatus = useCallback((status: FeedbackStatus) => {
    setHiddenPinStatuses((current) => {
      const next = current.includes(status)
        ? current.filter((value) => value !== status)
        : [...current, status];
      try {
        writeHiddenPinStatuses(next);
      } catch {
        // Storage can be unavailable; the choice still lasts this session.
      }
      return next;
    });
  }, []);

  const approvedIds = useMemo(
    () =>
      new Set(
        (approvals ?? [])
          .filter((approval) => approval.version === version)
          .map((approval) => approval.screenId),
      ),
    [approvals, version],
  );
  // When a revision has several versions (one per viewport), the rail lists
  // every screen at each of them so review is one scroll rather than a
  // dropdown per screen.
  const flatItems = useMemo(() => {
    const shown = revisionVersions.filter(
      (item) => resolution === "all" || item === resolution,
    );
    let ordinal = 0;
    return screens.flatMap((screen) =>
      shown.map((item) => ({
        ...screen,
        id: `${screen.id}@@${item}`,
        screenId: screen.id,
        version: item,
        versionLabel: labelOf(item),
        ordinal: ++ordinal,
        title: `${screen.title} · ${labelOf(item)}`,
      })),
    );
  }, [revisionVersions, resolution, screens, labelOf]);
  const flatMode = revisionVersions.length > 1;
  // The versions the rail lists, which Export offers to include.
  const exportVersions = useMemo(
    () =>
      (flatMode
        ? revisionVersions.filter(
            (item) => resolution === "all" || item === resolution,
          )
        : [version]
      ).map((id) => ({ id, label: labelOf(id) })),
    [flatMode, revisionVersions, resolution, version, labelOf],
  );
  const flatOpenCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of feedbackRecords) {
      if (isOpenFeedback(item)) {
        const key = `${item.screenId}@@${item.version}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [feedbackRecords]);
  const flatApprovedIds = useMemo(
    () =>
      new Set(
        (approvals ?? []).map(
          (approval) => `${approval.screenId}@@${approval.version}`,
        ),
      ),
    [approvals],
  );
  const [hideApproved, setHideApproved] = useState(readHideApproved);
  const changeHideApproved = useCallback((hide: boolean) => {
    setHideApproved(hide);
    writeHideApproved(hide);
  }, []);
  const railSelectedId = flatMode ? `${selectedId}@@${version}` : selectedId;
  const railApprovedIds = flatMode ? flatApprovedIds : approvedIds;
  // The rows the rail shows; Prev/Next and ← / → walk the same list.
  const railItems = useMemo(
    () =>
      visibleRailScreens<{ id: string; screenId: string; version?: string }>(
        flatMode
          ? flatItems
          : screens.map((item) => ({ id: item.id, screenId: item.id })),
        railSelectedId,
        railApprovedIds,
        hideApproved,
      ),
    [
      flatMode,
      flatItems,
      screens,
      railSelectedId,
      railApprovedIds,
      hideApproved,
    ],
  );
  const railIndex = railItems.findIndex((item) => item.id === railSelectedId);
  const screenApproved = approvals
    ? isApproved(approvals, version, selectedId)
    : false;

  const saveCaption = useCallback(
    async (text: string) => {
      if (!captions) return;
      const previous = captions;
      const request = ++captionRequest.current;
      const others = previous.filter(
        (item) => item.version !== version || item.screenId !== selectedId,
      );
      setCaptions(
        text
          ? [
              ...others,
              {
                version,
                screenId: selectedId,
                text,
                updatedAt: new Date().toISOString(),
              },
            ]
          : others,
      );
      try {
        const saved = await putCaption(project.id, {
          version,
          screenId: selectedId,
          text,
        });
        if (request === captionRequest.current) {
          setCaptions(saved);
          clearNotice("caption-save");
        }
      } catch (error) {
        if (request !== captionRequest.current) return;
        setCaptions(previous);
        setNotice({
          kind: "caption-save",
          text: `Description was not saved: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      }
    },
    [captions, clearNotice, project.id, selectedId, version],
  );

  const toggleApproval = useCallback(async () => {
    if (!approvals) return;
    const previous = approvals;
    const request = ++approvalRequest.current;
    const approved = !isApproved(previous, version, selectedId);
    setApprovals(
      approved
        ? [
            ...previous,
            {
              version,
              screenId: selectedId,
              approvedAt: new Date().toISOString(),
            },
          ]
        : previous.filter(
            (item) => item.version !== version || item.screenId !== selectedId,
          ),
    );
    try {
      const saved = await putApproval(project.id, {
        version,
        screenId: selectedId,
        approved,
      });
      // A quick re-toggle supersedes this response.
      if (request === approvalRequest.current) {
        setApprovals(saved);
        clearNotice("approval-save");
      }
    } catch (error) {
      if (request !== approvalRequest.current) return;
      setApprovals(previous);
      setNotice({
        kind: "approval-save",
        text: `Approval was not saved: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
    }
  }, [approvals, clearNotice, project.id, selectedId, version]);

  // A failed save is about the screen it happened on; moving on retires it.
  useEffect(() => {
    setNotice((current) =>
      current && SAVE_NOTICES.has(current.kind) ? null : current,
    );
  }, [project.id, selectedId, version]);

  const selectScreen = useCallback((id: string) => {
    setSelectedId(id);
    setAddingFeedback(false);
    setDraftPin(null);
    setSelectedFeedbackId(null);
    // Start each screen at its top, without jumping when it is already in view.
    const grid = gridRef.current;
    if (grid && grid.getBoundingClientRect().top < 0) {
      window.scrollTo({
        top: window.scrollY + grid.getBoundingClientRect().top,
      });
    }
  }, []);

  const selectRailItem = useCallback(
    (item: { screenId: string; version?: string }) => {
      if (item.version) setVersionChoice(item.version);
      selectScreen(item.screenId);
    },
    [selectScreen],
  );

  const stepScreen = useCallback(
    (delta: number) => {
      const next = railIndex < 0 ? undefined : railItems[railIndex + delta];
      if (next) selectRailItem(next);
    },
    [railIndex, railItems, selectRailItem],
  );

  const startPin = useCallback(() => {
    if (!ready) return;
    setAddingFeedback(true);
    setDraftPin(null);
    setSelectedFeedbackId(null);
  }, [ready]);

  const switchProject = useCallback((id: string) => {
    setProjectId(id);
    setVersionChoice("");
    setRevisionChoice("");
    setResolutionChoice("all");
    setSelectedId("");
    setFeedbackRecords([]);
    setAddingFeedback(false);
    setDraftPin(null);
    setSelectedFeedbackId(null);
  }, []);

  // ⌘F / Ctrl+F adds feedback instead of opening the browser's find bar;
  // ← and → (or [ and ]) step through screens; ⌘A approves (the inspector
  // fills approveShortcutRef). Escape undoes only the innermost thing: the
  // export dialog owns it, then pin placement, then the fullscreen drawer,
  // then fullscreen itself.
  const approveShortcutRef = useRef<(() => void) | null>(null);
  useShortcuts({
    escape: [
      { active: exportOpen, run: () => {}, block: true, whileTyping: true },
      {
        active: addingFeedback && !draftPin,
        run: () => setAddingFeedback(false),
        whileTyping: true,
      },
      {
        active: fullscreen && drawer.open,
        run: () => setDrawer(CLOSED_DRAWER),
      },
      { active: fullscreen, run: () => setFullscreen(false) },
    ],
    addFeedback: startPin,
    approve: () => {
      const approve = approveShortcutRef.current;
      approve?.();
      return Boolean(approve);
    },
    step: stepScreen,
  });

  const navigation = (
    <ScreenRail
      mode={fullscreen ? "compact" : railMode}
      onModeChange={fullscreen ? undefined : setRailMode}
      approvedIds={railApprovedIds}
      hideApproved={hideApproved}
      onHideApprovedChange={changeHideApproved}
      onSelect={(id) => {
        const item = flatMode
          ? flatItems.find((entry) => entry.id === id)
          : undefined;
        selectRailItem(item ?? { screenId: id });
      }}
      openCounts={flatMode ? flatOpenCounts : openCounts}
      screens={flatMode ? flatItems : screens}
      selectedId={railSelectedId}
    />
  );
  const feedback = (
    <FeedbackInspector
      approveShortcut={approveShortcutRef}
      draftPin={draftPin}
      feedback={feedbackRecords}
      onCancelDraft={() => {
        setAddingFeedback(false);
        setDraftPin(null);
      }}
      onCreate={createFeedback}
      ready={ready}
      adding={addingFeedback}
      onRecoverDraft={(pin) => {
        setAddingFeedback(true);
        setDraftPin(pin);
      }}
      onSelectFeedback={setSelectedFeedbackId}
      onUpdate={updateFeedback}
      onDelete={deleteFeedback}
      onVisibleFeedbackChange={setVisibleFeedback}
      hiddenPinStatuses={hiddenPinStatuses}
      onTogglePinStatus={togglePinStatus}
      approval={{
        approved: screenApproved,
        ready: approvals !== null,
        onToggle: toggleApproval,
      }}
      key={project.id}
      projectId={project.id}
      screens={screens}
      selectedFeedbackId={selectedFeedbackId}
      selectedScreenId={selectedId}
      version={version}
    />
  );
  const captureKey = `${project.id}/${version}/${selected.id}`;
  const frameSize =
    captureSize?.key === captureKey ? captureSize : selected.viewport;
  const canvas = (
    <section
      className="review-canvas"
      data-adding-feedback={addingFeedback}
      data-testid="canvas"
      id="review-capture"
      tabIndex={-1}
      style={
        { "--screen-width": `${selected.viewport.width}px` } as CSSProperties
      }
    >
      <header className="canvas-header">
        <div>
          <span className="eyebrow">
            {String(selected.ordinal).padStart(2, "0")} / {screens.length} ·{" "}
            {selected.group}
          </span>
          <h2>{selected.title}</h2>
        </div>
        <div className="canvas-header-actions">
          {selected.liveUrl ? (
            <a href={selected.liveUrl} rel="noreferrer" target="_blank">
              Open live
            </a>
          ) : null}
        </div>
      </header>
      <ScreenCaption
        disabled={!captions}
        key={`${project.id}/${version}/${selectedId}`}
        manifest={selected.description}
        onSave={saveCaption}
        saved={captions ? captionFor(captions, version, selectedId) : undefined}
      />
      <div
        className="screen-frame"
        data-testid="screen-frame"
        onClick={(event) => {
          if (
            !addingFeedback ||
            !ready ||
            (event.target instanceof HTMLElement &&
              event.target.closest("button"))
          ) {
            return;
          }
          // Pins are stored relative to the screen frame, which keeps the
          // screen's aspect ratio, so they land on the same spot at any size.
          const rect = event.currentTarget.getBoundingClientRect();
          placePin(normalizePinCoordinates(event.clientX, event.clientY, rect));
        }}
        onKeyDown={(event) => {
          if (!placingPin || !ready) return;
          const step = event.shiftKey ? 0.1 : 0.01;
          const move = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          }[event.key];
          if (move) {
            event.preventDefault();
            setCrosshair((current) => ({
              x: clampUnit(current.x + move[0]!),
              y: clampUnit(current.y + move[1]!),
            }));
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            placePin(crosshair);
          }
        }}
        ref={frameRef}
        {...(placingPin
          ? {
              "aria-label": `Place a pin at ${Math.round(crosshair.x * 100)}% across, ${Math.round(crosshair.y * 100)}% down. Arrow keys move, Shift moves further, Enter drops the pin.`,
              role: "application",
              tabIndex: 0,
            }
          : {})}
        style={
          {
            "--screen-ratio": `${frameSize.width} / ${frameSize.height}`,
            "--screen-width": `${frameSize.width}px`,
          } as CSSProperties
        }
      >
        {selected.hasCapture && !captureFailed ? (
          <img
            alt={`${selected.title} capture`}
            className="screen-capture"
            draggable={false}
            key={captureKey}
            onError={() => setCaptureFailed(true)}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth && naturalHeight) {
                setCaptureSize({
                  key: captureKey,
                  width: naturalWidth,
                  height: naturalHeight,
                });
              }
            }}
            src={captureUrl(project.id, version, selected.id)}
          />
        ) : (
          <div className="empty-canvas">
            <span className="eyebrow">
              {String(selected.ordinal).padStart(2, "0")} / {screens.length}
            </span>
            <h2>{selected.title}</h2>
            <span className="screen-frame-size">
              {captureFailed
                ? "Capture could not load · "
                : selected.hasCapture
                  ? ""
                  : "No capture · "}
              {selected.viewport.width} × {selected.viewport.height}
            </span>
          </div>
        )}
        <div className="feedback-pin-layer" aria-label="Screen feedback pins">
          {visibleFeedback
            .filter(
              (item) =>
                item.screenId === selectedId &&
                item.version === version &&
                (!hiddenPinStatuses.includes(item.status) ||
                  item.id === selectedFeedbackId),
            )
            .map((item) => (
              <button
                aria-controls={`feedback-comment-${item.id}`}
                aria-label={`Pin ${pinNumbers.get(item.id) ?? 0}${item.status === "RESOLVED" ? " (fixed)" : item.status === "VERIFIED" ? " (verified)" : ""}: ${item.note}`}
                aria-pressed={item.id === selectedFeedbackId}
                className={`feedback-pin ${pinDotClassName(item, item.id === selectedFeedbackId)}`}
                data-testid="feedback-pin"
                id={feedbackPinId(item.id)}
                key={item.id}
                // The feedback panel moves focus into the opened editor.
                onClick={() => setSelectedFeedbackId(item.id)}
                style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }}
                type="button"
              >
                {pinNumbers.get(item.id) ?? 0}
              </button>
            ))}
          {placingPin ? (
            <span
              aria-hidden="true"
              className="pin-crosshair"
              style={{
                left: `${crosshair.x * 100}%`,
                top: `${crosshair.y * 100}%`,
              }}
            />
          ) : null}
          {draftPin ? (
            <span
              className="feedback-pin pin-dot feedback-pin-draft"
              data-testid="draft-pin"
              style={{
                left: `${draftPin.x * 100}%`,
                top: `${draftPin.y * 100}%`,
              }}
            >
              +
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );

  const actionBar = (
    <footer className="action-bar" aria-label="Review actions">
      <div className="action-bar-start">
        <button
          aria-keyshortcuts={fullscreen ? SHORTCUTS.escape.aria : undefined}
          aria-label={fullscreen ? "Exit fullscreen" : "View fullscreen"}
          aria-pressed={fullscreen}
          className="icon-button action-bar-fullscreen"
          onClick={() => setFullscreen((value) => !value)}
          title={
            fullscreen
              ? `Exit fullscreen (${SHORTCUTS.escape.label})`
              : "View fullscreen"
          }
          type="button"
        >
          <svg aria-hidden="true" height="18" viewBox="0 0 18 18" width="18">
            <path
              d={
                fullscreen
                  ? "M7 2v5H2M11 2v5h5M7 16v-5H2M11 16v-5h5"
                  : "M2 7V2h5M16 7V2h-5M2 11v5h5M16 11v5h-5"
              }
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            />
          </svg>
        </button>
        {placingPin ? (
          <>
            <p className="action-bar-hint" role="status">
              Click the screen to place a pin, or use the arrow keys and Enter ·
              Esc to cancel
            </p>
            <button
              className="action-bar-whole-screen"
              onClick={() => placePin(WHOLE_SCREEN_PIN)}
              type="button"
            >
              Comment on whole screen
            </button>
          </>
        ) : null}
      </div>
      <div className="action-bar-nav">
        <button
          aria-label="Previous screen"
          disabled={railIndex <= 0}
          onClick={() => stepScreen(-1)}
          aria-keyshortcuts={SHORTCUTS.previous.aria}
          title={`Previous screen (${SHORTCUTS.previous.label})`}
          type="button"
        >
          ‹ Prev
        </button>
        <span className="action-bar-place" aria-live="polite">
          <strong>
            {String(selected.ordinal).padStart(2, "0")} / {screens.length}
          </strong>{" "}
          {selected.title}
        </span>
        <button
          aria-label="Next screen"
          disabled={railIndex < 0 || railIndex >= railItems.length - 1}
          onClick={() => stepScreen(1)}
          aria-keyshortcuts={SHORTCUTS.next.aria}
          title={`Next screen (${SHORTCUTS.next.label})`}
          type="button"
        >
          Next ›
        </button>
      </div>
      <div className="action-bar-end">
        <button
          aria-haspopup="dialog"
          className="action-bar-export"
          disabled={!ready}
          onClick={() => setExportOpen(true)}
          type="button"
        >
          Export
        </button>
        <button
          aria-keyshortcuts={SHORTCUTS.addFeedback.aria}
          aria-pressed={addingFeedback}
          className="feedback-add-button"
          disabled={!ready}
          onClick={startPin}
          title={`Add feedback (${SHORTCUTS.addFeedback.label})`}
          type="button"
        >
          Add feedback <kbd aria-hidden="true">{SHORTCUTS.addFeedback.kbd}</kbd>
        </button>
      </div>
      {exportOpen ? (
        <ExportDialog
          feedback={feedbackRecords}
          onClose={() => setExportOpen(false)}
          projectId={project.id}
          screens={screens}
          selectedScreenId={selectedId}
          version={version}
          versions={exportVersions}
        />
      ) : null}
    </footer>
  );

  // Skip past the rail's tab stop to the capture or the feedback. They focus
  // the target directly; following "#…" would rewrite the place in the URL.
  const skipLinks = (
    <div className="skip-links">
      {[
        ["review-capture", "Skip to capture"],
        ["feedback-panel", "Skip to feedback"],
      ].map(([id, label]) => (
        <a
          href={`#${id}`}
          key={id}
          onClick={(event) => {
            event.preventDefault();
            document.getElementById(id!)?.focus();
          }}
        >
          {label}
        </a>
      ))}
    </div>
  );

  if (fullscreen) {
    return (
      <>
        {skipLinks}
        <FullscreenReview
          feedback={feedback}
          navigation={navigation}
          drawer={drawer}
          onDrawerChange={setDrawer}
        >
          {canvas}
        </FullscreenReview>
        {actionBar}
      </>
    );
  }

  return (
    <main className="workbench-shell">
      {skipLinks}
      <header className="workbench-header">
        <div>
          <span className="eyebrow">Design review</span>
          <h1>ScreenCheck</h1>
        </div>
        <div className="header-controls">
          {projects.length > 1 ? (
            <label>
              Project
              <select
                onChange={(event) => switchProject(event.target.value)}
                value={project.id}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="header-project">{project.name}</span>
          )}
          {revisions.length > 1 ? (
            <label>
              Revision
              <select
                onChange={(event) => {
                  const next = event.target.value;
                  const sameResolution = project.versions.find(
                    (item) =>
                      revisionOf(item) === next &&
                      labelOf(item) === labelOf(version),
                  );
                  setNewerDismissed(true);
                  setRevisionChoice(next);
                  setVersionChoice(sameResolution ?? "");
                  setResolutionChoice(
                    resolution !== "all" && sameResolution
                      ? sameResolution
                      : "all",
                  );
                }}
                value={revision}
              >
                {[...revisions].reverse().map((item) => (
                  <option key={item} value={item}>
                    {revisionName(item)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {revisionVersions.length > 1 ? (
            <label>
              Viewport
              <select
                onChange={(event) => {
                  const next = event.target.value;
                  setResolutionChoice(next);
                  if (next !== "all") setVersionChoice(next);
                }}
                value={resolution}
              >
                <option value="all">All</option>
                {revisionVersions.map((item) => (
                  <option key={item} value={item}>
                    {labelOf(item)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="status-pill">{version}</span>
          )}
        </div>
      </header>
      {newerBuild ? (
        <div className="workbench-banner" role="status">
          <span>
            Showing {revisionName(revision)} from the link. A newer build,{" "}
            {revisionName(newestRevision)}, is available.
          </span>
          <button
            onClick={() => {
              setNewerDismissed(true);
              setRevisionChoice(newestRevision);
              setVersionChoice("");
              setResolutionChoice("all");
            }}
            type="button"
          >
            Switch to {revisionName(newestRevision)}
          </button>
          <button onClick={() => setNewerDismissed(true)} type="button">
            Stay
          </button>
        </div>
      ) : null}
      {projectProblems.map((problem) => (
        <p
          className="workbench-banner workbench-banner-error"
          key={problem}
          role="alert"
        >
          {problem}
        </p>
      ))}
      {loadState.kind === "loading" ? (
        <p className="workbench-banner" role="status">
          Loading feedback…
        </p>
      ) : null}
      {loadState.kind === "error" ? (
        <div className="workbench-banner workbench-banner-error" role="alert">
          <span>Feedback could not load: {loadState.message}</span>
          <button onClick={() => setLoadAttempt((n) => n + 1)} type="button">
            Retry
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="workbench-banner workbench-banner-error" role="alert">
          <span>{notice.text}</span>
          <button
            aria-label="Dismiss message"
            onClick={() => setNotice(null)}
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <section
        className="workbench-grid"
        data-rail-mode={railMode}
        aria-label="Review workspace"
        ref={gridRef}
      >
        <div className="rail-column">{navigation}</div>
        {canvas}
        <div className="feedback-column">
          <div className="feedback-follow" ref={panelRef}>
            {feedback}
          </div>
        </div>
      </section>
      {actionBar}
    </main>
  );
}

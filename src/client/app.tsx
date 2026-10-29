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
  RoundSummaryDialog,
  SummariseRoundButton,
  SummariseRoundMenuItem,
} from "./components/assist";
import {
  FullscreenReview,
  type FullscreenDrawer,
} from "./components/fullscreen-review";
import { CompareSizes } from "./components/compare-sizes";
import {
  PinBoxOutline,
  pinBoxClassName,
  usePinDrag,
} from "./components/pin-layer";
import { ReviewerNameMenuItem } from "./components/reviewer-name";
import { ScreenCaption } from "./components/screen-caption";
import { CanvasToolbar, type Zoom } from "./components/size-switcher";
import {
  ScreenRail,
  readHideApproved,
  visibleRailScreens,
  writeHideApproved,
  type RailMode,
  TABLET_QUERY,
  defaultRailMode,
} from "./components/screen-rail";
import { isApproved, type ScreenApproval } from "../shared/approvals";
import { rollUpSizes } from "./sizes";
import { useSizes, viewportLookup } from "./use-sizes";
import { captionFor, type ScreenCaption as Caption } from "../shared/captions";
import { createPinNumbers } from "../shared/export";
import {
  FEEDBACK_STATUSES,
  isOpenFeedback,
  type FeedbackRecord,
  type FeedbackStatus,
} from "../shared/feedback";
import { pinAnchor, pinBoxOf, type BoxPin } from "../shared/pin-box";
import {
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
import { captureSrc } from "./offline-api";
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

// --action-bar-height, the spec footer size (--size-footer).
const ACTION_BAR_HEIGHT = 65;

const CLOSED_DRAWER: FullscreenDrawer = { open: false, pinned: false };

function revisionName(revision: string) {
  return revision.replace(/^local-/, "");
}

// Keeps a side column in view while the page scrolls. A column shorter than
// the window keeps its foot on the action bar; a taller one scrolls with the
// page until its end is reached, so the page is the only scroll area.
// Phones get one task at a time: feedback is a sheet, extras live in a menu.
export const PHONE_QUERY = "(max-width: 480px)";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const follow = () => setMatches(list.matches);
    follow();
    list.addEventListener("change", follow);
    return () => list.removeEventListener("change", follow);
  }, [query]);
  return matches;
}

function useFollowPage(ref: RefObject<HTMLElement | null>, gap = 0) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const room = window.innerHeight - gap;
      element.style.top = `${room - element.offsetHeight}px`;
      // Where the column starts on the page, so CSS can fill the first
      // screenful exactly and seat the approval band on the action bar.
      const column = element.parentElement;
      if (column) {
        const start = column.getBoundingClientRect().top + window.scrollY;
        element.style.setProperty("--follow-start", `${Math.round(start)}px`);
      }
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
        <div className="workbench-brand">
          <h1>ScreenCheck</h1>
          <span className="eyebrow">Design review</span>
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
  const [railMode, setRailMode] = useState<RailMode>(defaultRailMode);
  // Fullscreen keeps its own rail choice; it opens as numbers on the edge.
  const [fullscreenRailMode, setFullscreenRailMode] =
    useState<RailMode>("compact");
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const tablet = window.matchMedia(TABLET_QUERY);
    const follow = () => setRailMode(defaultRailMode());
    tablet.addEventListener("change", follow);
    return () => tablet.removeEventListener("change", follow);
  }, []);
  const initialPlace = useMemo(readPlace, []);
  const [projectId, setProjectId] = useState(initialPlace.project ?? "");
  // A shared link or reload opens the version in the URL; when a newer
  // build exists the header offers to switch rather than switching silently.
  const [versionChoice, setVersionChoice] = useState(
    initialPlace.version ?? "",
  );
  const [newerDismissed, setNewerDismissed] = useState(false);
  const [selectedChoice, setSelectedId] = useState(initialPlace.screen ?? "");
  // Before shows the previous build's capture of the same screen and size.
  const [showBefore, setShowBefore] = useState(false);
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
  // A revision's versions are its sizes; the chosen one is the version.
  const version = revisionVersions.includes(versionChoice)
    ? versionChoice
    : revisionVersions.at(-1)!;
  const beforeVersion = versions.previousVersion(version);
  const comparing = showBefore && beforeVersion !== undefined;
  const shownVersion = comparing ? beforeVersion : version;
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
  const [summaryOpen, setSummaryOpen] = useState(false);
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
  const [draftPin, setDraftPin] = useState<BoxPin | null>(null);
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(
    null,
  );
  const phone = useMediaQuery(PHONE_QUERY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // On a phone the sheet gets out of the way while a pin is placed, then
  // comes back for the note or a tapped pin.
  useEffect(() => {
    if (!phone) return;
    if (addingFeedback && !draftPin) setSheetOpen(false);
    else if (draftPin || selectedFeedbackId) setSheetOpen(true);
  }, [phone, addingFeedback, draftPin, selectedFeedbackId]);
  useEffect(() => {
    if (!moreOpen) return;
    moreRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [moreOpen]);
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
  useFollowPage(panelRef, ACTION_BAR_HEIGHT);

  useEffect(() => {
    const params = new URLSearchParams({
      project: project.id,
      version,
      screen: selectedId,
    });
    window.history.replaceState(null, "", `#${params}`);
  }, [projects, project.id, version, selectedId]);

  useEffect(
    () => setCaptureFailed(false),
    [project.id, shownVersion, selectedId],
  );

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

  const placePin = useCallback((pin: BoxPin) => {
    setDraftPin(pin);
    setSelectedFeedbackId(null);
  }, []);
  const pinDrag = usePinDrag({
    enabled: addingFeedback && ready,
    onPlace: placePin,
  });

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

  const chooseSize = useCallback((next: string) => {
    setVersionChoice(next);
    // Pins belong to one size, so a half-placed pin does not follow.
    setAddingFeedback(false);
    setDraftPin(null);
    setSelectedFeedbackId(null);
  }, []);
  const viewportOf = useMemo(
    () => viewportLookup(project.versionDetails),
    [project.versionDetails],
  );
  const sizing = useSizes({
    revisionVersions,
    labelOf,
    viewportOf,
    version,
    onChange: chooseSize,
  });
  const { sizes } = sizing;
  // Changing build keeps the size you were reviewing when the build has it.
  const sameSizeIn = (next: string) =>
    versions
      .versionsOf(next)
      .find((item) => labelOf(item) === labelOf(version)) ?? "";
  // One index row per screen: badges and approval roll up across sizes.
  const rollup = useMemo(
    () =>
      rollUpSizes(
        screens.map((item) => item.id),
        sizes,
        feedbackRecords,
        approvals ?? [],
      ),
    [screens, sizes, feedbackRecords, approvals],
  );
  // The sizes Export offers to include.
  const exportVersions = useMemo(
    () => sizes.map((size) => ({ id: size.version, label: size.label })),
    [sizes],
  );
  const [hideApproved, setHideApproved] = useState(readHideApproved);
  const changeHideApproved = useCallback((hide: boolean) => {
    setHideApproved(hide);
    writeHideApproved(hide);
  }, []);
  // The rows the rail shows; Prev/Next and ← / → walk the same list.
  const railItems = useMemo(
    () =>
      visibleRailScreens(
        screens.map((item) => ({ id: item.id })),
        selectedId,
        rollup.approvedIds,
        hideApproved,
      ),
    [screens, selectedId, rollup.approvedIds, hideApproved],
  );
  const railIndex = railItems.findIndex((item) => item.id === selectedId);
  const screenApproved = approvals
    ? isApproved(approvals, version, selectedId)
    : false;
  const approvedAt = screenApproved
    ? approvals?.find(
        (item) => item.version === version && item.screenId === selectedId,
      )?.approvedAt
    : undefined;

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

  // Approves every size still to review, one request per size.
  const approveAllSizes = useCallback(async () => {
    if (!approvals) return;
    const previous = approvals;
    const request = ++approvalRequest.current;
    const pending = sizes.filter(
      (size) => !isApproved(previous, size.version, selectedId),
    );
    if (pending.length === 0) return;
    const approvedAt = new Date().toISOString();
    setApprovals([
      ...previous,
      ...pending.map((size) => ({
        version: size.version,
        screenId: selectedId,
        approvedAt,
      })),
    ]);
    try {
      let saved = previous;
      for (const size of pending) {
        saved = await putApproval(project.id, {
          version: size.version,
          screenId: selectedId,
          approved: true,
        });
      }
      if (request === approvalRequest.current) {
        setApprovals(saved);
        clearNotice("approval-save");
      }
    } catch (error) {
      if (request !== approvalRequest.current) return;
      // Some sizes may have saved; reload rather than guess.
      setApprovals(previous);
      fetchApprovals(project.id).then(
        (list) => {
          if (request === approvalRequest.current) setApprovals(list);
        },
        () => undefined,
      );
      setNotice({
        kind: "approval-save",
        text: `Approval was not saved: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
    }
  }, [approvals, clearNotice, project.id, selectedId, sizes]);

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

  const stepScreen = useCallback(
    (delta: number) => {
      const next = railIndex < 0 ? undefined : railItems[railIndex + delta];
      if (next) selectScreen(next.id);
    },
    [railIndex, railItems, selectScreen],
  );

  // Compare sizes replaces the capture; it opens on the size you were on.
  const [comparingSizes, setComparingSizes] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("fit");
  useEffect(() => {
    if (!sizing.multiple) setComparingSizes(false);
  }, [sizing.multiple]);

  const startPin = useCallback(() => {
    if (!ready) return;
    setComparingSizes(false);
    // Pins belong to this build, so adding one leaves the Before view.
    setShowBefore(false);
    setAddingFeedback(true);
    setDraftPin(null);
    setSelectedFeedbackId(null);
  }, [ready]);

  const switchProject = useCallback((id: string) => {
    setProjectId(id);
    setVersionChoice("");
    setRevisionChoice("");
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
      { active: summaryOpen, run: () => {}, block: true, whileTyping: true },
      { active: moreOpen, run: () => setMoreOpen(false), whileTyping: true },
      {
        active: addingFeedback && !draftPin,
        run: () => setAddingFeedback(false),
        whileTyping: true,
      },
      { active: phone && sheetOpen, run: () => setSheetOpen(false) },
      {
        active: comparingSizes,
        run: () => setComparingSizes(false),
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
    stepSize: sizing.multiple && !comparingSizes ? sizing.step : undefined,
    beforeAfter: beforeVersion
      ? () => setShowBefore((value) => !value)
      : undefined,
  });

  const navigation = (
    <ScreenRail
      mode={fullscreen ? fullscreenRailMode : railMode}
      onModeChange={fullscreen ? setFullscreenRailMode : setRailMode}
      approvedIds={rollup.approvedIds}
      partialApprovals={rollup.partialApprovals}
      hideApproved={hideApproved}
      onHideApprovedChange={changeHideApproved}
      onSelect={selectScreen}
      openCounts={rollup.openCounts}
      screens={screens}
      selectedId={selectedId}
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
      onAddFeedback={startPin}
      onSelectScreen={selectScreen}
      onUpdate={updateFeedback}
      onDelete={deleteFeedback}
      onVisibleFeedbackChange={setVisibleFeedback}
      hiddenPinStatuses={hiddenPinStatuses}
      onTogglePinStatus={togglePinStatus}
      approval={{
        approved: screenApproved,
        ready: approvals !== null,
        onToggle: toggleApproval,
        ...(sizing.multiple
          ? {
              sizeLabel: sizing.current?.label,
              sizes: sizes.map((size) => ({
                label: size.label,
                approved: (approvals ?? []).some(
                  (item) =>
                    item.version === size.version &&
                    item.screenId === selectedId,
                ),
                unverifiedFixes: feedbackRecords.filter(
                  (item) =>
                    item.screenId === selectedId &&
                    item.version === size.version &&
                    item.status === "RESOLVED",
                ).length,
              })),
              onApproveAll: () => void approveAllSizes(),
            }
          : {}),
      }}
      key={project.id}
      projectId={project.id}
      screens={screens}
      selectedFeedbackId={selectedFeedbackId}
      selectedScreenId={selectedId}
      version={version}
    />
  );
  const nextPinNumber =
    feedbackRecords.filter(
      (item) => item.screenId === selected.id && item.version === version,
    ).length + 1;
  const captureKey = `${project.id}/${shownVersion}/${selected.id}`;
  // Until the capture loads, a width-shaped size label is the best guess.
  const frameSize =
    captureSize?.key === captureKey
      ? captureSize
      : {
          width: sizing.current?.width ?? selected.viewport.width,
          height: selected.viewport.height,
        };
  const canvas = (
    <section
      className="review-canvas"
      data-adding-feedback={addingFeedback}
      data-zoom={zoom}
      data-testid="canvas"
      id="review-capture"
      tabIndex={-1}
      style={{ "--screen-width": `${frameSize.width}px` } as CSSProperties}
    >
      <header className="canvas-header">
        <div>
          <span className="eyebrow">
            {String(selected.ordinal).padStart(2, "0")} / {screens.length} ·{" "}
            {sizing.multiple ? `${labelOf(version)} · ` : ""}
            {selected.group}
          </span>
          <div className="canvas-title">
            <h2>{selected.title}</h2>
            {screenApproved ? (
              <span className="canvas-approved">
                Approved
                {approvedAt
                  ? ` · ${new Date(approvedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                  : ""}
              </span>
            ) : null}
          </div>
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
      <CanvasToolbar
        onCompare={() => {
          setShowBefore(false);
          setAddingFeedback(false);
          setDraftPin(null);
          setComparingSizes((open) => !open);
        }}
        comparing={comparingSizes}
        onSize={chooseSize}
        onZoom={setZoom}
        sizes={sizes}
        version={version}
        zoom={zoom}
      />
      {comparingSizes ? (
        <CompareSizes
          captureSrc={(item) =>
            selected.hasCapture
              ? captureSrc(project.id, item, selected.id)
              : undefined
          }
          fallbackHeight={selected.viewport.height}
          onPick={(item) => {
            chooseSize(item);
            setComparingSizes(false);
          }}
          pinNumbers={pinNumbers}
          pinsFor={(item) =>
            feedbackRecords.filter(
              (record) =>
                record.screenId === selectedId &&
                record.version === item &&
                !hiddenPinStatuses.includes(record.status),
            )
          }
          sizes={sizes}
          title={selected.title}
          version={version}
        />
      ) : null}
      {placingPin ? (
        <p className="canvas-adding-hint" role="status">
          Click the screen to place pin {nextPinNumber}, or use the arrow keys
          and Enter · Esc to cancel
        </p>
      ) : null}
      <div className="screen-scroll" hidden={comparingSizes}>
        <div
          className="screen-frame"
          data-testid="screen-frame"
          {...pinDrag.handlers}
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
              src={captureSrc(project.id, shownVersion, selected.id)}
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
          {comparing ? (
            <span className="before-badge">
              Before · {revisionName(revisionOf(beforeVersion))}
            </span>
          ) : null}
          <div className="feedback-pin-layer" aria-label="Screen feedback pins">
            {visibleFeedback
              .filter(
                (item) =>
                  !comparing &&
                  item.screenId === selectedId &&
                  item.version === version &&
                  (!hiddenPinStatuses.includes(item.status) ||
                    item.id === selectedFeedbackId),
              )
              .map((item) => [
                pinBoxOf(item) ? (
                  <PinBoxOutline
                    box={pinBoxOf(item)!}
                    className={pinBoxClassName(
                      item.status,
                      item.id === selectedFeedbackId,
                    )}
                    key={`${item.id}-box`}
                    testId="feedback-box"
                  />
                ) : null,
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
                  style={{
                    left: `${pinAnchor(item).x * 100}%`,
                    top: `${pinAnchor(item).y * 100}%`,
                  }}
                  type="button"
                >
                  {pinNumbers.get(item.id) ?? 0}
                </button>,
              ])}
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
            {pinDrag.preview ? (
              <PinBoxOutline
                box={pinDrag.preview}
                className="is-draft"
                testId="pin-box-preview"
              />
            ) : null}
            {draftPin?.box ? (
              <PinBoxOutline
                box={draftPin.box}
                className="is-draft"
                testId="draft-box"
              />
            ) : null}
            {draftPin ? (
              <span
                className="feedback-pin pin-dot feedback-pin-draft"
                data-testid="draft-pin"
                style={{
                  left: `${pinAnchor(draftPin).x * 100}%`,
                  top: `${pinAnchor(draftPin).y * 100}%`,
                }}
              >
                +
              </span>
            ) : null}
          </div>
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
          <span aria-hidden="true">‹</span>
          <span className="action-bar-nav-label">Prev</span>
        </button>
        <div className="action-bar-middle">
          <span
            aria-label={`Screen ${selected.ordinal} of ${screens.length}${sizing.multiple && sizing.current ? ` at ${sizing.current.label}` : ""}`}
            aria-live="polite"
            className="action-bar-place"
          >
            <strong>
              {selected.ordinal}/{screens.length}
            </strong>
          </span>
          {beforeVersion && !placingPin ? (
            <div
              aria-label="Compare with the previous build"
              className="before-after"
              role="group"
            >
              {(["Before", "After"] as const).map((side) => (
                <button
                  aria-keyshortcuts={SHORTCUTS.beforeAfter.aria}
                  aria-pressed={(side === "Before") === comparing}
                  key={side}
                  onClick={() => setShowBefore(side === "Before")}
                  title={`${side === "Before" ? `Show ${revisionName(revisionOf(beforeVersion))}` : `Show ${revisionName(revision)}`} (${SHORTCUTS.beforeAfter.label})`}
                  type="button"
                >
                  {side}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          aria-label="Next screen"
          disabled={railIndex < 0 || railIndex >= railItems.length - 1}
          onClick={() => stepScreen(1)}
          aria-keyshortcuts={SHORTCUTS.next.aria}
          title={`Next screen (${SHORTCUTS.next.label})`}
          type="button"
        >
          <span className="action-bar-nav-label">Next</span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div className="action-bar-end">
        {fullscreen ? null : (
          <button
            aria-controls="feedback-panel"
            aria-expanded={sheetOpen}
            className="action-bar-sheet"
            onClick={() => setSheetOpen((open) => !open)}
            type="button"
          >
            Feedback
            {openCounts.get(selectedId) ? (
              <span className="action-bar-sheet-count">
                {openCounts.get(selectedId)}
              </span>
            ) : null}
          </button>
        )}
        <div className="action-bar-more-wrap" ref={moreRef}>
          <button
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            aria-label="More actions"
            className="icon-button action-bar-more"
            onClick={() => setMoreOpen((open) => !open)}
            type="button"
          >
            <svg aria-hidden="true" height="18" viewBox="0 0 18 18" width="18">
              <path
                d="M3.5 9h.01M9 9h.01M14.5 9h.01"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="3"
              />
            </svg>
          </button>
          {moreOpen ? (
            <div
              aria-label="More actions"
              className="action-bar-menu"
              role="menu"
            >
              <button
                disabled={!ready}
                onClick={() => {
                  setMoreOpen(false);
                  setExportOpen(true);
                }}
                role="menuitem"
                type="button"
              >
                Export…
              </button>
              <button
                onClick={() => {
                  setMoreOpen(false);
                  setFullscreen((value) => !value);
                }}
                role="menuitem"
                type="button"
              >
                {fullscreen ? "Exit fullscreen" : "View fullscreen"}
              </button>
              <ReviewerNameMenuItem onDone={() => setMoreOpen(false)} />
              <SummariseRoundMenuItem
                onOpen={() => {
                  setMoreOpen(false);
                  setSummaryOpen(true);
                }}
              />
              {beforeVersion ? (
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setShowBefore((value) => !value);
                  }}
                  role="menuitem"
                  type="button"
                >
                  {comparing
                    ? `After · ${revisionName(revision)}`
                    : `Before · ${revisionName(revisionOf(beforeVersion))}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <button
          aria-haspopup="dialog"
          className="action-bar-export"
          disabled={!ready}
          onClick={() => setExportOpen(true)}
          type="button"
        >
          Export
        </button>
        <SummariseRoundButton
          disabled={!ready}
          onOpen={() => setSummaryOpen(true)}
        />
        <button
          aria-keyshortcuts={SHORTCUTS.addFeedback.aria}
          aria-pressed={addingFeedback}
          aria-label="Add feedback"
          className="feedback-add-button"
          disabled={!ready}
          onClick={startPin}
          title={`Add feedback (${SHORTCUTS.addFeedback.label})`}
          type="button"
        >
          <span className="feedback-add-label">Add feedback</span>{" "}
          <kbd aria-hidden="true">{SHORTCUTS.addFeedback.kbd}</kbd>
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
      {summaryOpen ? (
        <RoundSummaryDialog
          onClose={() => setSummaryOpen(false)}
          projectId={project.id}
          version={version}
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
          openCount={openCounts.get(selectedId) ?? 0}
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
        <div className="workbench-brand">
          <h1>ScreenCheck</h1>
          <span className="eyebrow">Design review</span>
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
            <span className="header-project">
              <span className="header-label">Project</span>
              <strong title={project.name}>{project.name}</strong>
            </span>
          )}
          {revisions.length > 1 ? (
            <label>
              Revision
              <select
                onChange={(event) => {
                  const next = event.target.value;
                  setNewerDismissed(true);
                  setRevisionChoice(next);
                  setVersionChoice(sameSizeIn(next));
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
          {!sizing.multiple ? (
            <span className="status-pill">{version}</span>
          ) : revisions.length <= 1 ? (
            <span className="status-pill">{revisionName(revision)}</span>
          ) : null}
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
              setVersionChoice(sameSizeIn(newestRevision));
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
        data-sheet-open={sheetOpen}
        aria-label="Review workspace"
        ref={gridRef}
      >
        <div className="rail-column">{navigation}</div>
        {canvas}
        <div className="feedback-column">
          <div className="feedback-sheet-bar">
            <button
              aria-label="Close feedback"
              className="feedback-sheet-close"
              onClick={() => setSheetOpen(false)}
              type="button"
            >
              Close
            </button>
          </div>
          <div className="feedback-follow" ref={panelRef}>
            {feedback}
          </div>
        </div>
      </section>
      {actionBar}
    </main>
  );
}

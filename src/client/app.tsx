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
import { FullscreenReview } from "./components/fullscreen-review";
import { ScreenCaption } from "./components/screen-caption";
import { ScreenRail, type RailMode } from "./components/screen-rail";
import { isApproved, type ScreenApproval } from "../shared/approvals";
import { captionFor, type ScreenCaption as Caption } from "../shared/captions";
import { createPinNumbers } from "../shared/export";
import {
  FEEDBACK_STATUSES,
  isOpenFeedback,
  normalizePinCoordinates,
  type CreateFeedbackInput,
  type FeedbackRecord,
  type FeedbackStatus,
  type UpdateFeedbackInput,
} from "../shared/feedback";
import {
  captureUrl,
  type PublicProject,
  type PublicScreen,
} from "../shared/projects";
import {
  FeedbackApiError,
  fetchApprovals,
  fetchCaptions,
  fetchFeedback,
  fetchProjects,
  migrateLegacyFeedback,
  patchFeedback,
  postFeedback,
  putApproval,
  putCaption,
  removeFeedback,
} from "./feedback-api";

// Shown only when the server cannot list projects, so feedback still works.
const FALLBACK_PROJECT: PublicProject = {
  id: "example",
  name: "Example project",
  versions: ["live"],
  screens: [
    {
      id: "landing",
      ordinal: 1,
      title: "Public landing",
      group: "Access",
      viewport: { width: 1440, height: 1000 },
      hasCapture: false,
    },
    {
      id: "bootstrap",
      ordinal: 2,
      title: "Session bootstrap",
      group: "Access",
      viewport: { width: 1440, height: 1000 },
      hasCapture: false,
    },
    {
      id: "dashboard",
      ordinal: 3,
      title: "Populated dashboard",
      group: "Portfolio",
      viewport: { width: 1440, height: 1000 },
      hasCapture: false,
    },
  ],
};

type Place = { project?: string; version?: string; screen?: string };

function readPlace(): Place {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return {
    project: params.get("project") ?? undefined,
    version: params.get("version") ?? undefined,
    screen: params.get("screen") ?? undefined,
  };
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

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
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

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
  const [railMode, setRailMode] = useState<RailMode>("wide");
  const initialPlace = useMemo(readPlace, []);
  const [projects, setProjects] = useState<PublicProject[] | null>(null);
  const [projectProblems, setProjectProblems] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(initialPlace.project ?? "");
  const [versionChoice, setVersionChoice] = useState(
    initialPlace.version ?? "",
  );
  const [selectedChoice, setSelectedId] = useState(initialPlace.screen ?? "");
  // "all" lists every resolution in the rail; a version narrows it to one.
  const [resolutionChoice, setResolutionChoice] = useState("all");
  const project =
    projects?.find((item) => item.id === projectId) ??
    projects?.[0] ??
    FALLBACK_PROJECT;
  const screens: PublicScreen[] = project.screens;
  const resolution = project.versions.includes(resolutionChoice)
    ? resolutionChoice
    : "all";
  const version =
    resolution !== "all"
      ? resolution
      : project.versions.includes(versionChoice)
        ? versionChoice
        : project.versions.at(-1)!;
  const selectedId = screens.some((item) => item.id === selectedChoice)
    ? selectedChoice
    : screens[0]!.id;
  const [fullscreen, setFullscreen] = useState(false);
  const [feedbackRecords, setFeedbackRecords] = useState<FeedbackRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
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
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(
    null,
  );
  const selected = screens.find((item) => item.id === selectedId)!;
  const selectedIndex = screens.indexOf(selected);
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
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(
          list.projects.length > 0 ? list.projects : [FALLBACK_PROJECT],
        );
        setProjectProblems(list.problems);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProjects([FALLBACK_PROJECT]);
        setProjectProblems([
          `Projects could not load (${error instanceof Error ? error.message : "unknown error"}); showing the example project.`,
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projects) return;
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
      if (place.version) setVersionChoice(place.version);
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
    if (!projects) return;
    let cancelled = false;
    setLoadState({ kind: "loading" });
    (async () => {
      try {
        const warning = await migrateLegacyFeedback(project.id);
        const records = await fetchFeedback(project.id);
        if (cancelled) return;
        setFeedbackRecords(records);
        setNotice(warning);
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
    if (!projects) return;
    let cancelled = false;
    setApprovals(null);
    fetchApprovals(project.id).then(
      (list) => {
        if (!cancelled) setApprovals(list);
      },
      (error: unknown) => {
        if (cancelled) return;
        setNotice(
          `Screen approvals could not load: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, projects, project.id]);

  useEffect(() => {
    if (!projects) return;
    let cancelled = false;
    setCaptions(null);
    fetchCaptions(project.id).then(
      (list) => {
        if (!cancelled) setCaptions(list);
      },
      (error: unknown) => {
        if (cancelled) return;
        setNotice(
          `Screen descriptions could not load: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, projects, project.id]);

  useEffect(() => {
    if (!addingFeedback || draftPin) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddingFeedback(false);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [addingFeedback, draftPin]);

  const upsertRecord = useCallback((record: FeedbackRecord) => {
    setFeedbackRecords((current) =>
      current.some((item) => item.id === record.id)
        ? current.map((item) => (item.id === record.id ? record : item))
        : [...current, record],
    );
  }, []);

  // Writes run one at a time. Each records the revision it replaced, so a
  // write queued behind this tab's own save is rebased onto that save instead
  // of failing; a change made elsewhere still surfaces as a 409 conflict.
  const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const ownRevisionsRef = useRef(new Map<string, string>());

  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    const run = mutationChainRef.current.catch(() => undefined).then(operation);
    mutationChainRef.current = run;
    return run;
  }, []);

  const latestOwnRevision = useCallback((id: string, expected: string) => {
    let revision = expected;
    while (ownRevisionsRef.current.has(`${id}@${revision}`)) {
      revision = ownRevisionsRef.current.get(`${id}@${revision}`)!;
    }
    return revision;
  }, []);

  const withConflictRefresh = useCallback(
    async <T,>(operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof FeedbackApiError && error.current) {
          upsertRecord(error.current);
        }
        throw error;
      }
    },
    [upsertRecord],
  );

  const createFeedback = useCallback(
    (input: CreateFeedbackInput) =>
      enqueue(async () => {
        const created = await postFeedback(project.id, input);
        upsertRecord(created);
        return created;
      }),
    [enqueue, project.id, upsertRecord],
  );

  const updateFeedback = useCallback(
    (id: string, input: UpdateFeedbackInput) =>
      enqueue(() =>
        withConflictRefresh(async () => {
          const expectedUpdatedAt = latestOwnRevision(
            id,
            input.expectedUpdatedAt,
          );
          const updated = await patchFeedback(project.id, id, {
            ...input,
            expectedUpdatedAt,
          });
          ownRevisionsRef.current.set(
            `${id}@${expectedUpdatedAt}`,
            updated.updatedAt,
          );
          upsertRecord(updated);
          return updated;
        }),
      ),
    [enqueue, latestOwnRevision, project.id, upsertRecord, withConflictRefresh],
  );

  const deleteFeedback = useCallback(
    (id: string, expectedUpdatedAt: string) =>
      enqueue(() =>
        withConflictRefresh(async () => {
          await removeFeedback(
            project.id,
            id,
            latestOwnRevision(id, expectedUpdatedAt),
          );
          setFeedbackRecords((current) =>
            current.filter((item) => item.id !== id),
          );
          setSelectedFeedbackId((current) => (current === id ? null : current));
        }),
      ),
    [enqueue, latestOwnRevision, project.id, withConflictRefresh],
  );

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
  // With several versions (viewport widths), the rail lists every screen at
  // every version so review is one scroll rather than a dropdown per screen.
  const flatItems = useMemo(() => {
    const label = (name: string) => /-(\d+)$/.exec(name)?.[1] ?? name;
    const width = (name: string) => Number(/-(\d+)$/.exec(name)?.[1] ?? NaN);
    const versions = [...project.versions]
      .filter((item) => resolution === "all" || item === resolution)
      .sort((a, b) => (width(a) || 0) - (width(b) || 0));
    let ordinal = 0;
    return screens.flatMap((screen) =>
      versions.map((item) => ({
        ...screen,
        id: `${screen.id}@@${item}`,
        screenId: screen.id,
        version: item,
        ordinal: ++ordinal,
        title: `${screen.title} · ${label(item)}`,
      })),
    );
  }, [project.versions, resolution, screens]);
  const flatMode = project.versions.length > 1;
  const flatIndex = flatItems.findIndex(
    (item) => item.screenId === selectedId && item.version === version,
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
        if (request === captionRequest.current) setCaptions(saved);
      } catch (error) {
        if (request !== captionRequest.current) return;
        setCaptions(previous);
        setNotice(
          `Description was not saved: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    },
    [captions, project.id, selectedId, version],
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
      if (request === approvalRequest.current) setApprovals(saved);
    } catch (error) {
      if (request !== approvalRequest.current) return;
      setApprovals(previous);
      setNotice(
        `Approval was not saved: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }, [approvals, project.id, selectedId, version]);

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
      if (flatMode) {
        const next = flatItems[flatIndex + delta];
        if (next) {
          setVersionChoice(next.version);
          selectScreen(next.screenId);
        }
        return;
      }
      const next = screens[selectedIndex + delta];
      if (next) selectScreen(next.id);
    },
    [flatMode, flatItems, flatIndex, screens, selectedIndex, selectScreen],
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
    setResolutionChoice("all");
    setSelectedId("");
    setFeedbackRecords([]);
    setAddingFeedback(false);
    setDraftPin(null);
    setSelectedFeedbackId(null);
  }, []);

  // ⌘F / Ctrl+F adds feedback instead of opening the browser's find bar;
  // ← and → (or [ and ]) step through screens when not typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest?.('[role="dialog"]'))
        return;
      if (
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        startPin();
        return;
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target)
      )
        return;
      if (event.key === "ArrowRight" || event.key === "]") {
        event.preventDefault();
        stepScreen(1);
      } else if (event.key === "ArrowLeft" || event.key === "[") {
        event.preventDefault();
        stepScreen(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startPin, stepScreen]);

  const navigation = (
    <ScreenRail
      mode={fullscreen ? "compact" : railMode}
      onModeChange={fullscreen ? undefined : setRailMode}
      approvedIds={flatMode ? flatApprovedIds : approvedIds}
      onSelect={(id) => {
        const item = flatMode
          ? flatItems.find((entry) => entry.id === id)
          : undefined;
        if (item) {
          setVersionChoice(item.version);
          selectScreen(item.screenId);
        } else {
          selectScreen(id);
        }
      }}
      openCounts={flatMode ? flatOpenCounts : openCounts}
      screens={flatMode ? flatItems : screens}
      selectedId={flatMode ? `${selectedId}@@${version}` : selectedId}
    />
  );
  const feedback = (
    <FeedbackInspector
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
          setDraftPin(
            normalizePinCoordinates(event.clientX, event.clientY, rect),
          );
          setSelectedFeedbackId(null);
        }}
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
                onClick={() => {
                  setSelectedFeedbackId(item.id);
                  document
                    .getElementById(`feedback-comment-${item.id}`)
                    ?.focus();
                }}
                style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }}
                type="button"
              >
                {pinNumbers.get(item.id) ?? 0}
              </button>
            ))}
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
          aria-keyshortcuts={fullscreen ? "Escape" : undefined}
          aria-label={fullscreen ? "Exit fullscreen" : "View fullscreen"}
          aria-pressed={fullscreen}
          className="icon-button action-bar-fullscreen"
          onClick={() => setFullscreen((value) => !value)}
          title={fullscreen ? "Exit fullscreen (Esc)" : "View fullscreen"}
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
        {addingFeedback && !draftPin ? (
          <p className="action-bar-hint" role="status">
            Click the screen to place a pin · Esc to cancel
          </p>
        ) : null}
      </div>
      <div className="action-bar-nav">
        <button
          aria-label="Previous screen"
          disabled={(flatMode ? flatIndex : selectedIndex) <= 0}
          onClick={() => stepScreen(-1)}
          title="Previous screen (←)"
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
          disabled={
            (flatMode ? flatIndex : selectedIndex) >=
            (flatMode ? flatItems.length : screens.length) - 1
          }
          onClick={() => stepScreen(1)}
          title="Next screen (→)"
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
          aria-keyshortcuts={isMac ? "Meta+F" : "Control+F"}
          aria-pressed={addingFeedback}
          className="feedback-add-button"
          disabled={!ready}
          onClick={startPin}
          title={`Add feedback (${isMac ? "⌘F" : "Ctrl+F"})`}
          type="button"
        >
          Add feedback <kbd aria-hidden="true">{isMac ? "⌘F" : "Ctrl F"}</kbd>
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
        />
      ) : null}
    </footer>
  );

  if (fullscreen) {
    return (
      <>
        <FullscreenReview
          feedback={feedback}
          navigation={navigation}
          onExit={() => setFullscreen(false)}
        >
          {canvas}
        </FullscreenReview>
        {actionBar}
      </>
    );
  }

  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div>
          <span className="eyebrow">Design review</span>
          <h1>ScreenCheck</h1>
        </div>
        <div className="header-controls">
          {projects && projects.length > 1 ? (
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
          {project.versions.length > 1 ? (
            <label>
              Resolution
              <select
                onChange={(event) => {
                  const next = event.target.value;
                  setResolutionChoice(next);
                  if (next !== "all") setVersionChoice(next);
                }}
                value={resolution}
              >
                <option value="all">All</option>
                {project.versions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="status-pill">{version}</span>
          )}
        </div>
      </header>
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
        <p className="workbench-banner workbench-banner-error" role="alert">
          {notice}
        </p>
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

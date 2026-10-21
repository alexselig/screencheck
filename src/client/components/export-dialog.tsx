import { useEffect, useId, useRef, useState } from "react";
import type { ElementMap } from "../../shared/elements";
import { serializeJson, serializeMarkdown } from "../../shared/export";
import {
  FEEDBACK_STATUSES,
  STATUS_LABELS,
  type FeedbackRecord,
  type FeedbackStatus,
} from "../../shared/feedback";
import type { ReviewScreen } from "../../shared/manifest";
import { fetchElementMaps } from "../element-map-api";

export type ExportFormat = "json" | "markdown";

function download(contents: string, fileName: string, type: string) {
  if (!URL.createObjectURL) return;
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ExportDialog({
  feedback,
  onClose,
  onExport,
  projectId,
  screens,
  selectedScreenId,
  version,
  versions = [{ id: version, label: version }],
}: {
  feedback: FeedbackRecord[];
  onClose: () => void;
  onExport?: (format: ExportFormat, contents: string) => void;
  projectId: string;
  screens: ReviewScreen[];
  selectedScreenId: string;
  version: string;
  // The versions the rail lists; the dialog defaults to all of them.
  versions?: { id: string; label: string }[];
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [scope, setScope] = useState<"all" | "screen">("all");
  const [versionScope, setVersionScope] = useState<"listed" | "current">(
    "listed",
  );
  const listed = versions.some((item) => item.id === version)
    ? versions
    : [...versions, { id: version, label: version }];
  const included =
    versionScope === "listed"
      ? listed
      : listed.filter((item) => item.id === version);
  const includedIds = included.map((item) => item.id);
  const currentLabel =
    listed.find((item) => item.id === version)?.label ?? version;
  const [statuses, setStatuses] = useState<FeedbackStatus[]>([
    ...FEEDBACK_STATUSES,
  ]);

  const screen = screens.find((item) => item.id === selectedScreenId);
  // Pin numbers come from every comment in the version, so a partial export
  // still matches the numbers on screen.
  const versionFeedback = feedback.filter((item) =>
    includedIds.includes(item.version),
  );
  const records = versionFeedback.filter(
    (item) =>
      statuses.includes(item.status) &&
      (scope === "all" || item.screenId === selectedScreenId),
  );
  const allStatuses = statuses.length === FEEDBACK_STATUSES.length;
  const scopeText = [
    scope === "all"
      ? `All ${screens.length} screens`
      : `Screen ${String(screen?.ordinal ?? 0).padStart(2, "0")} ${screen?.title ?? ""}`.trim(),
    included.length === 1
      ? `version ${included[0]!.label}`
      : `versions ${included.map((item) => item.label).join(", ")}`,
    allStatuses
      ? null
      : `${statuses.map((status) => STATUS_LABELS[status]).join(", ") || "no statuses"}`,
    `${records.length} item${records.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  // Element maps let each comment name what its pin points at; screens
  // without one are simply left out.
  const [elements, setElements] = useState<Record<string, ElementMap>>({});
  const pairsKey = [
    ...new Set(
      versionFeedback.map((item) => `${item.version}\0${item.screenId}`),
    ),
  ].join("\n");
  useEffect(() => {
    let live = true;
    const byVersion = new Map<string, string[]>();
    for (const pair of pairsKey ? pairsKey.split("\n") : []) {
      const [itemVersion, screenId] = pair.split("\0") as [string, string];
      byVersion.set(itemVersion, [
        ...(byVersion.get(itemVersion) ?? []),
        screenId,
      ]);
    }
    void Promise.all(
      [...byVersion].map(([itemVersion, screenIds]) =>
        fetchElementMaps(projectId, itemVersion, screenIds),
      ),
    ).then((list) => {
      const maps = Object.assign({}, ...list) as Record<string, ElementMap>;
      if (live && Object.keys(maps).length) setElements(maps);
    });
    return () => {
      live = false;
    };
  }, [projectId, pairsKey]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("input:checked, button")
      ?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "input:not(:disabled), button:not(:disabled)",
      ) ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function toggleStatus(status: FeedbackStatus) {
    setStatuses((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : FEEDBACK_STATUSES.filter(
            (item) => item === status || current.includes(item),
          ),
    );
  }

  function submit() {
    const input = {
      projectId,
      screens,
      feedback: records,
      allFeedback: versionFeedback,
      scope: scopeText,
      elements,
      versions: included,
    };
    const contents =
      format === "json" ? serializeJson(input) : serializeMarkdown(input);
    if (onExport) onExport(format, contents);
    else
      download(
        contents,
        `${projectId}-feedback.${format === "json" ? "json" : "md"}`,
        format === "json" ? "application/json" : "text/markdown",
      );
    onClose();
  }

  return (
    <div
      className="export-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="export-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={titleId}>Export feedback</h2>
        <fieldset>
          <legend>Format</legend>
          <label>
            <input
              checked={format === "markdown"}
              name="export-format"
              onChange={() => setFormat("markdown")}
              type="radio"
            />
            Markdown
          </label>
          <label>
            <input
              checked={format === "json"}
              name="export-format"
              onChange={() => setFormat("json")}
              type="radio"
            />
            JSON
          </label>
        </fieldset>
        <fieldset>
          <legend>Screens</legend>
          <label>
            <input
              checked={scope === "all"}
              name="export-scope"
              onChange={() => setScope("all")}
              type="radio"
            />
            All {screens.length} screens
          </label>
          <label>
            <input
              checked={scope === "screen"}
              name="export-scope"
              onChange={() => setScope("screen")}
              type="radio"
            />
            This screen only
          </label>
        </fieldset>
        {listed.length > 1 ? (
          <fieldset>
            <legend>Version</legend>
            <label>
              <input
                checked={versionScope === "listed"}
                name="export-version"
                onChange={() => setVersionScope("listed")}
                type="radio"
              />
              All {listed.length} versions in the list
            </label>
            <label>
              <input
                checked={versionScope === "current"}
                name="export-version"
                onChange={() => setVersionScope("current")}
                type="radio"
              />
              This version only ({currentLabel})
            </label>
          </fieldset>
        ) : null}
        <fieldset>
          <legend>Include</legend>
          {FEEDBACK_STATUSES.map((status) => (
            <label key={status}>
              <input
                checked={statuses.includes(status)}
                onChange={() => toggleStatus(status)}
                type="checkbox"
              />
              {STATUS_LABELS[status]}
            </label>
          ))}
        </fieldset>
        <p aria-live="polite" className="export-summary">
          {scopeText}
        </p>
        <div className="export-dialog-actions">
          <button onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="export-download"
            disabled={records.length === 0}
            onClick={submit}
            type="button"
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";

import {
  elementLabel,
  formatElementSource,
  resolvePinElement,
  type ElementMap,
} from "../../shared/elements";
import { fetchElementMap } from "../element-map-api";

// "↳ button "Continue to vehicle" · Footer.tsx:42" under a comment's note,
// when the screen's capture has an element map.
export function ElementLine({
  projectId,
  pin,
}: {
  projectId: string;
  pin: {
    version: string;
    screenId: string;
    x: number;
    y: number;
    box?: unknown;
  };
}) {
  const { version, screenId } = pin;
  const [loaded, setLoaded] = useState<{
    key: string;
    map: ElementMap;
  } | null>(null);
  const key = `${projectId}\0${version}\0${screenId}`;

  useEffect(() => {
    let live = true;
    void fetchElementMap(projectId, version, screenId).then((map) => {
      if (live && map) setLoaded({ key, map });
    });
    return () => {
      live = false;
    };
  }, [key, projectId, version, screenId]);

  const element =
    loaded?.key === key ? resolvePinElement(loaded.map, pin) : null;
  // A bare `main` or `div` says nothing a reviewer can act on.
  if (!element || !(element.name || element.testId || element.source)) {
    return null;
  }
  // Compact for the narrow panel: the test id stands in for a missing name.
  const label =
    element.name || !element.testId
      ? elementLabel(element)
      : `${element.role ?? element.tag} ${element.testId}`;
  const source = formatElementSource(element.source, { short: true });
  return (
    <span
      className="feedback-element"
      data-testid="feedback-element"
      title={element.selector}
    >
      <span aria-hidden="true">↳ </span>
      <span className="feedback-element-label">{label}</span>
      {source ? (
        <span className="feedback-element-source"> · {source}</span>
      ) : null}
    </span>
  );
}

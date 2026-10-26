import { useCallback, useMemo } from "react";

import { sizesOf } from "./sizes";

// The sizes of the current revision and stepping between them. The chosen
// size is the version itself, so it carries across screens and into the URL.
export function useSizes({
  revisionVersions,
  labelOf,
  viewportOf,
  version,
  onChange,
}: {
  revisionVersions: readonly string[];
  labelOf: (version: string) => string;
  viewportOf?: (version: string) => number | undefined;
  version: string;
  onChange: (version: string) => void;
}) {
  const sizes = useMemo(
    () => sizesOf(revisionVersions, labelOf, viewportOf),
    [revisionVersions, labelOf, viewportOf],
  );
  const index = sizes.findIndex((size) => size.version === version);
  const current = sizes[index];
  const step = useCallback(
    (delta: 1 | -1) => {
      const next = sizes[index + delta];
      if (index >= 0 && next) onChange(next.version);
    },
    [sizes, index, onChange],
  );
  return { sizes, current, multiple: sizes.length > 1, step };
}

// A version's registered `viewport` width, when the registration has one.
export function viewportLookup(
  details: readonly { id: string; viewport?: unknown }[] | undefined,
) {
  const widths = new Map<string, number>();
  for (const item of details ?? []) {
    if (typeof item.viewport === "number") widths.set(item.id, item.viewport);
  }
  return (version: string) => widths.get(version);
}

import { useCallback, useMemo } from "react";

import { sizesOf } from "./sizes";

// The sizes of the current revision and stepping between them. The chosen
// size is the version itself, so it carries across screens and into the URL.
export function useSizes({
  revisionVersions,
  labelOf,
  version,
  onChange,
}: {
  revisionVersions: readonly string[];
  labelOf: (version: string) => string;
  version: string;
  onChange: (version: string) => void;
}) {
  const sizes = useMemo(
    () => sizesOf(revisionVersions, labelOf),
    [revisionVersions, labelOf],
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

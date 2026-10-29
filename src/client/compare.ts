import type { versionModel } from "./versions";

type Versions = Pick<
  ReturnType<typeof versionModel>,
  "revisions" | "versionsOf" | "previousVersion"
>;

// The newest capture of the same size as `version`, when the screen changed
// somewhere between the two builds; otherwise undefined. `changed` lists the
// versions whose capture differs from one build back (from /api/projects).
export function newerCapture(
  versions: Versions,
  changed: readonly string[] | undefined,
  version: string,
) {
  if (!changed?.length) return undefined;
  for (const revision of [...versions.revisions].reverse()) {
    for (const candidate of versions.versionsOf(revision)) {
      if (candidate === version) return undefined;
      let differs = false;
      for (
        let step: string | undefined = candidate;
        step;
        step = versions.previousVersion(step)
      ) {
        if (step === version) {
          if (differs) return candidate;
          break;
        }
        if (changed.includes(step)) differs = true;
      }
    }
  }
  return undefined;
}

export type CropFrame = {
  // Share of the capture's width the crop shows, and where it starts.
  width: number;
  left: number;
  // The capture height fraction kept in the middle of the crop.
  centerY: number;
};

const POINT_WIDTH = 0.4;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Where a before/after crop looks: around the pin, or the whole box with a
// margin, kept inside the capture's width.
export function cropFrame(pin: {
  x: number;
  y: number;
  box?: { x: number; y: number; w: number; h: number };
}): CropFrame {
  const width = pin.box ? clamp(pin.box.w * 1.2, POINT_WIDTH, 1) : POINT_WIDTH;
  const centerX = pin.box ? pin.box.x + pin.box.w / 2 : pin.x;
  const centerY = pin.box ? pin.box.y + pin.box.h / 2 : pin.y;
  return {
    width,
    left: clamp(centerX - width / 2, 0, 1 - width),
    centerY,
  };
}

// Screens whose capture at `version` differs from one build back.
export function changedScreenIds(
  screens: readonly { id: string; changed?: string[] }[],
  version: string,
) {
  return new Set(
    screens
      .filter((screen) => screen.changed?.includes(version))
      .map((screen) => screen.id),
  );
}

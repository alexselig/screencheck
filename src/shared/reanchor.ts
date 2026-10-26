import { z } from "zod";

import {
  resolvePinElement,
  type ElementMap,
  type MappedElement,
} from "./elements";
import { pinBoxOf, pinFromBox, type PinBox } from "./pin-box";

// Moving a pin from one capture to another: the next build of the same size
// (carry forward) or another size of the same build (all-sizes comments).
// The pin keeps its place relative to the element it was put on, found again
// in the target's element map; without a map or a match it keeps its %
// position. Pure, shared by the server's carry step and the client.

const fraction = z.number().finite().min(0).max(1);

// What a pin was put on, recorded with the comment so it can be found again
// even when the original capture's element map is gone.
export const pinElementSchema = z.object({
  selector: z.string().min(1),
  tag: z.string().min(1),
  role: z.string().min(1).optional(),
  name: z.string().optional(),
  testId: z.string().min(1).optional(),
  box: z.object({ x: fraction, y: fraction, w: fraction, h: fraction }),
  // The capture's size in pixels, so "moved" is judged in pixels.
  capture: z
    .object({
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .optional(),
});

export type PinElement = z.infer<typeof pinElementSchema>;

// matched: found by identity, roughly where it was. moved: found, but it
// moved or resized. fallback: no map or no match, so the % position is kept.
export const PLACEMENTS = ["matched", "moved", "fallback"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type Reanchored = {
  x: number;
  y: number;
  box?: PinBox;
  placement: Placement;
  element?: PinElement;
};

type Box = { x: number; y: number; w: number; h: number };
type Pin = { x: number; y: number; box?: unknown };
type MapLike = Pick<ElementMap, "elements"> &
  Partial<Pick<ElementMap, "capture">>;

// Pixels of movement (or 20% of resize) before a match counts as moved.
export const MOVED_PIXELS = 24;
const MOVED_FRACTION = 0.02;
const RESIZE_RATIO = 1.2;

const round = (value: number) => Number(value.toFixed(6));
const clampUnit = (value: number) => Math.min(Math.max(value, 0), 1);

// A record's stored element, if it carries a valid one. Records are loose,
// so a foreign shape is ignored rather than trusted.
export function pinElementOf(record: object): PinElement | undefined {
  const parsed = pinElementSchema.safeParse(
    (record as { element?: unknown }).element,
  );
  return parsed.success ? parsed.data : undefined;
}

export function toPinElement(
  element: MappedElement,
  capture?: ElementMap["capture"],
): PinElement {
  return {
    selector: element.selector,
    tag: element.tag,
    ...(element.role ? { role: element.role } : {}),
    ...(element.name ? { name: element.name } : {}),
    ...(element.testId ? { testId: element.testId } : {}),
    box: element.box,
    ...(capture ? { capture } : {}),
  };
}

// The element a pin sits on: the one recorded with it, else the one under
// it in its own capture's map.
export function sourceElement(
  record: Pin,
  sourceMap: MapLike | null | undefined,
): PinElement | undefined {
  const stored = pinElementOf(record);
  if (stored) return stored;
  const found = resolvePinElement(sourceMap, record);
  return found ? toPinElement(found, sourceMap?.capture) : undefined;
}

const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

// The same element in another map: by test id, then selector, then role,
// tag and accessible name. Several candidates: the nearest to where it was.
export function findElement(
  map: MapLike | null | undefined,
  from: PinElement,
): MappedElement | null {
  const elements = map?.elements ?? [];
  const tiers: ((element: MappedElement) => boolean)[] = [
    (element) => Boolean(from.testId) && element.testId === from.testId,
    (element) => element.selector === from.selector,
    (element) =>
      Boolean(from.name) &&
      element.name === from.name &&
      element.tag === from.tag &&
      (element.role ?? "") === (from.role ?? ""),
  ];
  const at = centre(from.box);
  for (const tier of tiers) {
    const candidates = elements.filter(tier);
    if (candidates.length === 0) continue;
    return candidates.reduce((best, element) => {
      const distance = (box: Box) =>
        Math.hypot(centre(box).x - at.x, centre(box).y - at.y);
      return distance(element.box) < distance(best.box) ? element : best;
    });
  }
  return null;
}

function movedBetween(
  from: PinElement,
  to: MappedElement,
  target?: ElementMap["capture"],
) {
  const a = centre(from.box);
  const b = centre(to.box);
  if (from.capture && target) {
    const dx = b.x * target.width - a.x * from.capture.width;
    const dy = b.y * target.height - a.y * from.capture.height;
    if (Math.hypot(dx, dy) > MOVED_PIXELS) return true;
  } else if (
    Math.abs(b.x - a.x) > MOVED_FRACTION ||
    Math.abs(b.y - a.y) > MOVED_FRACTION
  ) {
    return true;
  }
  const ratio = (next: number, previous: number) =>
    previous > 0 && next > 0
      ? Math.max(next / previous, previous / next)
      : next === previous
        ? 1
        : Infinity;
  // Fractions of a taller capture are smaller for the same pixels.
  const scaleX = from.capture && target ? from.capture.width / target.width : 1;
  const scaleY =
    from.capture && target ? from.capture.height / target.height : 1;
  return (
    ratio(to.box.w, from.box.w * scaleX) > RESIZE_RATIO ||
    ratio(to.box.h, from.box.h * scaleY) > RESIZE_RATIO
  );
}

// A coordinate expressed relative to `from` and re-expressed in `to`.
function along(value: number, fromStart: number, fromSize: number) {
  return fromSize > 0 ? (value - fromStart) / fromSize : 0.5;
}

function fallback(pin: Pin): Reanchored {
  const box = pinBoxOf(pin);
  return {
    x: pin.x,
    y: pin.y,
    ...(box ? { box } : {}),
    placement: "fallback",
  };
}

export function reanchorPin(
  pin: Pin,
  from: PinElement | null | undefined,
  target: MapLike | null | undefined,
): Reanchored {
  if (!from || !target) return fallback(pin);
  const to = findElement(target, from);
  if (!to) return fallback(pin);
  const placement: Placement = movedBetween(from, to, target.capture)
    ? "moved"
    : "matched";
  const element = toPinElement(to, target.capture);
  const mapX = (value: number) =>
    to.box.x + along(value, from.box.x, from.box.w) * to.box.w;
  const mapY = (value: number) =>
    to.box.y + along(value, from.box.y, from.box.h) * to.box.h;
  const box = pinBoxOf(pin);
  if (box) {
    const x0 = clampUnit(mapX(box.x));
    const y0 = clampUnit(mapY(box.y));
    const x1 = clampUnit(mapX(box.x + box.w));
    const y1 = clampUnit(mapY(box.y + box.h));
    if (x1 - x0 > 0 && y1 - y0 > 0) {
      const next = {
        x: round(x0),
        y: round(y0),
        w: round(x1 - x0),
        h: round(y1 - y0),
      };
      return { ...pinFromBox(next), placement, element };
    }
    return { ...fallback(pin), placement: "fallback" };
  }
  return {
    x: round(clampUnit(mapX(pin.x))),
    y: round(clampUnit(mapY(pin.y))),
    placement,
    element,
  };
}

import { z } from "zod";

// Box and region pins. A box is a rectangle in fractions of the capture
// (0..1), the same units as a pin's x/y and an element map box. Pinpoint's
// `box: { x, y, width, height }` is the same rectangle in percent (×100).
//
// A box pin also keeps x/y, set to the box's centre, so every consumer that
// only knows points (old clients, crops, element lookups, exports) still
// lands inside the region.

// Pointer movement up to this many CSS pixels is still a click.
export const PIN_DRAG_THRESHOLD = 6;

// Boxes are rounded fractions, so edges get a hair of slack.
const EDGE = 1e-6;
const fraction = z.number().finite().min(0).max(1);

export const pinBoxSchema = z
  .object({
    x: fraction,
    y: fraction,
    w: fraction.positive(),
    h: fraction.positive(),
  })
  .refine((box) => box.x + box.w <= 1 + EDGE && box.y + box.h <= 1 + EDGE, {
    message: "A box must lie inside the capture.",
  });

export type PinBox = z.infer<typeof pinBoxSchema>;
export type BoxPin = { x: number; y: number; box?: PinBox };

type Point = { x: number; y: number };
type Frame = { left: number; top: number; width: number; height: number };

const round = (value: number) => Number(value.toFixed(6));
const clampUnit = (value: number) => Math.min(Math.max(value, 0), 1);

export function isPinDrag(start: Point, end: Point) {
  return Math.hypot(end.x - start.x, end.y - start.y) > PIN_DRAG_THRESHOLD;
}

// The box between two client points, clamped to the frame.
export function normalizePinBox(start: Point, end: Point, frame: Frame) {
  if (frame.width <= 0 || frame.height <= 0) {
    throw new Error("Feedback frame must have a positive size.");
  }
  const fx = (value: number) =>
    round(clampUnit((value - frame.left) / frame.width));
  const fy = (value: number) =>
    round(clampUnit((value - frame.top) / frame.height));
  const [x0, x1] = [fx(start.x), fx(end.x)].sort((a, b) => a - b) as [
    number,
    number,
  ];
  const [y0, y1] = [fy(start.y), fy(end.y)].sort((a, b) => a - b) as [
    number,
    number,
  ];
  return { x: x0, y: y0, w: round(x1 - x0), h: round(y1 - y0) };
}

export function pinFromBox(box: PinBox): Required<BoxPin> {
  return {
    x: round(box.x + box.w / 2),
    y: round(box.y + box.h / 2),
    box,
  };
}

// Where the numbered badge goes: the box's top-left, or the point itself.
export function pinAnchor(pin: Point & { box?: unknown }): Point {
  const box = pinBoxOf(pin);
  return box ? { x: box.x, y: box.y } : { x: pin.x, y: pin.y };
}

// `region 10%, 20%, 40% wide × 30% tall`
export function describePinBox(box: PinBox) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return `region ${percent(box.x)}, ${percent(box.y)}, ${percent(box.w)} wide × ${percent(box.h)} tall`;
}

// A stored box, if the record carries a valid one. Records are loose, so a
// hand-edited or foreign `box` is ignored rather than trusted.
export function pinBoxOf(record: object): PinBox | undefined {
  const parsed = pinBoxSchema.safeParse((record as { box?: unknown }).box);
  return parsed.success ? parsed.data : undefined;
}

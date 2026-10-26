import { z } from "zod";

import { pinBoxOf } from "./pin-box";

// The element map written beside a capture: what sat where on the page when
// it was captured, so a pin can name the element under it. Pure and shared by
// the capture helper, server, client and agents.

export const ELEMENT_NAME_MAX_LENGTH = 120;

const fraction = z.number().finite().min(0).max(1);

// Best effort: a file when the build exposes one, or at least a component.
export const elementSourceSchema = z
  .object({
    file: z.string().min(1).optional(),
    line: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
    component: z.string().min(1).optional(),
  })
  .refine((source) => source.file || source.component, {
    message: "A source needs a file or a component.",
  });

export const mappedElementSchema = z.object({
  // Fractions of the capture, like pin coordinates.
  box: z.object({ x: fraction, y: fraction, w: fraction, h: fraction }),
  role: z.string().min(1).optional(),
  name: z.string().max(ELEMENT_NAME_MAX_LENGTH).optional(),
  tag: z.string().min(1),
  testId: z.string().min(1).optional(),
  selector: z.string().min(1),
  source: elementSourceSchema.optional(),
});

export const elementMapSchema = z.object({
  version: z.literal(1),
  capture: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  url: z.string().optional(),
  // Document order.
  elements: z.array(mappedElementSchema),
});

export type ElementSource = z.infer<typeof elementSourceSchema>;
export type MappedElement = z.infer<typeof mappedElementSchema>;
export type ElementMap = z.infer<typeof elementMapSchema>;

// `shop/checkout.png` -> `shop/checkout.elements.json`.
export function elementMapPathFor(capturePath: string) {
  return `${capturePath.replace(/\.[^./\\]*$/, "")}.elements.json`;
}

// Key used for maps in exports and client caches.
export function elementMapKey(version: string, screenId: string) {
  return `${version}/${screenId}`;
}

// Boxes are rounded fractions, so edges get a hair of slack.
const EDGE = 1e-6;

type Box = { x: number; y: number; w: number; h: number };

function overlap(a: Box, b: Box) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// The element that best matches a drawn box: the highest intersection over
// union, so a box around a card names the card rather than the page around
// it or a button inside it. Later in document order wins a tie.
function resolveBoxElement(
  elements: readonly MappedElement[],
  box: Box,
): MappedElement | null {
  let best: MappedElement | null = null;
  let bestScore = 0;
  for (const element of elements) {
    const shared = overlap(element.box, box);
    if (shared <= 0) continue;
    const score =
      shared / (element.box.w * element.box.h + box.w * box.h - shared);
    if (score >= bestScore) {
      best = element;
      bestScore = score;
    }
  }
  return best;
}

// The innermost element under a pin: the smallest box containing the point,
// and on equal areas the one later in document order (usually the child).
// A box pin resolves to the element best covering its box instead.
export function resolvePinElement(
  map: Pick<ElementMap, "elements"> | null | undefined,
  point: { x: number; y: number; box?: unknown },
): MappedElement | null {
  const box = pinBoxOf(point);
  if (box) return resolveBoxElement(map?.elements ?? [], box);
  let best: MappedElement | null = null;
  let bestArea = Infinity;
  for (const element of map?.elements ?? []) {
    const { x, y, w, h } = element.box;
    if (
      point.x < x - EDGE ||
      point.x > x + w + EDGE ||
      point.y < y - EDGE ||
      point.y > y + h + EDGE
    ) {
      continue;
    }
    const area = w * h;
    if (area <= bestArea) {
      best = element;
      bestArea = area;
    }
  }
  return best;
}

// `src/booking/Footer.tsx:42` (or `Footer.tsx:42` when short); just the
// component name when the file is unknown.
export function formatElementSource(
  source: ElementSource | undefined,
  { short = false }: { short?: boolean } = {},
) {
  if (!source) return null;
  if (!source.file) return source.component ?? null;
  const file = short ? source.file.split(/[\\/]/).pop()! : source.file;
  return `${file}${source.line !== undefined ? `:${source.line}` : ""}`;
}

// `button "Continue to vehicle"`
export function elementLabel(element: MappedElement) {
  const kind = element.role ?? element.tag;
  if (element.name) return `${kind} "${element.name}"`;
  if (element.testId) return `${kind} [data-testid="${element.testId}"]`;
  return kind;
}

// `button "Continue to vehicle" (src/booking/Footer.tsx:42)`
export function describeElement(element: MappedElement) {
  const source = formatElementSource(element.source);
  return `${elementLabel(element)}${source ? ` (${source})` : ""}`;
}

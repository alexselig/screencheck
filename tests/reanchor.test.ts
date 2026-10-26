import { describe, expect, it } from "vitest";

import type { ElementMap, MappedElement } from "../src/shared/elements";
import {
  findElement,
  pinElementOf,
  reanchorPin,
  sourceElement,
  toPinElement,
} from "../src/shared/reanchor";

const button = (
  box: MappedElement["box"],
  extra: Partial<MappedElement> = {},
) =>
  ({
    box,
    tag: "button",
    role: "button",
    name: "Continue",
    selector: "footer > button",
    ...extra,
  }) as MappedElement;

const map = (
  elements: MappedElement[],
  capture = { width: 1000, height: 1000 },
): ElementMap => ({ version: 1, capture, elements });

const FROM = button({ x: 0.5, y: 0.8, w: 0.2, h: 0.1 });
const SOURCE = map([FROM]);

describe("reanchorPin", () => {
  it("keeps the % position without a map or a match", () => {
    const pin = { x: 0.55, y: 0.85 };
    expect(reanchorPin(pin, undefined, SOURCE)).toEqual({
      ...pin,
      placement: "fallback",
    });
    const from = sourceElement(pin, SOURCE)!;
    expect(reanchorPin(pin, from, null).placement).toBe("fallback");
    expect(
      reanchorPin(
        pin,
        from,
        map([button(FROM.box, { selector: "nav", name: "Other" })]),
      ).placement,
    ).toBe("fallback");
  });

  it("matches the same element in place", () => {
    const pin = { x: 0.55, y: 0.85 };
    const from = sourceElement(pin, SOURCE)!;
    const result = reanchorPin(pin, from, map([button(FROM.box)]));
    expect(result).toMatchObject({ x: 0.55, y: 0.85, placement: "matched" });
    expect(result.element?.selector).toBe("footer > button");
  });

  it("follows an element that moved, relative to its box, and flags it", () => {
    const pin = { x: 0.55, y: 0.85 };
    const from = sourceElement(pin, SOURCE)!;
    const result = reanchorPin(
      pin,
      from,
      map([button({ x: 0.1, y: 0.2, w: 0.4, h: 0.2 })]),
    );
    expect(result.placement).toBe("moved");
    // A quarter across and half down the button, as before.
    expect(result.x).toBeCloseTo(0.2);
    expect(result.y).toBeCloseTo(0.3);
  });

  it("maps a box pin's region and keeps x/y at its centre", () => {
    const pin = {
      x: 0.6,
      y: 0.85,
      box: { x: 0.5, y: 0.8, w: 0.2, h: 0.1 },
    };
    const from = sourceElement(pin, SOURCE)!;
    const result = reanchorPin(
      pin,
      from,
      map([button({ x: 0, y: 0, w: 0.4, h: 0.2 })]),
    );
    expect(result.box).toEqual({ x: 0, y: 0, w: 0.4, h: 0.2 });
    expect(result).toMatchObject({ x: 0.2, y: 0.1, placement: "moved" });
  });

  it("judges movement in pixels when both captures have sizes", () => {
    const pin = { x: 0.55, y: 0.85 };
    const from = toPinElement(FROM, { width: 1000, height: 1000 });
    // The page grew taller, so the fraction changed but the pixels did not.
    const taller = map([button({ x: 0.5, y: 0.4, w: 0.2, h: 0.05 })], {
      width: 1000,
      height: 2000,
    });
    expect(reanchorPin(pin, from, taller).placement).toBe("matched");
  });

  it("prefers a test id, then the selector, then role and name", () => {
    const from = toPinElement(
      button(FROM.box, { testId: "next", selector: "#a" }),
    );
    const byTestId = button(
      { x: 0, y: 0, w: 0.1, h: 0.1 },
      {
        testId: "next",
        selector: "#z",
      },
    );
    const bySelector = button(FROM.box, { selector: "#a" });
    expect(findElement(map([bySelector, byTestId]), from)).toBe(byTestId);
    const byName = button(FROM.box, { selector: "#q" });
    expect(
      findElement(
        map([byName]),
        toPinElement(button(FROM.box, { selector: "#a" })),
      ),
    ).toBe(byName);
  });

  it("picks the nearest of several candidates", () => {
    const near = button({ x: 0.5, y: 0.75, w: 0.2, h: 0.1 });
    const far = button({ x: 0, y: 0, w: 0.2, h: 0.1 });
    expect(findElement(map([far, near]), toPinElement(FROM))).toBe(near);
  });

  it("reads a stored element and ignores a foreign shape", () => {
    expect(pinElementOf({ element: toPinElement(FROM) })?.selector).toBe(
      "footer > button",
    );
    expect(pinElementOf({ element: { selector: 3 } })).toBeUndefined();
    expect(pinElementOf({})).toBeUndefined();
  });
});

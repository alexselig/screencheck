import { describe, expect, it } from "vitest";

import { parseScreens } from "../src/shared/manifest";

describe("screen manifest", () => {
  it("defaults the group to Screens and the description to the title", () => {
    expect(
      parseScreens([
        {
          id: "a",
          ordinal: 1,
          title: "Home page",
          viewport: { width: 1440, height: 1000 },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        group: "Screens",
        description: "Home page",
      }),
    ]);
  });

  it("names the missing field when a screen is incomplete", async () => {
    const { formatZodError } = await import("../src/shared/zod-format");
    const { ZodError } = await import("zod");
    try {
      parseScreens([{ id: "a", ordinal: 1, title: "A" }]);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(formatZodError(error as InstanceType<typeof ZodError>)).toMatch(
        /\[0\]\.viewport/,
      );
    }
  });

  it("requires unique stable ordinals", () => {
    expect(() =>
      parseScreens([
        {
          id: "a",
          ordinal: 1,
          title: "A",
          description: "Shows state A.",
          group: "One",
          viewport: { width: 1440, height: 1000 },
        },
        {
          id: "b",
          ordinal: 1,
          title: "B",
          description: "Shows state B.",
          group: "One",
          viewport: { width: 1440, height: 1000 },
        },
      ]),
    ).toThrow(/ordinal/i);
  });
});

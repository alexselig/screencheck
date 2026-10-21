import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const client = path.resolve(__dirname, "../src/client");
const read = (file: string) => readFileSync(path.join(client, file), "utf8");
const styles = read("styles.css");
// Data URIs carry their own colours (the select arrow); the rules may not.
const rules = styles.replace(/url\("data:[^"]*"\)/g, "url()");
const SPEC_TOKENS = path.join(
  homedir(),
  "repos/alex-tools-design-md/Bauhausian/bauhausian-tokens.css",
);

function ruleBody(selector: string) {
  const start = rules.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return rules.slice(start, rules.indexOf("}", start));
}

describe("Bauhausian tokens", () => {
  it("loads fonts, then the spec tokens, then the app styles", () => {
    const main = read("main.tsx");
    const order = ["./fonts.css", "./bauhausian-tokens.css", "./styles.css"];
    const at = order.map((file) => main.indexOf(`import "${file}";`));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("uses the spec palette rather than redeclaring it (ds-1)", () => {
    const tokens = read("bauhausian-tokens.css");
    expect(tokens).toContain("--bauhaus-orange: #ed6c47;");
    expect(tokens).toContain("--bauhaus-blue: #1b6fa8;");
    expect(rules).not.toMatch(/--(bauhaus-[a-z]+|surface|ink|line)[a-z-]*:/);
  });

  it.skipIf(!existsSync(SPEC_TOKENS))(
    "keeps the token file identical to the design repo (ds-1)",
    () => {
      expect(read("bauhausian-tokens.css")).toBe(
        readFileSync(SPEC_TOKENS, "utf8"),
      );
    },
  );

  it("uses the success token instead of an invented teal (ds-2)", () => {
    expect(rules).not.toMatch(/fixed-teal|on-teal/);
  });

  it("has no hard-coded colours outside the token file (ds-3)", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\brgba?\(/);
  });

  it("uses the spacing, motion and sizing tokens (ds-4)", () => {
    expect(rules).not.toMatch(/\b\d+ms\b/);
    expect(rules).toMatch(/--action-bar-height: var\(--size-footer\);/);
    const spacing = [
      ...rules.matchAll(/\b(?:padding|margin|gap)[a-z-]*: ([^;]+);/g),
    ]
      // A calc() offsets a token by a fixed part (a dot, the rail strip).
      .map((match) => match[1]!.replace(/calc\([^;]*\)/g, "calc()"));
    const offScale = spacing.filter((value) =>
      /(?<![\w-])(?!0px|1px|2px)\d+px/.test(value),
    );
    expect(offScale).toEqual([]);
  });

  it("self-hosts its fonts (ds-35)", () => {
    expect(styles).not.toMatch(/fonts\.googleapis|@import/);
    const fonts = read("fonts.css");
    for (const family of ["Figtree", "League Spartan"]) {
      expect(fonts).toContain(`font-family: "${family}";`);
    }
    for (const file of fonts.match(/\.\/fonts\/[\w.-]+\.woff2/g) ?? []) {
      expect(existsSync(path.join(client, file))).toBe(true);
    }
    expect(fonts).toContain("font-display: swap;");
    expect(existsSync(path.join(client, "fonts/OFL-Figtree.txt"))).toBe(true);
    expect(existsSync(path.join(client, "fonts/OFL-League-Spartan.txt"))).toBe(
      true,
    );
  });

  it("keeps the ordinal on a weight the display face ships (ds-35)", () => {
    expect(ruleBody(".screen-ordinal")).toMatch(/font-weight: 600;/);
  });
});

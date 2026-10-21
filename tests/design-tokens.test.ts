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

// Every top-level rule for exactly this selector, joined.
function ruleBody(selector: string) {
  const bodies: string[] = [];
  let start = rules.indexOf(`\n${selector} {`);
  while (start >= 0) {
    bodies.push(rules.slice(start, rules.indexOf("}", start)));
    start = rules.indexOf(`\n${selector} {`, start + 1);
  }
  if (!bodies.length) throw new Error(`no rule for ${selector}`);
  return bodies.join("\n");
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

describe("type and control scale", () => {
  it("keeps editor fields at body weight (ds-5)", () => {
    expect(
      ruleBody(".feedback-editor select,\n.feedback-editor textarea"),
    ).toMatch(/font-weight: 400;/);
    expect(rules).toMatch(
      /\.feedback-editor textarea::placeholder[^{]*\{[^}]*color: var\(--ink-muted\);/,
    );
  });

  it("uses four text sizes plus display (ds-6)", () => {
    const sizes = new Set(
      [...rules.matchAll(/font-size: (\d+)px;/g)].map((match) => match[1]),
    );
    expect([...sizes].sort()).toEqual(["11", "13", "15", "22", "28"]);
    // Uppercase labels share one tracking.
    for (const match of rules.matchAll(/\{([^}]*)\}/g)) {
      const body = match[1]!;
      const spacing = body.match(/letter-spacing: ([^;]+);/)?.[1];
      if (body.includes("text-transform: uppercase") && spacing) {
        expect(["0.12em", "inherit"]).toContain(spacing);
      }
    }
    // 600 is kept only for the rail numerals (ds-35).
    expect(rules.match(/font-weight: 600;/g)).toHaveLength(1);
    expect(ruleBody(".screen-ordinal")).toMatch(/font-weight: 600;/);
  });

  it("keeps passive counts and filters out of action blue (ds-19)", () => {
    expect(ruleBody(".feedback-inspector-count")).toMatch(
      /color: var\(--ink-muted\);/,
    );
    expect(ruleBody(".rail-filter-button")).not.toMatch(/bauhaus-blue/);
  });

  it("uses two control heights (ds-22)", () => {
    for (const selector of [
      ".feedback-reply-send",
      ".feedback-verify-buttons button",
    ]) {
      expect(ruleBody(selector)).toMatch(/min-height: var\(--size-touch\);/);
    }
    expect(ruleBody(".feedback-delete-x")).toMatch(/height: 28px;/);
    expect(ruleBody(".feedback-collapse")).toMatch(/height: 28px;/);
  });
});

describe("states", () => {
  it("draws the pin ring with a shadow so focus can use the outline (ds-13)", () => {
    expect(ruleBody(".pin-dot")).not.toMatch(/outline:/);
    expect(ruleBody(".pin-dot")).toMatch(/box-shadow: 0 0 0 1px var\(--ink\);/);
    expect(ruleBody(".feedback-pin:focus-visible")).toMatch(
      /outline: 2px solid var\(--bauhaus-blue\);/,
    );
  });

  it("uses the blue focus ring on destructive controls (ds-14)", () => {
    expect(rules).not.toMatch(/outline: 2px solid var\(--destructive\)/);
  });

  it("darkens with tokens, never a brightness filter (ds-15)", () => {
    expect(rules).not.toMatch(/filter:\s*brightness/);
    expect(ruleBody(".feedback-pin:hover")).toMatch(/scale\(1\.1\)/);
    expect(ruleBody(".feedback-pin")).toMatch(/transition:[^;]*var\(--fast\)/);
    expect(rules).toMatch(/\.feedback-add-button:hover:not\(:disabled\)/);
    expect(rules).toMatch(
      /button:not\(\.feedback-pin\):active:not\(:disabled\)/,
    );
  });
});

describe("feedback cards", () => {
  it("renders notes as body text, bold only when selected (ds-7)", () => {
    expect(ruleBody(".feedback-comment-note")).toMatch(/font-weight: 500;/);
    expect(
      ruleBody('.feedback-comment[aria-pressed="true"] .feedback-comment-note'),
    ).toMatch(/font-weight: 700;/);
  });

  it("draws card edges with the strong rule (ds-20)", () => {
    expect(ruleBody(".feedback-comment")).toMatch(
      /border: 1px solid var\(--line-strong\);/,
    );
  });
});

describe("rail rows", () => {
  it("sets badges side by side in a 40px slot at 18px (ds-11)", () => {
    expect(ruleBody(".screen-number")).toMatch(
      /grid-template-columns: 40px 24px;/,
    );
    expect(ruleBody(".screen-badges")).not.toMatch(/column|absolute/);
    expect(ruleBody(".screen-open-count")).toMatch(/font-size: 11px;/);
    expect(ruleBody(".screen-open-count")).not.toMatch(/outline/);
    expect(ruleBody(".screen-approved-mark")).toMatch(/width: 18px;/);
  });

  it("keeps the version outside the truncating title (ds-12)", () => {
    expect(ruleBody(".screen-version")).toMatch(/flex: none;/);
    expect(ruleBody(".screen-version")).not.toMatch(/overflow/);
  });
});

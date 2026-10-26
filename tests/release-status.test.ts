// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli/index";
import { parseStatusArgs } from "../src/cli/status";
import {
  RELEASE_STATUS_SCHEMA,
  summarizeRelease,
  type ReleaseInput,
} from "../src/shared/release";

function comment(
  id: string,
  version: string,
  screenId: string,
  status = "OPEN",
  tags: string[] = [],
) {
  return { id, version, screenId, status, tags };
}

const screens = [
  { id: "home", ordinal: 1, title: "Home" },
  { id: "checkout", ordinal: 2, title: "Checkout" },
  { id: "profile", ordinal: 3, title: "Profile" },
];

// r1 at two sizes, r2 at two sizes; profile is new in r2.
function sizedInput(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    project: {
      id: "shop",
      versions: ["r1-390", "r1-1440", "r2-390", "r2-1440"],
      versionDetails: [
        { id: "r1-390", revision: "r1", label: "390" },
        { id: "r1-1440", revision: "r1", label: "1440" },
        { id: "r2-390", revision: "r2", label: "390" },
        { id: "r2-1440", revision: "r2", label: "1440" },
      ],
      screens,
    },
    captures: {
      "r1-390": ["home", "checkout"],
      "r1-1440": ["home", "checkout"],
      "r2-390": ["home", "checkout", "profile"],
      "r2-1440": ["home", "checkout", "profile"],
    },
    approvals: [
      { version: "r2-390", screenId: "home" },
      { version: "r2-1440", screenId: "home" },
      { version: "r2-1440", screenId: "checkout" },
      { version: "r2-390", screenId: "profile" },
      { version: "r2-1440", screenId: "profile" },
    ],
    feedback: [
      comment("a", "r1-390", "home", "VERIFIED", ["P1"]),
      comment("b", "r1-1440", "checkout", "WONT_FIX"),
      comment("c", "r1-1440", "checkout", "OPEN", ["P2"]),
      comment("d", "r2-390", "checkout", "OPEN", ["P0"]),
      comment("e", "r2-1440", "home", "IN_PROGRESS", ["P1"]),
      comment("f", "r2-1440", "profile", "OPEN"),
      comment("g", "r2-390", "home", "RESOLVED", ["P2"]),
    ],
    ...overrides,
  };
}

describe("summarizeRelease", () => {
  it("rolls approvals up across sizes and counts open comments by priority", () => {
    const status = summarizeRelease(sizedInput());
    expect(status.schema).toBe(RELEASE_STATUS_SCHEMA);
    expect(status.project).toBe("shop");
    expect(status.revision).toBe("r2");
    expect(status.versions).toEqual(["r2-390", "r2-1440"]);
    // checkout is approved at 1440 only, so it is not approved.
    expect(status.screens).toEqual({ total: 3, approved: 2, unapproved: 1 });
    expect(status.open).toEqual({ total: 3, P0: 1, P1: 1, P2: 0, none: 1 });
    expect(status.fixedNotVerified).toBe(1);
    expect(
      status.screenList.find((item) => item.id === "checkout"),
    ).toMatchObject({
      approved: false,
      sizes: [
        { version: "r2-390", label: "390", approved: false },
        { version: "r2-1440", label: "1440", approved: true },
      ],
    });
    expect(status.sizes).toMatchObject([
      {
        version: "r2-390",
        label: "390",
        previous: "r1-390",
        screens: { total: 3, approved: 2 },
        open: { total: 1, P0: 1 },
        fixedNotVerified: 1,
      },
      {
        version: "r2-1440",
        label: "1440",
        previous: "r1-1440",
        screens: { total: 3, approved: 3 },
        open: { total: 2, P1: 1, none: 1 },
      },
    ]);
  });

  it("reports what changed since the previous revision", () => {
    const status = summarizeRelease(sizedInput());
    expect(status.previous).toEqual({
      revision: "r1",
      versions: ["r1-390", "r1-1440"],
    });
    expect(status.changes).toEqual({
      since: "r1",
      screensAdded: ["profile"],
      screensRemoved: [],
      commentsOpened: 4,
      commentsClosed: 2,
      commentsStillOpen: 1,
    });
    expect(status.sizes[0]!.changes).toEqual({
      since: "r1-390",
      screensAdded: ["profile"],
      screensRemoved: [],
      commentsOpened: 2,
      commentsClosed: 1,
      commentsStillOpen: 0,
    });
  });

  it("has no changes for the first revision and treats a version without captures as showing every screen", () => {
    const status = summarizeRelease(
      sizedInput({ captures: {}, target: { revision: "r1" } }),
    );
    expect(status.revision).toBe("r1");
    expect(status.previous).toBeNull();
    expect(status.changes).toBeNull();
    expect(status.screens.total).toBe(3);
    expect(status.screens.approved).toBe(0);
  });

  it("summarises a single version when asked", () => {
    const status = summarizeRelease(
      sizedInput({ target: { version: "r2-1440" } }),
    );
    expect(status.versions).toEqual(["r2-1440"]);
    expect(status.screens).toEqual({ total: 3, approved: 3, unapproved: 0 });
    expect(status.previous).toEqual({ revision: "r1", versions: ["r1-1440"] });
  });

  it("treats each unlabelled version as its own revision", () => {
    const status = summarizeRelease({
      project: { id: "p", versions: ["v1", "v2"], screens },
      approvals: [],
      feedback: [comment("x", "v1", "home"), comment("y", "v2", "home")],
    });
    expect(status.revision).toBe("v2");
    expect(status.previous).toEqual({ revision: "v1", versions: ["v1"] });
    expect(status.changes).toMatchObject({
      commentsOpened: 1,
      commentsClosed: 0,
      commentsStillOpen: 1,
    });
  });

  it("rejects an unknown revision or version", () => {
    expect(() =>
      summarizeRelease(sizedInput({ target: { revision: "r9" } })),
    ).toThrow(/no revision "r9".*r1, r2/);
    expect(() =>
      summarizeRelease(sizedInput({ target: { version: "nope" } })),
    ).toThrow(/no version "nope"/);
  });

  it("gates on open P0s and unapproved screens, with overrides", () => {
    const failing = summarizeRelease(sizedInput());
    expect(failing.gate.pass).toBe(false);
    expect(failing.gate.reasons).toEqual([
      "1 open P0 comment",
      "1 screen not approved: 02 Checkout (390)",
    ]);
    const lenient = summarizeRelease(
      sizedInput({ gate: { allowUnapproved: true } }),
    );
    expect(lenient.gate.reasons).toEqual(["1 open P0 comment"]);
    const strict = summarizeRelease(
      sizedInput({ gate: { maxPriority: "P1", allowUnapproved: true } }),
    );
    expect(strict.gate.reasons).toEqual([
      "1 open P0 comment",
      "1 open P1 comment",
    ]);
    const any = summarizeRelease(
      sizedInput({ gate: { maxPriority: "any", allowUnapproved: true } }),
    );
    expect(any.gate.reasons).toEqual(["3 open comments"]);
    const clean = summarizeRelease(
      sizedInput({
        feedback: [],
        approvals: [
          ...sizedInput().approvals,
          { version: "r2-390", screenId: "checkout" },
        ],
      }),
    );
    expect(clean.gate).toEqual({
      pass: true,
      reasons: [],
      maxPriority: "P0",
      allowUnapproved: false,
    });
  });
});

describe("parseStatusArgs", () => {
  it("parses flags and validates --max-priority", () => {
    expect(
      parseStatusArgs([
        "--project",
        "shop",
        "--revision",
        "r2",
        "--gate",
        "--json",
        "--allow-unapproved",
        "--max-priority",
        "p1",
      ]),
    ).toEqual({
      project: "shop",
      revision: "r2",
      gate: true,
      json: true,
      allowUnapproved: true,
      maxPriority: "P1",
    });
    expect(() => parseStatusArgs(["--max-priority", "P7"])).toThrow(
      /--max-priority/,
    );
    expect(() =>
      parseStatusArgs(["--version", "a", "--revision", "b"]),
    ).toThrow(/either --version or --revision/);
  });
});

describe("screencheck status (release)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(process.cwd(), "tests/.feedback-data-status-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function seed(input: ReleaseInput) {
    const projects = join(home, "projects");
    await mkdir(projects, { recursive: true });
    const versions = [];
    for (const version of input.project.versions) {
      const dir = join(home, "captures", version);
      await mkdir(dir, { recursive: true });
      for (const screenId of input.captures?.[version] ?? []) {
        await writeFile(join(dir, `${screenId}.png`), "png");
      }
      const detail = input.project.versionDetails?.find(
        (item) => item.id === version,
      );
      versions.push({ id: version, captureRoot: dir, ...detail });
    }
    await writeFile(
      join(projects, `${input.project.id}.json`),
      JSON.stringify({
        id: input.project.id,
        name: "Shop",
        versions,
        screens: input.project.screens.map((screen) => ({
          ...screen,
          capturePath: `${screen.id}.png`,
          viewport: { width: 1440, height: 900 },
        })),
      }),
    );
    const data = join(home, "feedback", input.project.id);
    await mkdir(data, { recursive: true });
    const at = "2026-10-01T10:00:00.000Z";
    await writeFile(
      join(data, "feedback.json"),
      JSON.stringify({
        version: 1,
        schemaVersion: 2,
        feedback: input.feedback.map((item) => ({
          ...item,
          projectId: input.project.id,
          x: 0.5,
          y: 0.5,
          note: `Note ${item.id}`,
          createdAt: at,
          updatedAt: at,
        })),
      }),
    );
    await writeFile(
      join(data, "approvals.json"),
      JSON.stringify({
        version: 1,
        approvals: input.approvals.map((item) => ({ ...item, approvedAt: at })),
      }),
    );
  }

  async function cli(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["status", ...args], {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      env: { SCREENCHECK_HOME: home },
      readRuntime: () => null,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("prints the round summary without a running server", async () => {
    await seed(sizedInput());
    const run = await cli("--project", "shop");
    expect(run.code).toBe(0);
    expect(run.out).toContain("shop · revision r2 (2 sizes: 390, 1440)");
    expect(run.out).toContain("3 screens, 2 approved");
    expect(run.out).toContain("Open comments: 3 (P0 1, P1 1, P2 0, none 1)");
    expect(run.out).toContain("Fixed, not verified: 1");
    expect(run.out).toContain(
      "Since r1: 1 screen added (profile), 0 removed; 4 comments opened, 2 closed, 1 still open",
    );
    expect(run.out).toMatch(/390 +3 screens, 2 approved/);
    expect(run.out).not.toContain("Gate:");
  });

  it("--gate exits 1 with reasons, and 0 when overrides clear them", async () => {
    await seed(sizedInput());
    const failing = await cli("--project", "shop", "--gate");
    expect(failing.code).toBe(1);
    expect(failing.out).toContain("Gate: FAIL");
    expect(failing.out).toContain("  - 1 open P0 comment");
    expect(failing.out).toContain(
      "  - 1 screen not approved: 02 Checkout (390)",
    );

    const passing = await cli(
      "--project",
      "shop",
      "--revision",
      "r1",
      "--gate",
      "--allow-unapproved",
      "--max-priority",
      "P1",
    );
    expect(passing.out).toContain("Gate: PASS");
    expect(passing.code).toBe(0);

    const blocked = await cli(
      "--project",
      "shop",
      "--revision",
      "r1",
      "--gate",
      "--allow-unapproved",
      "--max-priority",
      "P2",
    );
    expect(blocked.code).toBe(1);
  });

  it("--json emits the documented shape, and exits by the gate only with --gate", async () => {
    await seed(sizedInput());
    const run = await cli("--project", "shop", "--json");
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.out);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "schema",
        "project",
        "revision",
        "versions",
        "previous",
        "screens",
        "open",
        "fixedNotVerified",
        "changes",
        "sizes",
        "screenList",
        "gate",
      ].sort(),
    );
    expect(parsed).toMatchObject({
      schema: 1,
      project: "shop",
      revision: "r2",
      screens: { total: 3, approved: 2, unapproved: 1 },
      gate: { pass: false, maxPriority: "P0", allowUnapproved: false },
    });
    expect(Object.keys(parsed.sizes[0]).sort()).toEqual(
      [
        "version",
        "label",
        "previous",
        "screens",
        "open",
        "fixedNotVerified",
        "changes",
      ].sort(),
    );
    const gated = await cli("--project", "shop", "--json", "--gate");
    expect(gated.code).toBe(1);
    expect(JSON.parse(gated.out).gate.pass).toBe(false);
  });

  it("picks the only project, and errors clearly on an unknown one", async () => {
    await seed(sizedInput());
    expect((await cli("--gate", "--allow-unapproved")).out).toContain(
      "shop · revision r2",
    );
    const missing = await cli("--project", "nope");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Unknown project "nope"');
  });

  it("keeps plain `status` as the server check", async () => {
    const run = await cli();
    expect(run.code).toBe(1);
    expect(run.out).toBe("ScreenCheck is not running.");
  });
});

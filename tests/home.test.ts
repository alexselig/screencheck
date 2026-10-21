// @vitest-environment node
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultDataRoot } from "../src/server";
import { appHome } from "../src/server/home";
import { defaultProjectsRoot } from "../src/server/projects";
import { runtimeFile } from "../src/server/runtime";

afterEach(() => vi.unstubAllEnvs());

describe("SCREENCHECK_HOME (pr-20)", () => {
  it("moves feedback, projects and server.json together", () => {
    vi.stubEnv("SCREENCHECK_HOME", "sandbox/sc");
    vi.stubEnv("SCREENCHECK_DATA", "");
    vi.stubEnv("SCREENCHECK_PROJECTS", "");
    delete process.env.SCREENCHECK_DATA;
    delete process.env.SCREENCHECK_PROJECTS;
    const home = resolve("sandbox/sc");
    expect(appHome()).toBe(home);
    expect(defaultDataRoot()).toBe(join(home, "feedback"));
    expect(defaultProjectsRoot()).toBe(join(home, "projects"));
    expect(runtimeFile()).toBe(join(home, "server.json"));
  });

  it("still lets the per-folder overrides win", () => {
    vi.stubEnv("SCREENCHECK_HOME", "/sc");
    vi.stubEnv("SCREENCHECK_DATA", "/elsewhere");
    expect(defaultDataRoot()).toBe("/elsewhere");
  });

  it("is ignored when a home folder is passed explicitly", () => {
    expect(appHome("/u", () => false, { SCREENCHECK_HOME: "/sc" })).toBe(
      join("/u", ".screencheck"),
    );
  });
});

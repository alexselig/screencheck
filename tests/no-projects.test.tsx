import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/client/app";

function serveProjects(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("no registered projects (pr-7)", () => {
  it("shows the projects folder, a minimal file and registration problems", async () => {
    serveProjects({
      projects: [],
      problems: ["broken.json: Unexpected token"],
      projectsRoot: "/home/me/.screencheck/projects",
    });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "No projects yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("/home/me/.screencheck/projects"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Minimal project file")).toHaveTextContent(
      '"captureRoot"',
    );
    expect(screen.getByRole("button", { name: "Copy example" })).toBeEnabled();
    expect(screen.getByText("npm run playground")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "broken.json: Unexpected token",
    );
    // No placeholder project with made-up screens.
    expect(screen.queryByText("Example project")).toBeNull();
    expect(screen.queryByText(/Session bootstrap/)).toBeNull();
  });

  it("reports a failed project list in the empty state", async () => {
    serveProjects({ error: "boom" }, 500);
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "No projects yet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Projects could not load/,
    );
  });
});

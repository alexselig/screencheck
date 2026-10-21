// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runReply as run } from "../src/cli/reply";
import { handleApi } from "../src/server/api";
import { createFeedbackStorage } from "../src/server/storage";
import { serializeMarkdown } from "../src/shared/export";

let server: Server;
let root: string;
let origin: string;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  const storage = createFeedbackStorage({ dataRoot: root });
  let port = 0;
  server = createServer(async (request, response) => {
    if (!(await handleApi(request, response, { storage, port }))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/api/projects/demo/feedback`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function send(method: string, url: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(note: string, id = crypto.randomUUID()) {
  const response = await send("POST", base, {
    clientMutationId: id,
    screenId: "landing",
    version: "live",
    x: 0.5,
    y: 0.5,
    note,
  });
  return (await response.json()).feedback;
}

async function list() {
  return (await (await fetch(base)).json()).feedback;
}

async function cli(...args: string[]) {
  const lines: string[] = [];
  const code = await run(["--project", "demo", "--url", origin, ...args], {
    log: (line: string) => lines.push(line),
  });
  return { code, out: lines.join("\n") };
}

describe("feedback replies", () => {
  it("requires a change summary when feedback is marked fixed", async () => {
    const item = await create("Footer floats mid-page.");
    const response = await send("PATCH", `${base}/${item.id}`, {
      expectedUpdatedAt: item.updatedAt,
      patch: { status: "RESOLVED" },
    });

    expect(response.status).toBe(400);
  });

  it("stamps a reply with the update time and keeps it through later edits", async () => {
    const item = await create("Footer floats mid-page.");
    const replied = await (
      await send("PATCH", `${base}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        patch: {
          status: "RESOLVED",
          reply: { note: "Pinned it to the end.", author: "Copilot" },
        },
      })
    ).json();
    expect(replied.feedback.status).toBe("RESOLVED");
    expect(replied.feedback.reply).toEqual({
      note: "Pinned it to the end.",
      author: "Copilot",
      at: replied.feedback.updatedAt,
    });

    const reopened = await (
      await send("PATCH", `${base}/${item.id}`, {
        expectedUpdatedAt: replied.feedback.updatedAt,
        patch: { status: "OPEN" },
      })
    ).json();
    expect(reopened.feedback.reply.note).toBe("Pinned it to the end.");

    const cleared = await (
      await send("PATCH", `${base}/${item.id}`, {
        expectedUpdatedAt: reopened.feedback.updatedAt,
        patch: { reply: null },
      })
    ).json();
    expect(cleared.feedback).not.toHaveProperty("reply");
  });

  it("rejects empty and oversized replies", async () => {
    const item = await create("Note");
    for (const note of ["  ", "x".repeat(2001)]) {
      const response = await send("PATCH", `${base}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        patch: { reply: { note } },
      });
      expect(response.status).toBe(400);
    }
  });

  it("lets an agent list open comments, reply and close them from the CLI", async () => {
    const open = await create("Footer floats mid-page.");
    const done = await create("Already handled.");
    await send("PATCH", `${base}/${done.id}`, {
      expectedUpdatedAt: done.updatedAt,
      patch: {
        status: "RESOLVED",
        reply: { note: "Completed before this review.", author: "Copilot" },
      },
    });

    const listed = await cli("--list");
    expect(listed.out).toContain(open.id);
    expect(listed.out).toContain("live/landing pin 1");
    expect(listed.out).not.toContain(done.id);
    expect((await cli("--list", "--all")).out).toContain(done.id);

    const replied = await cli(
      "--id",
      open.id,
      "--status",
      "fixed",
      "--note",
      "Moved below the fold.",
    );
    expect(replied).toEqual({
      code: 0,
      out: `Replied to ${open.id} (Fixed).`,
    });
    const record = (await list()).find(
      (item: { id: string }) => item.id === open.id,
    );
    expect(record.status).toBe("RESOLVED");
    expect(record.reply).toMatchObject({
      note: "Moved below the fold.",
      author: "Agent",
    });

    expect((await cli("--id", open.id, "--clear")).code).toBe(0);
    expect(
      (await list()).find((item: { id: string }) => item.id === open.id),
    ).not.toHaveProperty("reply");
  });

  it("lists Verified comments by name and won't set Verified itself", async () => {
    const item = await create("Header overlaps.");
    const fixed = await (
      await send("PATCH", `${base}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        patch: { status: "RESOLVED", reply: { note: "Fixed the z-index." } },
      })
    ).json();
    const verified = await fetch(`${base}/${item.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin,
        "x-screencheck-actor": "reviewer",
      },
      body: JSON.stringify({
        expectedUpdatedAt: fixed.feedback.updatedAt,
        patch: { status: "VERIFIED" },
      }),
    });
    expect(verified.status).toBe(200);

    expect((await cli("--list", "--all")).out).toMatch(
      new RegExp(`${item.id}\t.*\tVerified\t`),
    );
    await expect(
      cli("--id", item.id, "--note", "x", "--status", "verified"),
    ).rejects.toThrow("Only a reviewer can mark a comment Verified.");
  });

  it("explains bad CLI input", async () => {
    const item = await create("Note");
    await expect(cli("--id", item.id)).rejects.toThrow("--note is required");
    await expect(
      cli("--id", item.id, "--note", "x", "--status", "shipped"),
    ).rejects.toThrow("Unknown status: shipped");
    await expect(cli("--id", "missing", "--note", "x")).rejects.toThrow(
      "No feedback with id missing",
    );
  });

  it("accepts the same status names as the MCP server", async () => {
    const item = await create("Note");
    expect(
      (await cli("--id", item.id, "--note", "Done.", "--status", "done")).out,
    ).toBe(`Replied to ${item.id} (Fixed).`);
  });

  it("filters the list and prints JSON", async () => {
    const first = await create("Footer floats.");
    const second = await create("Header overlaps.");
    await send("PATCH", `${base}/${second.id}`, {
      expectedUpdatedAt: second.updatedAt,
      patch: { tags: ["P0"] },
    });
    const tagged = await cli("--list", "--tag", "p0");
    expect(tagged.out).toContain(second.id);
    expect(tagged.out).not.toContain(first.id);
    expect((await cli("--list", "--screen", "nowhere")).out).toBe(
      "No matching feedback.",
    );
    expect((await cli("--list", "--status", "fixed,wont-fix")).out).toBe(
      "No matching feedback.",
    );
    const json = JSON.parse((await cli("--list", "--json")).out);
    expect(json.count).toBe(2);
    expect(json.feedback[0]).toMatchObject({
      id: first.id,
      pin: 1,
      statusLabel: "Backlog",
      awaitingAgent: false,
    });
  });

  it("shows one comment with its whole thread", async () => {
    const item = await create("Footer floats.");
    await send("PATCH", `${base}/${item.id}`, {
      expectedUpdatedAt: item.updatedAt,
      patch: {
        status: "RESOLVED",
        reply: { note: "Pinned it.", author: "Copilot" },
      },
    });
    const shown = await cli("--show", "--id", item.id);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Note: Footer floats.");
    expect(shown.out).toMatch(/Agent \(Copilot, .*\) -> Fixed: Pinned it\./);
    const json = JSON.parse(
      (await cli("--show", "--id", item.id, "--json")).out,
    );
    expect(json.comment).toMatchObject({ id: item.id, statusLabel: "Fixed" });
  });

  it("keeps a reviewer's Verified when the agent's reply races it", async () => {
    const item = await create("Header overlaps.");
    const fixed = await (
      await send("PATCH", `${base}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        patch: { status: "RESOLVED", reply: { note: "Fixed the z-index." } },
      })
    ).json();
    let patches = 0;
    const racing: typeof fetch = async (input, init) => {
      if (init?.method === "PATCH" && patches++ === 0) {
        await fetch(`${base}/${item.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            origin,
            "x-screencheck-actor": "reviewer",
          },
          body: JSON.stringify({
            expectedUpdatedAt: fixed.feedback.updatedAt,
            patch: { status: "VERIFIED" },
          }),
        });
      }
      return fetch(input, init);
    };
    await expect(
      run(
        [
          "--project",
          "demo",
          "--url",
          origin,
          "--id",
          item.id,
          "--status",
          "in-progress",
          "--note",
          "Reopening to check mobile.",
        ],
        { fetch: racing, log: () => {} },
      ),
    ).rejects.toThrow(/from Fixed to Verified.*Your note was added/);
    const record = (await list()).find(
      (entry: { id: string }) => entry.id === item.id,
    );
    expect(record.status).toBe("VERIFIED");
    expect(JSON.stringify(record)).toContain("Reopening to check mobile.");
  });

  it("puts ids and replies in the Markdown export", () => {
    const markdown = serializeMarkdown({
      projectId: "demo",
      screens: [],
      feedback: [
        {
          id: "abc-123",
          projectId: "demo",
          screenId: "landing",
          version: "live",
          x: 0.5,
          y: 0.5,
          note: "Footer floats.",
          tags: [],
          status: "RESOLVED",
          reply: {
            note: "Pinned it.",
            author: "Copilot",
            at: "2026-10-05T20:00:00.000Z",
          },
          createdAt: "2026-10-05T20:00:00.000Z",
          updatedAt: "2026-10-05T20:00:00.000Z",
        },
      ],
    });
    expect(markdown).toContain("`id: abc-123`");
    expect(markdown).toContain(
      "  - Reply (Copilot, 2026-10-05 20:00 UTC): Pinned it.",
    );
  });
});

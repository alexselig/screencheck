import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server";
import {
  acquireDataRootLock,
  DataRootInUseError,
  LOCK_FILE,
} from "../src/server/lock";

const bases: string[] = [];
const roots = () => {
  const base = mkdtempSync(join(process.cwd(), "tests/.feedback-data-lock-"));
  bases.push(base);
  return { dataRoot: join(base, "data"), projectsRoot: join(base, "p") };
};

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

// Starts a real server in another process and resolves once it is listening.
function serveElsewhere(dataRoot: string, projectsRoot: string) {
  const script = `
    const { startServer } = await import(${JSON.stringify(join(process.cwd(), "src/server/index.ts"))});
    const running = await startServer({ port: 0, dataRoot: ${JSON.stringify(dataRoot)}, projectsRoot: ${JSON.stringify(projectsRoot)}, clientRoot: ${JSON.stringify(process.cwd())} });
    console.log(running.origin);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return new Promise<{ pid: number; origin: string }>((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", (chunk) => (err += chunk));
    child.stdout!.once("data", (chunk) =>
      resolve({ pid: child.pid!, origin: String(chunk).trim() }),
    );
    child.once("exit", () => reject(new Error(err)));
  });
}

describe("one server per data root (be-2)", () => {
  it("refuses a second process on the same data root and names the first", async () => {
    const { dataRoot, projectsRoot } = roots();
    const other = await serveElsewhere(dataRoot, projectsRoot);
    const lock = JSON.parse(readFileSync(join(dataRoot, LOCK_FILE), "utf8"));
    expect(lock).toMatchObject({ pid: other.pid, origin: other.origin });

    const error = await startServer({
      port: 0,
      dataRoot,
      projectsRoot,
      clientRoot: process.cwd(),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DataRootInUseError);
    expect(error.holder).toMatchObject({
      pid: other.pid,
      origin: other.origin,
    });
    expect(error.message).toContain(other.origin);
  }, 20_000);

  it("lets servers in one process share a root and releases on the last close", async () => {
    const { dataRoot, projectsRoot } = roots();
    const options = {
      port: 0,
      dataRoot,
      projectsRoot,
      clientRoot: process.cwd(),
    };
    const a = await startServer(options);
    const b = await startServer(options);
    await a.close();
    expect(existsSync(join(dataRoot, LOCK_FILE))).toBe(true);
    await b.close();
    expect(existsSync(join(dataRoot, LOCK_FILE))).toBe(false);
  });

  it("takes over a lock left by a process that is gone", async () => {
    const { dataRoot } = roots();
    const first = await acquireDataRootLock(dataRoot);
    first.release();
    writeFileSync(
      join(dataRoot, LOCK_FILE),
      JSON.stringify({ pid: 999_999, startedAt: "x" }),
    );
    const lock = await acquireDataRootLock(dataRoot, { alive: () => false });
    expect(
      JSON.parse(readFileSync(join(dataRoot, LOCK_FILE), "utf8")).pid,
    ).toBe(process.pid);
    lock.release();
  });

  it("treats an unreadable lock as stale after a short wait", async () => {
    const { dataRoot } = roots();
    (await acquireDataRootLock(dataRoot)).release();
    writeFileSync(join(dataRoot, LOCK_FILE), "{");
    const lock = await acquireDataRootLock(dataRoot);
    lock.release();
    expect(existsSync(join(dataRoot, LOCK_FILE))).toBe(false);
  });
});

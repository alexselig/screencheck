import { rmSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { processAlive } from "./runtime";

// One server per data root. Two processes writing the same feedback.json
// would lose each other's updates, so the second one refuses to start.
export const LOCK_FILE = "server.lock";

export type LockInfo = {
  pid: number;
  startedAt: string;
  origin?: string;
};

export class DataRootInUseError extends Error {
  constructor(
    readonly dataRoot: string,
    readonly holder: LockInfo,
  ) {
    super(
      `Another ScreenCheck (pid ${holder.pid}${holder.origin ? `, ${holder.origin}` : ""}) is already serving ${dataRoot}. Use that one, stop it, or point this one at other data with SCREENCHECK_DATA.`,
    );
    this.name = "DataRootInUseError";
  }
}

export type DataRootLock = {
  file: string;
  setOrigin(origin: string): void;
  release(): void;
};

// Servers in the same process share one storage queue, so they may share a
// root; the lock is counted and released by the last one.
const held = new Map<string, { count: number; info: LockInfo }>();

function parseLock(text: string): LockInfo | null {
  try {
    const info = JSON.parse(text) as LockInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

const delay = (ms: number) =>
  new Promise((done) => setTimeout(done, ms).unref());

export async function acquireDataRootLock(
  dataRoot: string,
  { alive = processAlive }: { alive?: (pid: number) => boolean } = {},
): Promise<DataRootLock> {
  const root = resolve(dataRoot);
  const file = join(root, LOCK_FILE);
  const existing = held.get(file);
  if (existing) {
    existing.count += 1;
    return handle(file);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const lock = await open(file, "wx", 0o600);
      try {
        await lock.writeFile(`${JSON.stringify(info)}\n`, "utf8");
      } finally {
        await lock.close();
      }
      held.set(file, { count: 1, info });
      return handle(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = parseLock(await readFile(file, "utf8").catch(() => ""));
    if (holder && holder.pid !== process.pid && alive(holder.pid)) {
      throw new DataRootInUseError(root, holder);
    }
    // A half-written lock is given a moment to finish before it counts as
    // stale; a dead pid (or our own, left by a crash) is stale right away.
    if (!holder && attempt < 2) {
      await delay(50);
      continue;
    }
    await unlink(file).catch(() => undefined);
  }
  throw new Error(`Could not take ${file}; remove it if no server is running.`);
}

function handle(file: string): DataRootLock {
  let released = false;
  const onExit = () => release();
  process.once("exit", onExit);
  function release() {
    if (released) return;
    released = true;
    process.removeListener("exit", onExit);
    const entry = held.get(file);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    held.delete(file);
    rmSync(file, { force: true });
  }
  return {
    file,
    setOrigin(origin) {
      const entry = held.get(file);
      if (!entry || entry.info.origin) return;
      entry.info.origin = origin;
      writeFileSync(file, `${JSON.stringify(entry.info)}\n`, { mode: 0o600 });
    },
    release,
  };
}

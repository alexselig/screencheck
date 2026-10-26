// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crc32, readZip, writeZip } from "../src/cli/zip";

function hasUnzip() {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("zip writer (#13)", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("round-trips text, binary, empty and nested entries", () => {
    const binary = Buffer.from(
      Array.from({ length: 5000 }, (_, i) => (i * 7) % 256),
    );
    const zip = writeZip([
      { name: "bundle/index.html", data: "<!doctype html><p>héllo</p>" },
      { name: "bundle/captures/v1/home.png", data: binary },
      { name: "bundle/empty.txt", data: "" },
      { name: "bundle/repeat.txt", data: "abc".repeat(10_000) },
    ]);
    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual([
      "bundle/index.html",
      "bundle/captures/v1/home.png",
      "bundle/empty.txt",
      "bundle/repeat.txt",
    ]);
    expect(entries.get("bundle/index.html")!.toString("utf8")).toBe(
      "<!doctype html><p>héllo</p>",
    );
    expect(entries.get("bundle/captures/v1/home.png")!.equals(binary)).toBe(
      true,
    );
    expect(entries.get("bundle/empty.txt")!.length).toBe(0);
    expect(entries.get("bundle/repeat.txt")!.toString()).toBe(
      "abc".repeat(10_000),
    );
    // Compressible text is deflated, so the archive is far smaller.
    expect(zip.length).toBeLessThan(5000 + 30_000);
  });

  it("rejects unsafe entry names and corrupt archives", () => {
    expect(() => writeZip([{ name: "../escape", data: "x" }])).toThrow(
      /entry name/,
    );
    expect(() => writeZip([{ name: "/abs", data: "x" }])).toThrow(/entry name/);
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(/zip/i);
    const zip = writeZip([{ name: "a.txt", data: "hello hello hello" }]);
    const corrupt = Buffer.from(zip);
    // Flip a byte in the stored data; the CRC check must catch it.
    corrupt[30 + "a.txt".length + 2] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow();
  });

  it.runIf(hasUnzip())("is readable by the system unzip", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tests/.feedback-data-zip-"));
    try {
      const file = join(dir, "test.zip");
      await writeFile(
        file,
        writeZip([
          { name: "folder/a.txt", data: "alpha ".repeat(100) },
          { name: "folder/b.bin", data: Buffer.from([0, 1, 2, 3]) },
        ]),
      );
      const listing = execFileSync("unzip", ["-l", file], {
        encoding: "utf8",
      });
      expect(listing).toContain("folder/a.txt");
      expect(listing).toContain("folder/b.bin");
      execFileSync("unzip", ["-tq", file]);
      expect(
        execFileSync("unzip", ["-p", file, "folder/a.txt"], {
          encoding: "utf8",
        }),
      ).toBe("alpha ".repeat(100));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

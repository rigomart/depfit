/** SIGKILL at the cache's publish points leaves nothing partial (SPEC.md, "Cache (#8)", K3). */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCache } from "../src/collect/cache.ts";

const PAUSE = join(import.meta.dirname, "fixtures/cache/pause-at.mjs");
const COLLECT = join(import.meta.dirname, "../src/collect");

async function killAt(dir: string, hook: string): Promise<void> {
  const child = spawn(process.execPath, [PAUSE, dir, hook, COLLECT], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("paused")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`exited ${code} before pausing`)));
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

describe("a call killed while publishing", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "depfit-cache-kill-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("between writing a part to tmp/ and linking it: no part, and its staging is removed", async () => {
    await killAt(dir, "beforeLink");
    const cache = await openCache({ dir });
    if (!cache) throw new Error("no cache");
    expect(await cache.read("facts", "k", "1.0.0", "key")).toBeNull();
    expect((await readdir(join(cache.root, "tmp"))).length).toBeGreaterThan(0);
    await cache.evict();
    expect(await readdir(join(cache.root, "tmp"))).toEqual([]);
    await cache.write("facts", "k", "1.0.0", "key", { n: 2 });
    expect(await cache.read("facts", "k", "1.0.0", "key")).toEqual({ n: 2 });
  }, 60_000);

  it("between an install's size record and its rename: no install, and its staging is removed", async () => {
    await killAt(dir, "beforeRename");
    const cache = await openCache({ dir });
    if (!cache) throw new Error("no cache");
    expect(await readdir(join(cache.root, "installs"))).toEqual([]);
    await cache.evict();
    expect(await readdir(join(cache.root, "tmp"))).toEqual([]);
  }, 60_000);
});

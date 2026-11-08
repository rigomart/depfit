import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundleWorkers, createVitePool, type VitePool } from "../src/collect/vite-pool.ts";

const runner = (name: string) =>
  fileURLToPath(new URL(`./fixtures/runner/${name}`, import.meta.url));

type Rule = {
  match: string;
  delayMs?: number;
  crash?: string;
  hang?: boolean;
  unreadable?: boolean;
};

const dirs: string[] = [];
const pools: VitePool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(rules: Rule[] = [], exports: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-pool-test-"));
  dirs.push(dir);
  await writeFile(join(dir, "runner-rules.json"), JSON.stringify({ exports, rules }));
  return dir;
}

function pool(options: Parameters<typeof createVitePool>[0]): VitePool {
  const created = createVitePool({ script: runner("scripted.mjs"), ...options });
  pools.push(created);
  return created;
}

async function log(dir: string): Promise<Array<{ source: string; pid: number }>> {
  const text = await readFile(join(dir, "runner-log.txt"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const at = line.lastIndexOf(" ");
      return { source: JSON.parse(line.slice(0, at)), pid: Number(line.slice(at + 1)) };
    });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const build = (target: VitePool, root: string, source: string, signal?: AbortSignal) =>
  target.build({ root, source, peers: [], signal });

describe("bundleWorkers", () => {
  it("gives a third of the cores, at least one per candidate, at most 4", () => {
    const at = (candidates: number, cores: number) => bundleWorkers(candidates, {}, cores);
    expect(at(1, 12)).toBe(4);
    expect(at(1, 8)).toBe(2);
    expect(at(1, 4)).toBe(1);
    expect(at(2, 4)).toBe(2);
    expect(at(6, 4)).toBe(4);
    expect(at(0, 1)).toBe(1);
    expect(at(1, 64)).toBe(4);
  });

  it("takes DEPFIT_BUNDLE_WORKERS from 1 to 4 instead, and ignores anything else", () => {
    expect(bundleWorkers(1, { DEPFIT_BUNDLE_WORKERS: "2" }, 12)).toBe(2);
    expect(bundleWorkers(3, { DEPFIT_BUNDLE_WORKERS: "1" }, 12)).toBe(1);
    expect(bundleWorkers(1, { DEPFIT_BUNDLE_WORKERS: "8" }, 12)).toBe(4);
    expect(bundleWorkers(1, { DEPFIT_BUNDLE_WORKERS: "x" }, 4)).toBe(1);
  });
});

describe("createVitePool", () => {
  it("starts a worker only when a build waits and every live worker is busy", async () => {
    const dir = await scratch();
    const workers = pool({ size: 4 });
    expect(workers.stats.started).toBe(0);
    for (const n of [1, 2, 3]) await build(workers, dir, `build ${n}\n`);
    expect(workers.stats.started).toBe(1);
    workers.warm();
    expect(workers.stats.started).toBe(1);
  });

  it("runs builds at the same time, up to its size", async () => {
    const dir = await scratch([{ match: "slow", delayMs: 400 }]);
    const workers = pool({ size: 4 });
    const started = performance.now();
    await Promise.all(Array.from({ length: 8 }, (_, n) => build(workers, dir, `slow ${n}\n`)));
    expect(
      performance.now() - started,
      "2 rounds of 400 ms on 4 workers, not 3.2 s serial",
    ).toBeLessThan(2400);
    expect(workers.stats.started).toBe(4);
    expect(workers.stats.peakLive).toBe(4);
  });

  it("writes each build's entry under the root in its worker's own directory", async () => {
    const dir = await scratch();
    const workers = pool({ size: 2 });
    await Promise.all([build(workers, dir, "first\n"), build(workers, dir, "second\n")]);
    expect((await log(dir)).map((entry) => entry.source).sort()).toEqual(["first\n", "second\n"]);
  });

  it("replaces a worker after its builds, and counts a retiring worker until it exits", async () => {
    const dir = await scratch();
    const workers = createVitePool({
      size: 1,
      buildsPerWorker: 2,
      script: runner("slow-exit.mjs"),
    });
    pools.push(workers);
    for (const n of [1, 2, 3, 4, 5]) await build(workers, dir, `build ${n}\n`);
    expect(workers.stats.started).toBe(3);
    expect(workers.stats.peakLive, "a replacement waits for its 500 ms retiring predecessor").toBe(
      1,
    );
  });

  it("kills a retiring worker that does not exit, so the next build still runs", async () => {
    const dir = await scratch();
    const workers = createVitePool({
      size: 1,
      buildsPerWorker: 1,
      closeGraceMs: 300,
      script: runner("ignore-end.mjs"),
    });
    pools.push(workers);
    await build(workers, dir, "first\n");
    const started = performance.now();
    await expect(build(workers, dir, "second\n")).resolves.toMatchObject({ errors: null });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(workers.stats.started).toBe(2);
    expect(workers.stats.peakLive).toBe(1);
  });

  it("counts the timeout from when a worker takes the build, not from when it was queued", async () => {
    const dir = await scratch([{ match: "slow", delayMs: 800 }]);
    const workers = pool({ size: 1, timeoutMs: 1500 });
    const results = await Promise.allSettled([
      build(workers, dir, "slow 1\n"),
      build(workers, dir, "slow 2\n"),
    ]);
    expect(
      results.map((result) => result.status),
      "1.6 s from queueing, 0.8 s from sending, limit 1.5 s",
    ).toEqual(["fulfilled", "fulfilled"]);
  });

  it("ends a worker whose build times out, and builds the rest on a new one", async () => {
    const dir = await scratch([{ match: "hang", hang: true }]);
    const workers = pool({ size: 1, timeoutMs: 1500 });
    await expect(build(workers, dir, "hang\n")).rejects.toThrow(/timed out/);
    await expect(build(workers, dir, "fine\n")).resolves.toMatchObject({ errors: null });
    expect(workers.stats.started).toBe(2);
    await workers.close();
    expect(workers.stats.pids.filter(alive)).toEqual([]);
  });

  it("rejects the build of a worker that exits or prints an unreadable result, and goes on", async () => {
    const dir = await scratch([
      { match: "crash", crash: "crashed on purpose" },
      { match: "garble", unreadable: true },
    ]);
    const workers = pool({ size: 1 });
    await expect(build(workers, dir, "crash\n")).rejects.toThrow(
      /vite build exited 1: crashed on purpose/,
    );
    await expect(build(workers, dir, "garble\n")).rejects.toThrow(/unreadable result/);
    await expect(build(workers, dir, "fine\n")).resolves.toMatchObject({ errors: null });
    expect(workers.stats.started).toBe(3);
  });

  it("rejects a build when its worker cannot start", async () => {
    const dir = await scratch();
    const workers = createVitePool({ size: 1, script: join(dir, "missing.mjs") });
    pools.push(workers);
    await expect(build(workers, dir, "x\n")).rejects.toThrow(/vite build exited/);
  });

  it("drops a queued build when its signal aborts, and never builds it", async () => {
    const dir = await scratch([{ match: "slow", delayMs: 200 }]);
    const workers = pool({ size: 1 });
    const abort = new AbortController();
    const first = build(workers, dir, "slow\n");
    const dropped = build(workers, dir, "dropped\n", abort.signal);
    abort.abort(new Error("not needed"));
    await expect(dropped).rejects.toThrow("not needed");
    await first;
    expect((await log(dir)).map((entry) => entry.source)).toEqual(["slow\n"]);
  });

  it("takes the newest build first when asked to (the eval's reversed schedule)", async () => {
    const dir = await scratch([{ match: "first", delayMs: 100 }]);
    const workers = pool({ size: 1, lifo: true });
    await Promise.all(["first", "a", "b", "c"].map((name) => build(workers, dir, `${name}\n`)));
    expect((await log(dir)).map((entry) => entry.source)).toEqual(["first\n", "c\n", "b\n", "a\n"]);
  });

  it("kills a worker that ignores the end of its input, after the grace period", async () => {
    const dir = await scratch();
    const workers = createVitePool({
      size: 1,
      script: runner("ignore-end.mjs"),
      closeGraceMs: 300,
    });
    await build(workers, dir, "x\n");
    const started = performance.now();
    await workers.close();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(workers.stats.pids.filter(alive)).toEqual([]);
  });

  it("rejects builds after close, and leaves no worker running", async () => {
    const dir = await scratch();
    const workers = pool({ size: 2 });
    await Promise.all([build(workers, dir, "a\n"), build(workers, dir, "b\n")]);
    await workers.close();
    expect(workers.stats.pids.filter(alive)).toEqual([]);
    await expect(build(workers, dir, "c\n")).rejects.toThrow(/closed/);
  });
});

describe("every child stops when depfit is signalled", () => {
  const script = fileURLToPath(new URL("./fixtures/pool-signal.ts", import.meta.url));

  async function signalled(stage: string, signal: NodeJS.Signals, env: NodeJS.ProcessEnv = {}) {
    const dir = await scratch([{ match: "build", hang: true }]);
    const child = spawn(process.execPath, [script, stage, dir], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    const pids = await new Promise<number[]>((resolve, reject) => {
      child.stdout.on("data", (data: string) => {
        out += data;
        if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))));
      });
      child.once("exit", () => reject(new Error(`exited before reporting: ${out}`)));
    });
    expect(pids.length).toBeGreaterThan(0);
    expect(pids.filter(alive)).toEqual(pids);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(signal);
    await exited;
    for (let tries = 0; tries < 150 && pids.some(alive); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return pids.filter(alive);
  }

  it("stops a worker that is starting, on SIGINT", async () => {
    expect(await signalled("startup", "SIGINT")).toEqual([]);
  });

  it("stops workers in the middle of builds, on SIGTERM", async () => {
    expect(await signalled("builds", "SIGTERM")).toEqual([]);
  });

  it("stops a retiring worker that ignores the end of its input, on SIGTERM", async () => {
    expect(await signalled("recycle", "SIGTERM")).toEqual([]);
  });

  it("kills a worker that ignores SIGTERM, after the grace period", async () => {
    expect(await signalled("resistant", "SIGTERM")).toEqual([]);
  });

  it("stops npm and what it started, in the middle of an install, on SIGINT", async () => {
    const bin = await mkdtemp(join(tmpdir(), "depfit-fake-npm-"));
    dirs.push(bin);
    const pidFile = join(bin, "npm.pid");
    await writeFile(
      join(bin, "npm"),
      '#!/bin/sh\nsleep 60 &\necho "$$ $!" > "$NPM_PID_FILE"\nwait\n',
    );
    await chmod(join(bin, "npm"), 0o755);
    const left = await signalled("install", "SIGINT", {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      NPM_PID_FILE: pidFile,
    });
    expect(left).toEqual([]);
  });
});

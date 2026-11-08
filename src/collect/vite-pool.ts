/**
 * A pool of Vite worker processes (`vite-build.mjs` children, see bundle.ts) shared by every
 * candidate of one depfit run (eval/bundle/SPEC.md, "Parallel builds (#7)"). Builds wait in one
 * queue; a worker starts only when a build waits and every live worker is busy, up to `size`, and is
 * replaced after `buildsPerWorker` builds because a worker's memory grows with every build. A
 * retiring worker counts toward `size` until it has exited, and is killed if it has not exited
 * `closeGraceMs` after its input ended, so a worker that ignores the end of its input cannot hold
 * its place. Each worker writes its builds' entry in
 * its own directory under the install root, under the one entry file name, so no two builds in
 * flight share a file and the output does not depend on which worker built it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY_FILE, startViteRunner, type ViteBuildResult, type ViteRunner } from "./bundle.ts";

/** At most this many workers: more bought little and cost memory (SPEC.md, "Worker count"). */
export const MAX_WORKERS = 4;

export const BUILDS_PER_WORKER = 100;

/** How long a retiring worker (or `close`) lets a worker end on its own before killing it. */
const CLOSE_GRACE_MS = 2000;

/**
 * Workers for a call with `candidates` npm candidates: `min(4, max(floor(cores / 3), candidates))`,
 * at least 1, so a call never runs fewer builds at once than one process per candidate did, and adds
 * at most one worker per three cores beyond that. `DEPFIT_BUNDLE_WORKERS` (1 to 4) sets the count
 * instead: an eval and CI switch.
 */
export function bundleWorkers(
  candidates: number,
  env: Record<string, string | undefined> = process.env,
  cores: number = availableParallelism(),
): number {
  const forced = env.DEPFIT_BUNDLE_WORKERS;
  if (forced !== undefined && /^[1-4]$/.test(forced)) return Number(forced);
  return Math.min(MAX_WORKERS, Math.max(1, Math.floor(cores / 3), candidates));
}

/** One build: `source` is the entry module, built from the install at `root`. */
export type PoolBuild = {
  root: string;
  source: string;
  peers: string[];
  exports?: boolean;
  /** Aborting drops the build if it is still queued; a build already running finishes. */
  signal?: AbortSignal;
};

export type PoolStats = { started: number; peakLive: number; pids: number[] };

export type VitePool = {
  build: (request: PoolBuild) => Promise<ViteBuildResult>;
  /** Starts one worker if none is live, so Vite's start-up overlaps an install. */
  warm: () => void;
  /** Ends every worker (killing any still running after the grace period) and waits for them. */
  close: () => Promise<void>;
  stats: PoolStats;
};

type Worker = { id: number; runner: ViteRunner; builds: number };

type Job = {
  request: PoolBuild;
  resolve: (result: ViteBuildResult) => void;
  reject: (error: unknown) => void;
};

/** Unique in the process, so two pools building in one install never share an entry file. */
let nextWorkerId = 0;

export function createVitePool({
  size,
  script,
  buildsPerWorker = BUILDS_PER_WORKER,
  timeoutMs,
  closeGraceMs = CLOSE_GRACE_MS,
  lifo = false,
}: {
  size: number;
  /** A stand-in for vite-build.mjs (tests). */
  script?: string;
  buildsPerWorker?: number;
  timeoutMs?: number;
  closeGraceMs?: number;
  /** Takes the newest queued build first (the eval's reversed schedule). */
  lifo?: boolean;
}): VitePool {
  const queue: Job[] = [];
  const idle: Worker[] = [];
  /** Started and not yet exited: busy, idle or retiring. */
  const live = new Set<Worker>();
  const stats: PoolStats = { started: 0, peakLive: 0, pids: [] };
  let closed = false;

  const start = (): Worker => {
    const runner = startViteRunner(tmpdir(), script, timeoutMs === undefined ? {} : { timeoutMs });
    const worker: Worker = { id: nextWorkerId++, runner, builds: 0 };
    live.add(worker);
    stats.started += 1;
    stats.peakLive = Math.max(stats.peakLive, live.size);
    if (runner.pid !== undefined) stats.pids.push(runner.pid);
    void runner.exited.then(() => {
      live.delete(worker);
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
      pump();
    });
    return worker;
  };

  const retire = (worker: Worker) => {
    worker.runner.close();
    const deadline = setTimeout(() => worker.runner.kill(), closeGraceMs);
    void worker.runner.exited.then(() => clearTimeout(deadline));
  };

  const run = async (worker: Worker, job: Job) => {
    const { root, source, peers, exports } = job.request;
    try {
      const dir = join(root, `.depfit-w${worker.id}`);
      await mkdir(dir, { recursive: true });
      const entry = join(dir, ENTRY_FILE);
      await writeFile(entry, source);
      job.resolve(await worker.runner.build({ root, entry, peers, exports }));
    } catch (error) {
      job.reject(error);
    }
    worker.builds += 1;
    if (worker.runner.failed) worker.runner.kill();
    else if (closed || worker.builds >= buildsPerWorker) retire(worker);
    else idle.push(worker);
    pump();
  };

  function pump(): void {
    while (queue.length) {
      let worker = idle.shift();
      if (!worker) {
        if (closed || live.size >= size) return;
        worker = start();
      }
      const job = lifo ? queue.pop() : queue.shift();
      if (job) void run(worker, job);
    }
  }

  return {
    build: (request) =>
      new Promise<ViteBuildResult>((resolve, reject) => {
        const { signal } = request;
        if (closed) return reject(new Error("vite pool closed"));
        if (signal?.aborted) return reject(signal.reason);
        const job: Job = { request, resolve, reject };
        queue.push(job);
        signal?.addEventListener(
          "abort",
          () => {
            const at = queue.indexOf(job);
            if (at < 0) return;
            queue.splice(at, 1);
            reject(signal.reason);
          },
          { once: true },
        );
        pump();
      }),
    warm: () => {
      if (closed || live.size > 0) return;
      idle.push(start());
    },
    close: async () => {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error("vite pool closed"));
      for (const worker of idle.splice(0)) retire(worker);
      const ending = [...live];
      const deadline = setTimeout(() => {
        for (const worker of ending) worker.runner.kill();
      }, closeGraceMs);
      await Promise.all(ending.map((worker) => worker.runner.exited));
      clearTimeout(deadline);
    },
    stats,
  };
}

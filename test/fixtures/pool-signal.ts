/**
 * Run by test/vite-pool.test.ts in a process of its own. Starts the processes depfit starts at the
 * stage named by argv[2], in the directory argv[3], prints their PIDs as one JSON line, and waits to
 * be signalled:
 * - `startup`: a warmed pool, its one worker just started;
 * - `builds`: two builds running on two workers (the directory's runner rules make them hang);
 * - `recycle`: a worker retiring after its one build that ignores the end of its input;
 * - `install`: an install whose npm (a stand-in first on PATH) never finishes; the stand-in writes
 *   its PID to the file `NPM_PID_FILE` names.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withIsolatedInstall } from "../../src/collect/install.ts";
import { createVitePool } from "../../src/collect/vite-pool.ts";

const [stage, root = "."] = process.argv.slice(2);
const runner = (name: string) => fileURLToPath(new URL(`./runner/${name}`, import.meta.url));
const report = (pids: number[]) => process.stdout.write(`${JSON.stringify(pids)}\n`);
const until = async (check: () => Promise<boolean>) => {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 20));
};

if (stage === "startup") {
  const pool = createVitePool({ size: 2, script: runner("scripted.mjs") });
  pool.warm();
  report(pool.stats.pids);
} else if (stage === "builds") {
  const pool = createVitePool({ size: 2, script: runner("scripted.mjs") });
  for (const n of [1, 2]) {
    pool.build({ root, source: `build ${n}\n`, peers: [] }).catch(() => {});
  }
  const log = join(root, "runner-log.txt");
  await until(async () => (await readFile(log, "utf8").catch(() => "")).split("\n").length > 2);
  report(pool.stats.pids);
} else if (stage === "recycle") {
  const pool = createVitePool({ size: 1, buildsPerWorker: 1, script: runner("ignore-end.mjs") });
  await pool.build({ root, source: "build\n", peers: [] });
  report(pool.stats.pids);
} else if (stage === "install") {
  const pidFile = process.env.NPM_PID_FILE ?? join(root, "npm.pid");
  withIsolatedInstall("x", "1.0.0", async () => {}).catch(() => {});
  await until(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim() !== "");
  report([Number((await readFile(pidFile, "utf8")).trim())]);
}
setInterval(() => {}, 1000);

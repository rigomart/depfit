/**
 * Runs every probe in eval/probes.json (local, gitignored; see probes.example.json) through the CLI
 * and saves JSON + table output to eval/results/.
 *   bun eval/run.ts [project...]
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderTable } from "../src/render/table.ts";
import type { Report } from "../src/report.ts";

const run = promisify(execFile);
type Probe = { project: string; cwd: string; packages: string[]; question: string };

const only = process.argv.slice(2);
const probes = (JSON.parse(await readFile("eval/probes.json", "utf8")) as Probe[]).filter(
  (p) => !only.length || only.includes(p.project),
);
const cli = join(import.meta.dirname, "../src/cli.ts");
const counters = new Map<string, number>();

for (const probe of probes) {
  const n = (counters.get(probe.project) ?? 0) + 1;
  counters.set(probe.project, n);
  const cwd = probe.cwd.replace(/^~/, homedir());
  const dir = join("eval/results", probe.project);
  await mkdir(dir, { recursive: true });
  const started = performance.now();
  const json = await run("bun", [cli, ...probe.packages, "--json"], { cwd, maxBuffer: 1 << 26 });
  const table = renderTable(JSON.parse(json.stdout) as Report, { width: 140, color: false });
  const base = join(dir, `${n}-${probe.packages.join("-vs-").replaceAll("/", "_")}`);
  await writeFile(`${base}.json`, json.stdout);
  await writeFile(`${base}.txt`, `# ${probe.question}\n\n${table}`);
  await writeFile(`${base}.question.txt`, probe.question);
  console.log(
    `${probe.project} #${n} ${probe.packages.join(" ")}: ${Math.round(performance.now() - started)}ms`,
  );
}

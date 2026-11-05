/**
 * Runs the probes in eval/probes.json (local, gitignored; see probes.example.json) through the CLI
 * and saves JSON + table output to eval/results/. A probe with `bundle_entries` also gets
 * `<base>.snippets.json`: each snippet measured through the eval-only snippet engine
 * (`snippet-bundle.ts`) at the version the report chose. That is real usage, the ground truth
 * for eval/bundle/SPEC.md; the CLI itself takes no snippets.
 *   bun eval/run.ts [--set <name>] [project...]
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { parseSpec } from "../src/collect/registry.ts";
import { errorMessage } from "../src/collect/util.ts";
import { renderTable } from "../src/render/table.ts";
import type { Report } from "../src/report.ts";
import { measureSnippet, parseSnippets, type SnippetBundle } from "./snippet-bundle.ts";

const run = promisify(execFile);
type Probe = {
  project: string;
  cwd: string;
  packages: string[];
  question: string;
  /** Probe set, e.g. "round-4" or "holdout-1". */
  set?: string;
  /** Import snippets of real usage, at most one per candidate (eval only). */
  bundle_entries?: string[];
};

type SnippetResult = (SnippetBundle | { name: string; error: string }) & { requested: string };

/** Each requested package with a snippet, as v5 did: `zod@^3 zod@^4` measure one snippet twice. */
async function measureSnippets(report: Report, snippets: string[]): Promise<SnippetResult[]> {
  const names = report.packages.flatMap((p) => (p.kind === "npm" ? [p.name] : []));
  const entries = await parseSnippets(snippets, [...new Set(names)]);
  const results: SnippetResult[] = [];
  for (const { requested, name, version } of report.packages) {
    const entry = entries.get(name);
    if (!entry) continue;
    if (version === null) {
      results.push({ requested, name, error: "the report has no version for this package" });
      continue;
    }
    try {
      results.push({ requested, ...(await measureSnippet(name, version, entry)) });
    } catch (error) {
      results.push({ requested, name, error: errorMessage(error) });
    }
  }
  return results;
}

const { values, positionals: only } = parseArgs({
  allowPositionals: true,
  options: { set: { type: "string" } },
});
const all = JSON.parse(await readFile("eval/probes.json", "utf8")) as Probe[];
// Numbered per project over the whole file, so a filtered run writes the same file names.
const counters = new Map<string, number>();
const probes = all
  .map((probe) => {
    const n = (counters.get(probe.project) ?? 0) + 1;
    counters.set(probe.project, n);
    return { probe, n };
  })
  .filter(
    ({ probe }) =>
      (!only.length || only.includes(probe.project)) &&
      (values.set === undefined || probe.set === values.set),
  );
const cli = join(import.meta.dirname, "../src/cli.ts");

for (const { probe, n } of probes) {
  const snippets = probe.bundle_entries ?? [];
  // Fail on an invalid snippet before spending a CLI run on the probe.
  await parseSnippets(snippets, [...new Set(probe.packages.map((spec) => parseSpec(spec).name))]);
  const cwd = probe.cwd.replace(/^~/, homedir());
  const dir = join("eval/results", probe.project);
  await mkdir(dir, { recursive: true });
  const started = performance.now();
  const json = await run("bun", [cli, ...probe.packages, "--json"], { cwd, maxBuffer: 1 << 26 });
  const report = JSON.parse(json.stdout) as Report;
  const base = join(dir, `${n}-${probe.packages.join("-vs-").replaceAll("/", "_")}`);
  await writeFile(`${base}.json`, json.stdout);
  const table = renderTable(report, { width: 140, color: false });
  await writeFile(`${base}.txt`, `# ${probe.question}\n\n${table}`);
  if (snippets.length) {
    const measured = await measureSnippets(report, snippets);
    await writeFile(`${base}.snippets.json`, `${JSON.stringify(measured, null, 2)}\n`);
  }
  await writeFile(`${base}.question.txt`, probe.question);
  console.log(
    `${probe.project} #${n} ${probe.packages.join(" ")}: ${Math.round(performance.now() - started)}ms`,
  );
  // npm's downloads API rate-limits bursts; one-off CLI runs never hit this.
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

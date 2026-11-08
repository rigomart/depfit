/**
 * Runs the probes in eval/probes.json (local, gitignored; see probes.example.json) through the CLI
 * and saves JSON + table output under `--out` (default eval/results/). A probe with snippets
 * (`bundle_entries`, or its entry in the local eval/snippets.json) also gets
 * `<base>.snippets.json`: each snippet measured through the eval-only snippet engine
 * (`snippet-bundle.ts`) at the version the report chose. That is real usage, the ground truth
 * for eval/bundle/SPEC.md; the CLI itself takes no snippets.
 *
 * Every install is frozen: the CLI and the snippet engine run with `DEPFIT_LOCK_DIR` set to
 * `--locks` (default `<out>/locks`), so each candidate's resolved tree is saved there as an npm
 * lockfile the first time, and replayed with `npm ci` by every later run that names the same
 * directory. Set `DEPFIT_BUNDLE=0` to collect with bundling off (gate E).
 *
 * `--revisions <file>` (eval/bundle/SPEC.md, holdout-2 freeze) measures each project at the git
 * revision recorded there (`[{ cwd, head, worktree_sha256 }]`, local). A project still at that
 * revision with the same working tree runs in place. A project that was clean then and has moved
 * since runs from a `git archive` of the recorded revision in a temp dir; the project itself is
 * only read. Anything else stops the run.
 *   bun eval/run.ts [--set <name>] [--out <dir>] [--locks <dir>] [--no-snippets] [--revisions <file>] [project...]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
  options: {
    set: { type: "string" },
    out: { type: "string", default: "eval/results" },
    locks: { type: "string" },
    "no-snippets": { type: "boolean", default: false },
    revisions: { type: "string" },
  },
});
const OUT = values.out;
const LOCKS = resolve(values.locks ?? join(OUT, "locks"));
process.env.DEPFIT_LOCK_DIR = LOCKS;
const all = JSON.parse(await readFile("eval/probes.json", "utf8")) as Probe[];

/**
 * Snippets kept apart from probes.json (so the frozen holdout entries keep their sha256), keyed
 * by "<project> <packages...>". Optional.
 */
const extraSnippets = await readFile("eval/snippets.json", "utf8").then(
  (text) => (JSON.parse(text) as { snippets: Record<string, string[]> }).snippets,
  () => ({}) as Record<string, string[]>,
);

/** Side-effect imports of .css files are removed from ground-truth snippets: non-JS output is out of scope. */
const withoutCss = (snippet: string) =>
  snippet.replace(/import\s+["'][^"']+\.css["'];?\s*/g, "").trim();

const snippetsOf = (probe: Probe) =>
  (probe.bundle_entries ?? extraSnippets[[probe.project, ...probe.packages].join(" ")] ?? []).map(
    withoutCss,
  );
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

/**
 * sha256 of a project's uncommitted state as the holdout-2 freeze recorded it: its diff against
 * HEAD, then the name of each untracked file (one per line). File contents of untracked files are
 * not part of it.
 */
async function worktreeSha256(dir: string): Promise<string> {
  const git = (args: string[]) => run("git", ["-C", dir, ...args], { maxBuffer: 1 << 28 });
  const hash = createHash("sha256");
  hash.update((await git(["diff", "HEAD"])).stdout);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).stdout;
  for (const file of untracked.split("\0").filter(Boolean)) hash.update(`${file}\n`);
  return hash.digest("hex");
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const exported = new Map<string, string>();
const scratch: string[] = [];

/**
 * Where to run a probe: its own directory when the project is at its recorded revision with the
 * same working tree; else, for a project that was clean when recorded, the same directory inside a
 * `git archive` of that revision.
 */
async function frozenCwd(cwd: string): Promise<string> {
  if (!values.revisions) return cwd;
  const recorded = (
    JSON.parse(await readFile(values.revisions, "utf8")) as Array<{
      cwd: string;
      head: string;
      worktree_sha256: string;
    }>
  ).find((entry) => entry.cwd.replace(/^~/, homedir()) === cwd);
  if (!recorded) throw new Error(`${cwd}: no recorded revision`);
  const top = (await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
  const head = (await run("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
  if (head === recorded.head && (await worktreeSha256(cwd)) === recorded.worktree_sha256)
    return cwd;
  if (recorded.worktree_sha256 !== EMPTY_SHA256) {
    throw new Error(`${cwd}: moved since it was recorded, with uncommitted changes then`);
  }
  let root = exported.get(`${top} ${recorded.head}`);
  if (!root) {
    // A fixed path per project and revision, so every run reports the same project.root.
    const id = createHash("sha256").update(top).digest("hex").slice(0, 12);
    root = join(tmpdir(), "depfit-frozen", `${id}-${recorded.head.slice(0, 12)}`);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    scratch.push(root);
    await run("sh", [
      "-c",
      'git -C "$1" archive "$2" | tar -x -C "$3"',
      "sh",
      top,
      recorded.head,
      root,
    ]);
    exported.set(`${top} ${recorded.head}`, root);
    console.log(`${top}: measured at ${recorded.head} (exported; the project moved since)`);
  }
  return join(root, relative(top, cwd));
}
const timings: Array<{ project: string; n: number; packages: string[]; cli_ms: number }> = [];

for (const { probe, n } of probes) {
  const snippets = values["no-snippets"] ? [] : snippetsOf(probe);
  // Fail on an invalid snippet before spending a CLI run on the probe.
  await parseSnippets(snippets, [...new Set(probe.packages.map((spec) => parseSpec(spec).name))]);
  const cwd = await frozenCwd(probe.cwd.replace(/^~/, homedir()));
  const dir = join(OUT, probe.project);
  await mkdir(dir, { recursive: true });
  const started = performance.now();
  const json = await run("bun", [cli, ...probe.packages, "--json"], { cwd, maxBuffer: 1 << 26 });
  const cliMs = Math.round(performance.now() - started);
  timings.push({ project: probe.project, n, packages: probe.packages, cli_ms: cliMs });
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
await writeFile(join(OUT, "timings.json"), `${JSON.stringify(timings, null, 2)}\n`);
for (const dir of scratch) await rm(dir, { recursive: true, force: true });

/**
 * Gate H0 helper: writes the prompt a blind small-model reader is given, and the answer key that
 * reader never sees. Running the readers (3 runs, all 6 answers correct) is manual.
 *   bun eval/bundle/comprehension.ts [results.json] [caseId...]
 * The prompt holds depfit's `--json` output for three fixed cases (`COMPREHENSION_CASES`), the
 * output of `depfit --schema`, and six questions. The outputs come from the results file
 * (default: the latest `results/*.json`, which score.ts fills for those cases); a case missing
 * there is run live against the CLI instead. Naming case ids replaces the three fixed cases.
 * Writes results/comprehension/prompt.md and results/comprehension/comprehension-key.md.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { asArray, asRecord, isRecord } from "../../src/collect/util.ts";
import { CLI, COMPREHENSION_CASES, entryArgs, loadCases } from "./cases.ts";

const run = promisify(execFile);
const RESULTS_DIR = join(import.meta.dirname, "results");
const OUT_DIR = join(RESULTS_DIR, "comprehension");

const QUESTIONS = [
  "For sonner, what code does eager_js_gzip9_bytes include, and does it include react?",
  "Is that number what adding sonner would add to this repo's existing bundle?",
  "For shiki, what is the difference between the eager and lazy numbers, and which would a user download on first page load?",
  "For simple-git, why are the byte fields null, and what does the code in `unavailable` mean?",
  "Did depfit claim the measured package works in a browser?",
  "depfit gives @lydell/node-pty a bundle size. Does that mean it works in a browser? Which fields tell you whether it can?",
];

/** What a correct answer says. Never shown to the reader. */
const KEY = [
  "The snippet's imports and their transitive code, minified, gzip level 9. react is excluded as a peer and listed in `external_packages`.",
  "No. It is standalone, not marginal.",
  "Eager is the static closure, loaded first. Lazy is the dynamic-import chunks, loaded on demand. A user downloads the eager bytes on first page load.",
  "The build failed: simple-git imports Node built-ins (e.g. node:child_process) that cannot be resolved for the browser, so `UNRESOLVED_IMPORT` names the specifier and there is no honest number.",
  "No.",
  "No. The number is emitted bytes only, and makes no claim it runs. `cost.native_binaries` lists a platform-native binary, so it cannot run in a browser.",
];

const args = process.argv.slice(2);
const resultsArg = args.find((arg) => arg.endsWith(".json"));
const caseIds = args.filter((arg) => !arg.endsWith(".json"));

async function latestResults(): Promise<string | null> {
  const files = (await readdir(RESULTS_DIR).catch(() => []))
    .filter((name) => /^\d{4}-.*\.json$/.test(name))
    .sort();
  const latest = files.at(-1);
  return latest ? join(RESULTS_DIR, latest) : null;
}

/** The `--json` report each case stored in a results file, by case id. */
async function storedReports(file: string | null): Promise<Map<string, unknown>> {
  const reports = new Map<string, unknown>();
  if (!file) return reports;
  const parsed = asRecord(JSON.parse(await readFile(file, "utf8")));
  for (const item of asArray(parsed.cases).map(asRecord)) {
    if (isRecord(item.report) && typeof item.id === "string") reports.set(item.id, item.report);
  }
  return reports;
}

/** Runs the CLI on the case in an empty project, like score.ts does. */
async function liveReport(id: string): Promise<unknown> {
  const [c] = await loadCases([id]);
  if (!c) throw new Error(`unknown case ${id}`);
  const dir = await mkdtemp(join(tmpdir(), "depfit-h0-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "scratch", private: true }));
    const spec = `${c.package}@${c.version}`;
    const out = await run("bun", [CLI, spec, ...entryArgs(c.imports), "--json", "--cwd", dir], {
      maxBuffer: 1 << 26,
      timeout: 600_000,
    });
    return JSON.parse(out.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = resultsArg ? resolve(resultsArg) : await latestResults();
const stored = await storedReports(source);
const ids = caseIds.length ? caseIds : COMPREHENSION_CASES;

const sections: string[] = [];
for (const id of ids) {
  let report = stored.get(id);
  if (!report) {
    console.log(`${id}: not in ${source ?? "any results file"}, running the CLI`);
    report = await liveReport(id);
  } else console.log(`${id}: from ${source}`);
  sections.push(
    `## depfit --json output ${sections.length + 1}\n\n${JSON.stringify(report, null, 2)}`,
  );
}

const schema = await run("bun", [CLI, "--schema"], { maxBuffer: 1 << 24 });
const prompt = [
  ...sections,
  `## depfit --schema\n\n${schema.stdout.trim()}`,
  `## Questions\n\nAnswer from the material above.\n\n${QUESTIONS.map((q, i) => `(${i + 1}) ${q}`).join("\n")}`,
].join("\n\n");

await mkdir(OUT_DIR, { recursive: true });
const promptFile = join(OUT_DIR, "prompt.md");
const keyFile = join(OUT_DIR, "comprehension-key.md");
await writeFile(promptFile, `${prompt}\n`);
await writeFile(
  keyFile,
  `# H0 answer key (never shown to the reader)\n\n${KEY.map((answer, i) => `(${i + 1}) ${answer}`).join("\n")}\n`,
);
console.log(`wrote ${promptFile}\nwrote ${keyFile}`);

/**
 * Iteration 1's scorecard (SPEC.md, "Iteration 1: root entry point, two ways"): one subcommand per
 * group of gates. Writes results/root-<gate>-<timestamp>.json (gitignored) and prints the verdicts.
 *
 *   bun eval/bundle/root-score.ts probes [--on dir] [--again dir] [--off dir]   # D, E, R (+ F advisory)
 *   bun eval/bundle/root-score.ts singles                                       # B (single), C, D
 *   bun eval/bundle/root-score.ts wild [--resume]                               # B (whole), by W's conditions
 *   bun eval/bundle/root-score.ts nulls                                         # A (null cases)
 *   bun eval/bundle/root-score.ts signals                                       # S
 *   bun eval/bundle/root-score.ts cost [--locks dir]                            # F
 *   bun eval/bundle/root-score.ts comprehension                                 # H0 prompt and key
 *
 * `probes` reads three runs of eval/run.ts over the same frozen installs: `--on` (default
 * eval/results/v6), `--again` (a second run, for D) and `--off` (`DEPFIT_BUNDLE=0`, for E).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { externalPackages } from "../../src/collect/bundle.ts";
import { withIsolatedInstall } from "../../src/collect/install.ts";
import { loadProject } from "../../src/collect/project.ts";
import { measureRootEntry, rootEntryBundle } from "../../src/collect/root-entry.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  isRecord,
} from "../../src/collect/util.ts";
import { FIELD_DESCRIPTIONS } from "../../src/schema-docs.ts";
import { loadCases } from "./cases.ts";
import { firstDiff, NETWORK_ENTRY, withoutBundle } from "./contract.ts";
import {
  BYTE_FIELDS,
  type ByteField,
  depfit,
  GZIP_RUNTIME_TOLERANCE,
  grossError,
  hasCode,
  inBand,
  packageOf,
  referenceRanges,
  scratchProject,
} from "./harness.ts";
import { runWild } from "./wild-score.ts";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const REPO = join(HERE, "../..");
const RESULTS_DIR = join(HERE, "results");
const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");
const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

/** Every key `packages[].bundle` has (src/report.ts `Bundle`), from the schema docs. */
const BUNDLE_KEYS = Object.keys(FIELD_DESCRIPTIONS)
  .filter((path) => path.startsWith("packages[].bundle."))
  .map((path) => path.slice("packages[].bundle.".length))
  .sort();

async function save(gate: string, data: unknown): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS_DIR, `root-${gate}-${stamp}.json`);
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}

const bundleReasons = (pkg: Record<string, unknown>) =>
  asStringArray(pkg.unavailable).filter((entry) => entry.startsWith("bundle:"));

// --- probes: D, E, R --------------------------------------------------------------------------------

type ProbeFile = { project: string; base: string };

async function probeFiles(dir: string): Promise<ProbeFile[]> {
  const files: ProbeFile[] = [];
  for (const project of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!project.isDirectory() || project.name === "locks") continue;
    for (const name of (await readdir(join(dir, project.name))).sort()) {
      if (/^\d+-.*\.json$/.test(name) && !/\.(snippets|nobundle)\.json$/.test(name)) {
        files.push({ project: project.name, base: name.slice(0, -".json".length) });
      }
    }
  }
  return files;
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8").catch(() => "null"));

function failedIn(report: unknown): string[] {
  return asArray(asRecord(report).packages).flatMap((pkg) =>
    asStringArray(asRecord(pkg).unavailable).flatMap(
      (entry) => NETWORK_ENTRY.exec(entry)?.[1]?.toLowerCase() ?? [],
    ),
  );
}

/** Gate E's shape check of one package: every bundle key, or null with a reason that says why. */
function contractProblem(pkg: Record<string, unknown>): string | null {
  if (!("bundle" in pkg)) return "no bundle key";
  const reasons = bundleReasons(pkg);
  if (pkg.bundle === null) {
    if (pkg.error !== null || pkg.kind === "builtin") return null;
    if (pkg.cost === null) return null;
    return reasons.some((r) => r.startsWith("bundle: skipped")) ? null : "null bundle, no reason";
  }
  if (!isRecord(pkg.bundle)) return "bundle is not an object";
  const keys = Object.keys(pkg.bundle).sort();
  if (JSON.stringify(keys) !== JSON.stringify(BUNDLE_KEYS)) return `keys ${keys.join(",")}`;
  if (Object.values(pkg.bundle).some((value) => value === undefined)) return "undefined value";
  return null;
}

/** Miss classes for gate R (SPEC.md), assigned from the ground-truth snippet's shape alone. */
const FRAMEWORK_SUBPATH = /\/(react|preact|vue|svelte|solid|angular)$/;

function missClass(snippet: string, candidate: string): string | null {
  const sources = [...snippet.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
  const subpaths = sources.filter((source) => source !== candidate);
  if (subpaths.some((source) => FRAMEWORK_SUBPATH.test(source))) return "3 framework subpath";
  if (subpaths.length) return "1 subpath other than the root";
  if (/;\s*[A-Za-z_$][\w$]*\.[A-Za-z_$]/.test(snippet)) return "2 members of one export";
  return null;
}

type Candidate = {
  probe: string;
  name: string;
  version: string | null;
  real: number | null;
  real_reason: string | null;
  snippet: string | null;
  median: number | null;
  whole: number | null;
  bracketed: boolean | null;
  miss_class: string | null;
};

/** sha256 of the frozen holdout-1 probes (STATUS.md), checked before scoring. */
const HOLDOUT_SHA256 = "f792fac58becfaed39b978a33e2e118526652b9cb6c9214b424d9cf2461f8466";

/**
 * Coverage problems that fail a gate whatever its numbers: inputs that are missing or smaller than
 * the bar requires. Printed and saved with the scorecard.
 */
async function probeCoverage(files: ProbeFile[]): Promise<string[]> {
  const probes = asArray(await readJson(join(REPO, "eval", "probes.json"))).map(asRecord);
  const holdout = probes.filter((p) => p.set === "holdout-1");
  const sha = createHash("sha256").update(JSON.stringify(holdout)).digest("hex");
  const problems: string[] = [];
  if (sha !== HOLDOUT_SHA256) problems.push(`holdout-1 probes changed (sha256 ${sha})`);
  if (files.length !== probes.length) {
    problems.push(`${files.length} probe reports for ${probes.length} probes in eval/probes.json`);
  }
  return problems;
}

async function scoreProbes(options: { on: string; again: string; off: string }): Promise<void> {
  const files = await probeFiles(options.on).catch(() => []);
  const coverage = await probeCoverage(files);
  const dDiffs: string[] = [];
  const eShape: string[] = [];
  const eDiffs: string[] = [];
  const eFlakes: string[] = [];
  const candidates: Candidate[] = [];
  let packages = 0;
  for (const { project, base } of files) {
    const id = `${project}/${base}`;
    const on = await readJson(join(options.on, project, `${base}.json`));
    const again = await readJson(join(options.again, project, `${base}.json`));
    const off = await readJson(join(options.off, project, `${base}.json`));
    const onPackages = asArray(asRecord(on).packages).map(asRecord);
    const againPackages = asArray(asRecord(again).packages).map(asRecord);
    packages += onPackages.length;

    if (!on) coverage.push(`${id}: unreadable report`);
    if (!again) dDiffs.push(`${id}: no second run`);
    for (const [i, pkg] of onPackages.entries()) {
      const other = againPackages[i] ?? {};
      const a = JSON.stringify([pkg.version, pkg.bundle, bundleReasons(pkg)]);
      const b = JSON.stringify([other.version, other.bundle, bundleReasons(other)]);
      if (again && a !== b) dDiffs.push(`${id} ${asString(pkg.name)}: ${a} vs ${b}`);
    }

    for (const pkg of [...onPackages, ...againPackages]) {
      const problem = contractProblem(pkg);
      if (problem) eShape.push(`${id} ${asString(pkg.name)}: ${problem}`);
    }
    if (!off) eDiffs.push(`${id}: no bundling-off run`);
    else {
      const offRecord = asRecord(off);
      const diff = firstDiff(withoutBundle(offRecord), withoutBundle(asRecord(on)));
      if (diff) {
        const failed = new Set([...failedIn(on), ...failedIn(off)]);
        const rest = failed.size
          ? firstDiff(withoutBundle(offRecord, failed), withoutBundle(asRecord(on), failed))
          : diff;
        const text = `${id} ${diff.path}: ${JSON.stringify(diff.without_bundle)} vs ${JSON.stringify(diff.with_bundle)}`;
        (rest ? eDiffs : eFlakes).push(text);
      }
      const offBundles = asArray(offRecord.packages).map(asRecord);
      for (const pkg of offBundles) {
        if (pkg.bundle !== null)
          eDiffs.push(`${id} ${asString(pkg.name)}: bundle with DEPFIT_BUNDLE=0`);
      }
    }

    const snippets = asArray(
      await readJson(join(options.on, project, `${base}.snippets.json`)),
    ).map(asRecord);
    for (const pkg of onPackages) {
      if (pkg.kind !== "npm") continue;
      const name = asString(pkg.name) ?? "";
      const truth = snippets.find((s) => s.requested === pkg.requested);
      const bundle = asRecord(pkg.bundle);
      const real = asNumber(truth?.eager_js_gzip9_bytes);
      const median = asNumber(bundle.single_export_median_eager_js_gzip9_bytes);
      const whole = asNumber(bundle.whole_eager_js_gzip9_bytes);
      const snippet = asString(truth?.entry);
      const bracketed =
        real === null
          ? null
          : median !== null && whole !== null && real >= 0.9 * median && real <= 1.1 * whole;
      candidates.push({
        probe: id,
        name,
        version: asString(pkg.version),
        real,
        real_reason: truth
          ? ((asStringArray(truth.reasons).join("; ") || asString(truth.error)) ?? null)
          : "no snippet",
        snippet,
        median,
        whole,
        bracketed,
        miss_class: bracketed === false && snippet ? missClass(snippet, name) : null,
      });
    }
  }

  type Pair = { probe: string; a: string; b: string; agrees: boolean; miss_class: string | null };
  const pairs: Pair[] = [];
  const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const scored = candidates.filter((c) => c.real !== null && c.median !== null && c.whole !== null);
  for (const [i, a] of scored.entries()) {
    for (const b of scored.slice(i + 1)) {
      if (a.probe !== b.probe) continue;
      const way = sign((a.median ?? 0) - (b.median ?? 0));
      if (way === 0 || way !== sign((a.whole ?? 0) - (b.whole ?? 0))) continue;
      const [ra, rb] = [a.real ?? 0, b.real ?? 0];
      if (Math.max(ra, rb) < 1.1 * Math.min(ra, rb)) continue;
      const agrees = sign(ra - rb) === way;
      const cls = agrees
        ? null
        : (missClass(a.snippet ?? "", a.name) ?? missClass(b.snippet ?? "", b.name));
      pairs.push({ probe: a.probe, a: a.name, b: b.name, agrees, miss_class: cls });
    }
  }

  const withTruth = candidates.filter((c) => c.bracketed !== null);
  const bracketed = withTruth.filter((c) => c.bracketed);
  const misses = withTruth.filter((c) => !c.bracketed);
  const pairMisses = pairs.filter((p) => !p.agrees);
  const unclassified = [
    ...misses.filter((c) => !c.miss_class).map((c) => `${c.probe} ${c.name}`),
    ...pairMisses.filter((p) => !p.miss_class).map((p) => `${p.probe} ${p.a} vs ${p.b}`),
  ];
  const rBracket = bracketed.length >= 0.85 * withTruth.length;
  const rPairs = pairs.length === 0 || pairs.filter((p) => p.agrees).length >= 0.9 * pairs.length;

  const timings = async (dir: string) =>
    asArray(await readJson(join(dir, "timings.json"))).map(
      (t) => asNumber(asRecord(t).cli_ms) ?? 0,
    );
  const [onMs, offMs] = [await timings(options.on), await timings(options.off)];
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  const pass = (ok: boolean) => verdict(ok && coverage.length === 0);
  const lines = [
    `Iteration 1, probes: ${files.length} probes, ${packages} packages (${options.on})`,
    `  coverage: ${coverage.length} problems ${verdict(!coverage.length)} (every gate below fails while this does)`,
    ...coverage.map((c) => `    ${c}`),
    `  D. determinism vs ${options.again}: ${dDiffs.length} differences ${pass(!dDiffs.length)}`,
    ...dDiffs.map((d) => `    ${d}`),
    `  E. contract: ${eShape.length} shape problems, ${eDiffs.length} non-bundle differences with DEPFIT_BUNDLE=0 (${options.off}) ${pass(!eShape.length && !eDiffs.length)}; network flakes ${eFlakes.length}`,
    ...[...eShape, ...eDiffs].map((d) => `    ${d}`),
    ...eFlakes.map((d) => `    flake: ${d}`),
    `  R. real usage in [0.9 x median, 1.1 x whole]: ${bracketed.length}/${withTruth.length} (${pct(bracketed.length, withTruth.length)}, min 85%) ${pass(rBracket)}`,
    `     pairs pointing the same way with real usage >= 10% apart: ${pairs.filter((p) => p.agrees).length}/${pairs.length} agree (${pct(pairs.filter((p) => p.agrees).length, pairs.length)}, min 90%) ${pass(rPairs)}`,
    `     misses outside a named class: ${unclassified.length} ${pass(!unclassified.length)}`,
    ...misses.map(
      (c) =>
        `    miss ${c.probe} ${c.name}: real ${c.real} vs median ${c.median} / whole ${c.whole} [${c.miss_class ?? "UNCLASSIFIED"}] ${c.snippet}`,
    ),
    ...pairMisses.map(
      (p) => `    pair miss ${p.probe} ${p.a} vs ${p.b} [${p.miss_class ?? "UNCLASSIFIED"}]`,
    ),
    `     no ground truth (left out): ${
      candidates
        .filter((c) => c.bracketed === null)
        .map((c) => `${c.name} (${c.real_reason})`)
        .join(", ") || "none"
    }`,
    `  F (advisory). CLI wall time per probe, median: bundling on ${median(onMs)} ms, off ${median(offMs)} ms`,
  ];
  console.log(lines.join("\n"));
  await save("probes", {
    options,
    dDiffs,
    eShape,
    eDiffs,
    eFlakes,
    candidates,
    pairs,
    onMs,
    offMs,
  });
}

// --- singles: B (single export), C, D -----------------------------------------------------------------

const NPM_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];

/** Installs a frozen wild lock as reference.ts does (`npm ci`, peers left out). */
async function installFrozen(id: string, name: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-root-score-"));
  const lock = await readFile(join(HERE, "locks", "wild", `${id}.json`), "utf8");
  const dependencies = { [name]: version };
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "ref", private: true, dependencies }),
  );
  await writeFile(join(dir, "package-lock.json"), lock);
  await run("npm", ["ci", "--legacy-peer-deps", ...NPM_FLAGS], { cwd: dir, timeout: 300_000 });
  return dir;
}

type Bytes = Record<ByteField, number>;
const toBytes = (b: {
  eager_js_min_bytes: number;
  eager_js_gzip9_bytes: number;
  lazy_js_min_bytes: number;
  lazy_js_gzip9_bytes: number;
}): Bytes => ({
  min_bytes: b.eager_js_min_bytes,
  gzip_bytes: b.eager_js_gzip9_bytes,
  lazy_min_bytes: b.lazy_js_min_bytes,
  lazy_gzip_bytes: b.lazy_js_gzip9_bytes,
});

/** Gate C: minified bytes identical on all four fields, gzip within the runtime tolerance. */
function conformance(depfitBytes: Bytes, vite: unknown): string | null {
  const ref = asRecord(vite);
  for (const field of BYTE_FIELDS) {
    const r = asNumber(ref[field]);
    if (r === null) return `vite reference has no ${field} (${asString(ref.error) ?? "?"})`;
    const x = depfitBytes[field];
    const ok = field.includes("gzip") ? Math.abs(x - r) <= GZIP_RUNTIME_TOLERANCE * r : x === r;
    if (!ok) return `${field} ${x} vs vite ${r}`;
  }
  return null;
}

async function scoreSingles(): Promise<void> {
  const reference = asRecord(await readJson(join(HERE, "single-reference.json")));
  const packages = asArray(reference.packages).map(asRecord);
  const coverage: string[] = [];
  if (packages.length !== 20) coverage.push(`${packages.length} reference packages, not 20`);
  for (const pkg of packages) {
    const exports = asStringArray(pkg.exports);
    if (exports.length !== 5)
      coverage.push(`${asString(pkg.package)}: ${exports.length} exports, not 5`);
    for (const name of exports) {
      if (!isRecord(asRecord(pkg.singles)[name]))
        coverage.push(`${asString(pkg.package)} ${name}: no reference`);
    }
  }
  const wholeRefs = packages.filter((pkg) => "whole_vite" in pkg).length;
  if (wholeRefs !== 10) coverage.push(`${wholeRefs} whole-package Vite references, not 10`);
  const results: Record<string, unknown>[] = [];
  const bFail: string[] = [];
  const bGross: string[] = [];
  const cFail: string[] = [];
  const dFail: string[] = [];
  let singles = 0;
  let wholes = 0;
  for (const pkg of packages) {
    const id = asString(pkg.id) ?? "";
    const name = asString(pkg.package) ?? "";
    const version = asString(pkg.version) ?? "";
    const dir = await installFrozen(id, name, version);
    try {
      const manifest = asRecord(
        JSON.parse(await readFile(join(dir, "node_modules", name, "package.json"), "utf8")),
      );
      const externals = externalPackages(manifest);
      const first = await measureRootEntry(dir, name, externals);
      const second = await measureRootEntry(dir, name, externals);
      // Vite's import resolution order varies and the report sorts its reasons.
      const facts = (m: typeof first) =>
        JSON.stringify(
          [m.whole, ...(m.singles ?? []).map((s) => s.outcome)]
            .map((o) => [
              o.bytes,
              [...new Set(o.problems.map((p) => `${p.code} ${p.specifier ?? ""}`))].sort(),
            ])
            .concat([
              [
                m.names,
                [...new Set(m.listProblems.map((p) => `${p.code} ${p.specifier ?? ""}`))].sort(),
              ],
            ]),
        );
      if (facts(first) !== facts(second)) dFail.push(`${name}: two runs differ`);
      const byName = new Map((first.singles ?? []).map((s) => [s.name, s.outcome]));
      const refs = asRecord(pkg.singles);
      for (const exportName of asStringArray(pkg.exports)) {
        singles += 1;
        const label = `${name} ${exportName}`;
        const outcome = byName.get(exportName);
        const ref = asRecord(refs[exportName]);
        if (!outcome) {
          bFail.push(`${label}: not among depfit's ${first.names?.length ?? "?"} exports`);
          cFail.push(`${label}: not measured`);
          continue;
        }
        if (!outcome.bytes) {
          const codes = outcome.problems.map((p) => `${p.code} ${p.specifier ?? ""}`.trim());
          bFail.push(`${label}: null (${codes.join("; ")})`);
          cFail.push(`${label}: null`);
          continue;
        }
        const bytes = toBytes(outcome.bytes);
        const ranges = referenceRanges(ref);
        if (!ranges) bFail.push(`${label}: no reference built`);
        else {
          for (const field of BYTE_FIELDS) {
            const range = ranges[field];
            const text = `${label} ${field} ${bytes[field]} vs ${range.lo}..${range.hi}`;
            if (grossError(bytes[field], range)) bGross.push(text);
            if (!inBand(bytes[field], range)) bFail.push(text);
          }
        }
        const mismatch = conformance(bytes, ref.vite);
        if (mismatch) cFail.push(`${label}: ${mismatch}`);
        results.push({
          name,
          version,
          export: exportName,
          bytes,
          rollup: ref.rollup,
          webpack: ref.webpack,
          vite: ref.vite,
        });
      }
      if ("whole_vite" in pkg) {
        wholes += 1;
        if (!first.whole.bytes) cFail.push(`${name} (whole): null`);
        else {
          const mismatch = conformance(toBytes(first.whole.bytes), pkg.whole_vite);
          if (mismatch) cFail.push(`${name} (whole): ${mismatch}`);
        }
      }
      console.log(`${name}@${version}: ${first.names?.length ?? "?"} exports listed by depfit`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const pass = (ok: boolean) => verdict(ok && coverage.length === 0);
  const lines = [
    `Iteration 1, single exports: ${packages.length} packages, ${singles} exports, ${wholes} whole builds`,
    `  coverage: ${coverage.length} problems ${verdict(!coverage.length)} (every gate below fails while this does)`,
    ...coverage.map((c) => `    ${c}`),
    `  B (single). in the rollup/webpack band: ${singles - new Set(bFail.map((f) => f.split(" ").slice(0, 2).join(" "))).size}/${singles} ${pass(!bFail.length)}; gross errors ${bGross.length} ${pass(!bGross.length)}`,
    ...bFail.map((f) => `    ${f}`),
    `  C. equal to a stock vite build (min identical, gzip within ${GZIP_RUNTIME_TOLERANCE * 100}%): ${cFail.length} failures over ${singles} exports and ${wholes} whole builds ${pass(!cFail.length)}`,
    ...cFail.map((f) => `    ${f}`),
    `  D (singles). two runs per package: ${dFail.length} differences ${pass(!dFail.length)}`,
    ...dFail.map((f) => `    ${f}`),
  ];
  console.log(lines.join("\n"));
  await save("singles", { coverage, bFail, bGross, cFail, dFail, results });
}

// --- nulls: A -----------------------------------------------------------------------------------------

async function scoreNulls(): Promise<void> {
  const cases = (await loadCases()).filter(
    (c) => c.expect === "null" && c.step === "1" && c.target === "browser",
  );
  const rootCases = cases.filter((c) => c.imports.every((i) => i.from === c.package));
  const scratch = await scratchProject("browser", true);
  const results: Record<string, unknown>[] = [];
  const failures: string[] = [];
  try {
    for (const c of rootCases) {
      const cli = await depfit([`${c.package}@${c.version}`], scratch);
      const pkg = packageOf(cli.report) ?? {};
      const bundle = asRecord(pkg.bundle);
      const reasons = bundleReasons(pkg);
      const wholeNull = [
        "whole_eager_js_min_bytes",
        "whole_eager_js_gzip9_bytes",
        "whole_lazy_js_min_bytes",
        "whole_lazy_js_gzip9_bytes",
      ].every((key) => key in bundle && bundle[key] === null);
      const ok = isRecord(pkg.bundle) && wholeNull && hasCode(reasons, c);
      if (!ok)
        failures.push(
          `${c.id}: expected ${c.code} ${c.specifier ?? ""}, got ${reasons.join("; ") || "no reason"} (whole null: ${wholeNull})`,
        );
      const singleCodes = reasons.find((r) => /exports unmeasurable/.test(r)) ?? null;
      results.push({
        id: c.id,
        ok,
        reasons,
        bundle: pkg.bundle ?? null,
        single_exports_reason: singleCodes,
      });
      console.log(`${c.id}: ${ok ? "ok" : "FAIL"} ${reasons.join("; ")}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(
    `\nIteration 1, gate A null cases: ${rootCases.length - failures.length}/${rootCases.length} return their code ${verdict(!failures.length)} (of ${cases.length} step-1 browser null cases, ${rootCases.length} import the root)`,
  );
  for (const f of failures) console.log(`    ${f}`);
  await save("nulls", { results, failures });
}

// --- signals: S ---------------------------------------------------------------------------------------

async function scoreSignals(): Promise<void> {
  const config = asRecord(await readJson(join(REPO, "eval", "signals.json")));
  const rows: Record<string, unknown>[] = [];
  const mismatches: string[] = [];
  for (const raw of asArray(config.workspaces).map(asRecord)) {
    const cwd = (asString(raw.cwd) ?? "").replace(/^~/, homedir());
    const expected = asStringArray(raw.expected).sort();
    const project = await loadProject(cwd).catch(() => null);
    if (!project) mismatches.push(`${asString(raw.row) ?? "?"}: the workspace could not be loaded`);
    const found = [...(project?.info.browser_signals ?? [])].sort();
    const match = JSON.stringify(found) === JSON.stringify(expected);
    const row = asString(raw.row) ?? "?";
    rows.push({ row, expected, found, match });
    if (!match)
      mismatches.push(`${row}: expected [${expected.join(", ")}], found [${found.join(", ")}]`);
  }
  if (rows.length !== 22) mismatches.push(`${rows.length} workspaces listed, not 22`);
  console.log(
    `Iteration 1, gate S: ${rows.length - mismatches.length}/${rows.length} workspaces match the classification table ${verdict(!mismatches.length)}`,
  );
  for (const m of mismatches) console.log(`    ${m}`);
  await save("signals", { rows, mismatches });
}

// --- cost: F --------------------------------------------------------------------------------------------

async function scoreCost(locks: string, on: string): Promise<void> {
  const plain = await scratchProject("browser", false);
  const browser = await scratchProject("browser", true);
  let loadsPlain: string[] = [];
  let loadsBrowser: string[] = [];
  try {
    loadsPlain = (await depfit(["zod", "valibot"], plain, true)).rolldownLoads;
    loadsBrowser = (await depfit(["valibot"], browser, true)).rolldownLoads;
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(browser, { recursive: true, force: true });
  }
  process.env.DEPFIT_LOCK_DIR = locks;
  // Each package is measured once, and counted once per probe candidate it is (gate F is over
  // every probe candidate, so a package in two probes weighs twice).
  const specs = new Map<string, { name: string; version: string; count: number }>();
  for (const { project, base } of await probeFiles(on)) {
    for (const pkg of asArray(
      asRecord(await readJson(join(on, project, `${base}.json`))).packages,
    )) {
      const p = asRecord(pkg);
      const name = asString(p.name);
      const version = asString(p.version);
      if (p.kind !== "npm" || !name || !version) continue;
      const key = `${name}@${version}`;
      specs.set(key, { name, version, count: (specs.get(key)?.count ?? 0) + 1 });
    }
  }
  const times: Array<{ spec: string; ms: number; count: number }> = [];
  for (const [spec, { name, version, count }] of specs) {
    const ms = await withIsolatedInstall(name, version, async ({ dir }) => {
      const manifest = asRecord(
        JSON.parse(await readFile(join(dir, "node_modules", name, "package.json"), "utf8")),
      );
      const started = performance.now();
      await rootEntryBundle(dir, name, manifest);
      return Math.round(performance.now() - started);
    });
    times.push({ spec, ms, count });
    console.log(`${spec}: ${ms} ms`);
  }
  const sorted = times.flatMap((t) => Array<number>(t.count).fill(t.ms)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const median =
    sorted.length % 2
      ? (sorted[(sorted.length - 1) / 2] ?? 0)
      : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;
  const lines = [
    `Iteration 1, gate F`,
    `  no browser signal: Vite/rolldown modules resolved ${loadsPlain.length} (max 0) ${verdict(!loadsPlain.length)}; tracer check, browser workspace resolved ${loadsBrowser.length} (must be > 0) ${verdict(loadsBrowser.length > 0)}`,
    `  added time per package over ${sorted.length} probe candidates (${times.length} distinct packages): median ${median} ms (max 1500) ${verdict(median <= 1500)}, p90 ${at(0.9)} ms, max ${sorted.at(-1) ?? 0} ms (${times.find((t) => t.ms === sorted.at(-1))?.spec ?? "?"})`,
  ];
  console.log(`\n${lines.join("\n")}`);
  await save("cost", { loadsPlain, loadsBrowser, times, median, p90: at(0.9), max: sorted.at(-1) });
}

// --- comprehension: H0 ------------------------------------------------------------------------------

/** Gate H0's five questions (SPEC.md), fixed before any reader saw them. */
const H0_QUESTIONS = [
  "Report 1, valibot: what code does `bundle.whole_eager_js_gzip9_bytes` count?",
  "Report 1, valibot: what does `bundle.single_export_median_eager_js_gzip9_bytes` describe?",
  "Report 1: an app in this workspace would import a few of valibot's exports. Does either bundle number say how many gzip bytes adding valibot would add to this app's JavaScript? Explain.",
  "Report 2, simple-git: `bundle.exports_measured` is lower than `bundle.exports`. What does that mean?",
  "Report 3: `bundle` is null for both packages. Why, and what does that say about their browser bundle size?",
];

const H0_KEY = [
  'Every export of the root entry point (`import * as m from "valibot"`, all kept): the eager JS (entry chunk plus its static imports) of a standalone production Vite build, gzipped, with peers (external_packages) left out; the root only, not subpaths.',
  "The median, over valibot's exports, of one export's eager gzip bytes when that export is the only import, each in its own build: a typical single export, not an app's usage.",
  "No: both are standalone builds of named imports, neither is this app's usage nor its marginal cost (what it adds given what the app already bundles); real usage of a few exports usually lies between the median and the whole.",
  "Some exports' own builds failed depfit's checks (unmeasurable, with codes in the `bundle: <n> exports unmeasurable (...)` entry of unavailable) and are left out of the median; it does not mean they do not exist or are unused.",
  "The workspace has no browser signal (project.browser_signals is empty), so bundle facts were not measured (`bundle: skipped, no browser signal in workspace`); it says nothing about their size or whether they work in a browser.",
];

async function writeComprehension(): Promise<void> {
  const browser = await scratchProject("browser", true);
  const plain = await scratchProject("browser", false);
  try {
    const reports = [
      (await depfit(["zod", "valibot"], browser)).report,
      (await depfit(["simple-git@4.0.2"], browser)).report,
      (await depfit(["zod", "valibot"], plain)).report,
    ];
    if (reports.some((r) => r === null)) throw new Error("a CLI run printed no report");
    const { stdout: schema } = await run("bun", [join(REPO, "src/cli.ts"), "--schema"]);
    const out = join(RESULTS_DIR, "comprehension-root");
    await mkdir(out, { recursive: true });
    const prompt = [
      "You are given three JSON reports from a command-line tool that compares npm packages for a project, and the tool's field descriptions (`--schema`). Answer each question from these materials only, in one to three sentences.",
      ...reports.map(
        (r, i) => `## Report ${i + 1}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``,
      ),
      `## Field descriptions\n\n\`\`\`json\n${schema}\`\`\``,
      `## Questions\n\n${H0_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
    ].join("\n\n");
    await writeFile(join(out, "prompt.md"), `${prompt}\n`);
    await writeFile(
      join(out, "comprehension-key.md"),
      `${H0_KEY.map((k, i) => `${i + 1}. ${k}`).join("\n")}\n`,
    );
    console.log(`wrote ${out}/prompt.md and comprehension-key.md (never show the key to a reader)`);
  } finally {
    await rm(browser, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
}

// --- main ---------------------------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    on: { type: "string", default: join(REPO, "eval/results/v6") },
    again: { type: "string", default: join(REPO, "eval/results/v6-b") },
    off: { type: "string", default: join(REPO, "eval/results/v6-off") },
    locks: { type: "string" },
    resume: { type: "boolean", default: false },
  },
});
const gate = positionals[0];
switch (gate) {
  case "probes":
    await scoreProbes({ on: values.on, again: values.again, off: values.off });
    break;
  case "singles":
    await scoreSingles();
    break;
  case "wild":
    await runWild({ resume: values.resume, root: true });
    break;
  case "nulls":
    await scoreNulls();
    break;
  case "signals":
    await scoreSignals();
    break;
  case "comprehension":
    await writeComprehension();
    break;
  case "cost":
    await scoreCost(values.locks ?? join(values.on, "locks"), values.on);
    break;
  default:
    console.error(
      "usage: root-score.ts probes|singles|wild|nulls|signals|cost|comprehension [options]",
    );
    process.exitCode = 2;
}

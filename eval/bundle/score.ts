/**
 * Scores the depfit CLI against eval/bundle/SPEC.md gates A-F (step 1) using cases.json and
 * reference.json, and writes the full results to eval/bundle/results/<timestamp>.json. Gate H0
 * (comprehension) is prepared by comprehension.ts from those results; readers are run by hand.
 *   bun eval/bundle/score.ts [--runs 2] [--step workers|non-js|all] [--record-v4] [caseId...]
 *   bun eval/bundle/score.ts --wild [--resume]   # gate W, see wild-score.ts
 * By default only step "1" cases (browser, JS only) are scored; --step adds the others, and
 * naming case ids scores exactly those. `--record-v4` stores the no-`--bundle-entry` timing and
 * output shape of the current code as the v4 baseline for gates E and F; run it once on code that
 * predates the feature.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { asArray, asNumber, asRecord, asStringArray, isRecord } from "../../src/collect/util.ts";
import { type Case, CLI, COMPREHENSION_CASES, entryArgs, loadCases } from "./cases.ts";
import { compareContract, type Diff, LIVE_MAINTENANCE, withoutBundle } from "./contract.ts";
import { exceptionMismatch, loadExceptions, lockSha256 } from "./exceptions.ts";
import {
  BYTE_FIELDS,
  type CliRun,
  depfit,
  GZIP_RUNTIME_TOLERANCE,
  grossError,
  hasCode,
  inBand,
  lockPackages,
  observe,
  packageOf,
  REPORT_FIELD,
  referenceRanges,
  scratchProject,
  viteReference,
} from "./harness.ts";
import { runWild } from "./wild-score.ts";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const RESULTS_DIR = join(HERE, "results");
const V4_FILE = join(RESULTS_DIR, "v4-baseline.json");

/** `schema-docs` paths of the SPEC contract (`packages[].bundle` and its fields). */
const DOC_PATHS = [
  "packages[].bundle",
  "packages[].bundle.bundler",
  "packages[].bundle.target",
  "packages[].bundle.entry",
  "packages[].bundle.entry_source",
  "packages[].bundle.eager_js_min_bytes",
  "packages[].bundle.eager_js_gzip9_bytes",
  "packages[].bundle.lazy_js_min_bytes",
  "packages[].bundle.lazy_js_gzip9_bytes",
  "packages[].bundle.external_packages",
];

/** Pause after each CLI run, as eval/run.ts does: npm's downloads API rate-limits bursts. */
const PAUSE_MS = 3000;
/** Longer pause before the one retry of a pair that differed because of a network source. */
const RETRY_PAUSE_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Gate F: median extra time per package that `--bundle-entry` may add. */
const MAX_OVERHEAD_MS = 1500;

const GATES = {
  A: "Honesty",
  B: "Accuracy",
  C: "Vite conformance",
  D: "Determinism",
  E: "Contract",
  F: "Cost",
} as const;
type Gate = keyof typeof GATES;
const GATE_IDS = Object.keys(GATES).filter((key): key is Gate => key in GATES);

// --- frozen graph, shape and diff helpers --------------------------------------------------------

/** Dotted key paths of a JSON value; arrays collapse to `[]`. Values are ignored. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (!isRecord(value) || !Object.keys(value).length) return [prefix];
  return Object.entries(value).flatMap(([key, item]) =>
    keyPaths(item, prefix ? `${prefix}.${key}` : key),
  );
}

/**
 * Key paths of the report without `--bundle-entry`. `unavailable` is left out: it is an array whose
 * paths exist only when a live source failed (the v4 baseline has none), so counting it would make
 * the shape depend on network noise. Its contents are compared by `firstDiff` instead.
 */
const shape = (report: Record<string, unknown> | null) => {
  const { packages, ...rest } = withoutBundle(report);
  const stripped = asArray(packages).map((item) => {
    const { unavailable, maintenance, ...pkg } = asRecord(item);
    // As the v4 baseline was recorded: live maintenance counts left out.
    const stable = Object.entries(asRecord(maintenance)).filter(
      ([key]) => !LIVE_MAINTENANCE.includes(key),
    );
    return { ...pkg, maintenance: Object.fromEntries(stable) };
  });
  return [...new Set(keyPaths({ ...rest, packages: stripped }))].sort();
};

/** A value for a failure line: JSON, cut to a readable length. */
const shortJson = (value: unknown) => String(JSON.stringify(value)).slice(0, 160);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

// --- setup ---------------------------------------------------------------------------------------

type Drift = "none" | "drifted" | "unknown";
type CaseResult = {
  id: string;
  expect: Case["expect"];
  args: string[];
  ms: { without: number; with: number[] };
  /** Gate -> reason; an absent gate passed (or does not apply to this case). */
  failures: Partial<Record<Gate, string>>;
  /** Gates whose totals include this case. */
  counted: Gate[];
  /** B outcome for measure cases. */
  accuracy:
    | "in_band"
    | "reviewed_exception"
    | "null_with_code"
    | "out_of_band"
    | "failed"
    | "no_reference"
    | null;
  /** Full `--json` package entry of the first run, kept for the cases gate H0 shows to a reader. */
  report: unknown;
  drift: Drift;
  /** Gate E: the first non-bundle field that differed, with both values (flake or leak?). */
  contract_diff: Diff | null;
  /** Gate E: the difference was a failed network source; it persisted through one retry. */
  network_flake: boolean;
  /** Gate E: the first pair differed because of a network source, so the pair was run again. */
  contract_retried: boolean;
  bundle: unknown;
  unavailable: string[];
  notes: string[];
};

const options = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "2" },
    step: { type: "string", default: "1" },
    "record-v4": { type: "boolean" },
    wild: { type: "boolean" },
    resume: { type: "boolean" },
  },
});
if (options.values.wild) {
  await runWild({ resume: options.values.resume === true });
  process.exit(0);
}
const runs = Math.max(1, Number(options.values.runs) || 2);
const recordV4 = options.values["record-v4"] === true;
const stepOption = options.values.step;
const selected = (await loadCases(options.positionals)).filter(
  (c) =>
    options.positionals.length > 0 ||
    c.step === "1" ||
    stepOption === "all" ||
    stepOption === c.step,
);

const exceptions = (await loadExceptions()).filter((e) => e.set === "corpus");
const referenceCases = asRecord(
  asRecord(JSON.parse(await readFile(join(HERE, "reference.json"), "utf8"))).cases,
);
const v4 = await readFile(V4_FILE, "utf8").then(
  (text) => asRecord(JSON.parse(text)),
  () => null,
);
const v4Shapes = asRecord(v4?.shapes);

const scratch = new Map<string, string>();
const results: CaseResult[] = [];
const withoutShapes: Record<string, string[]> = {};
const rolldownLoaded: string[] = [];

try {
  for (const c of selected) {
    let dir = scratch.get(c.target);
    if (!dir) {
      dir = await scratchProject(c.target);
      scratch.set(c.target, dir);
    }
    const spec = `${c.package}@${c.version}`;
    const result: CaseResult = {
      id: c.id,
      expect: c.expect,
      args: [spec, ...entryArgs(c.imports)],
      ms: { without: 0, with: [] },
      failures: {},
      counted: ["A", "D", "E", "F"],
      accuracy: null,
      report: null,
      drift: "unknown",
      contract_diff: null,
      network_flake: false,
      contract_retried: false,
      bundle: null,
      unavailable: [],
      notes: [],
    };
    const fail = (gate: Gate, reason: string) => {
      result.failures[gate] ??= reason;
    };

    // Without --bundle-entry: gate E (shape, bundle: null), gate F (time, no rolldown), drift.
    const without = await depfit([spec], dir, true);
    await sleep(PAUSE_MS);
    result.ms.without = without.ms;
    withoutShapes[c.id] = shape(without.report);
    if (without.rolldownLoads.length) rolldownLoaded.push(c.id);
    const plain = packageOf(without.report);
    const runtime = asRecord(without.report?.project).runtime;
    if (runtime !== (c.target === "workerd" ? "cloudflare-workers" : "node")) {
      result.notes.push(`scratch project.runtime is ${String(runtime)}`);
    }
    const lock = await readFile(join(HERE, "locks", `${c.id}.json`), "utf8").catch(() => null);
    const newPackages = asStringArray(asRecord(plain?.cost).new_packages);
    if (lock && newPackages.length) {
      // Both directions: a locked package depfit did not install, and one it installed that the
      // lock does not have. Either means the tree moved and the reference no longer applies.
      const frozen = lockPackages(lock);
      const missing = frozen.required.filter((pkg) => !newPackages.includes(pkg));
      // Peers depfit installs on top of the peer-less lock are expected (reference.json lists them).
      const peerOnly = asStringArray(asRecord(referenceCases[c.id]).peer_only_packages);
      const extra = newPackages.filter((pkg) => !frozen.all.has(pkg) && !peerOnly.includes(pkg));
      result.drift = missing.length || extra.length ? "drifted" : "none";
      if (missing.length)
        result.notes.push(`not in cost.new_packages: ${missing.slice(0, 3).join(", ")}`);
      if (extra.length)
        result.notes.push(`not in the frozen lock: ${extra.slice(0, 3).join(", ")}`);
    }
    // Drifted cases are not compared with the references: gates A, B and C skip them entirely.
    const scored = result.drift !== "drifted";
    if (!scored) result.counted = result.counted.filter((gate) => gate !== "A");

    if (recordV4) {
      results.push(result);
      console.log(`${c.id}: ${without.ms}ms`);
      continue;
    }

    const withRuns: CliRun[] = [];
    for (let i = 0; i < runs; i++) {
      withRuns.push(await depfit(result.args, dir));
      await sleep(PAUSE_MS);
    }
    result.ms.with = withRuns.map((r) => r.ms);
    const first = withRuns[0];
    const seen = observe(first);
    const pkg = packageOf(first?.report ?? null);
    result.bundle = pkg?.bundle ?? null;
    if (COMPREHENSION_CASES.includes(c.id)) result.report = first?.report ?? null;
    if ("reasons" in seen) result.unavailable = seen.reasons;

    // Gate E: contract.
    const plainBundle = plain && "bundle" in plain ? plain.bundle : undefined;
    const baselineShape = asStringArray(v4Shapes[c.id]);
    let contract = compareContract(without.report, first?.report ?? null);
    if (contract.diff && contract.network && first?.report) {
      // A failed network source made the pair differ: run the pair once more, after a longer
      // pause, before judging.
      result.contract_retried = true;
      await sleep(RETRY_PAUSE_MS);
      const again = await depfit([spec], dir);
      await sleep(PAUSE_MS);
      const againWith = await depfit(result.args, dir);
      contract = compareContract(again.report, againWith.report);
    }
    result.contract_diff = contract.diff;
    result.network_flake = contract.network && contract.diff !== null;
    // A difference a network entry explains is a flake, reported apart from real failures.
    const otherFields = result.network_flake ? null : contract.diff;
    if ("problem" in seen) fail("E", seen.problem);
    else if (seen.target !== c.target) {
      fail("E", `bundle.target is ${String(seen.target)}, expected ${c.target}`);
    } else if (plainBundle !== null) fail("E", "without --bundle-entry, `bundle` is not null");
    else if (otherFields) {
      fail(
        "E",
        `non-bundle field differs with --bundle-entry: ${otherFields.path} (without ${shortJson(otherFields.without_bundle)}, with ${shortJson(otherFields.with_bundle)})`,
      );
    } else if (!baselineShape.length) {
      // A case added after v4 has no baseline to compare keys with; the rest of E still applies.
      result.notes.push("no v4 baseline (case added after v4): output keys not compared");
    } else if (shape(without.report).join() !== baselineShape.join()) {
      fail("E", "output keys without --bundle-entry differ from v4");
    }

    // Gate D: identical bytes and reasons across runs.
    if (runs < 2) result.counted = result.counted.filter((g) => g !== "D");
    else if ("problem" in seen) fail("D", seen.problem);
    else if (new Set(withRuns.map((r) => JSON.stringify(observe(r)))).size > 1) {
      fail("D", "bytes differ between runs");
    }

    // Gate F (per case): the --bundle-entry run must have produced output to be timed.
    if (!first?.report) fail("F", `cli: ${first?.error ?? "no output"}`);

    const refs = asRecord(referenceCases[c.id]);
    const ranges = referenceRanges(refs);

    if (!scored) {
      result.notes.push("drifted from the frozen graph; not scored for A, B, C");
    } else if (c.expect === "null") {
      if ("problem" in seen) fail("A", seen.problem);
      else if (BYTE_FIELDS.some((field) => seen.bundle[field] !== null)) {
        fail("A", `expected null ${c.code}, got gzip ${seen.bundle.gzip_bytes}`);
      } else if (!hasCode(seen.reasons, c)) {
        fail("A", `no \`bundle: ${c.code}${c.specifier ? ` ${c.specifier}` : ""}\` in unavailable`);
      }
    } else if (!ranges) {
      result.accuracy = "no_reference";
      result.notes.push("no reference built; excluded from B");
    } else if ("problem" in seen) {
      result.accuracy = "failed";
      fail("B", seen.problem);
    } else {
      const nulls = BYTE_FIELDS.filter((field) => seen.bundle[field] === null);
      if (nulls.length === BYTE_FIELDS.length) {
        result.accuracy = seen.reasons.length ? "null_with_code" : "failed";
        if (!seen.reasons.length) fail("B", "null without a `bundle:` entry in unavailable");
        else if (c.mandatory) fail("B", `mandatory case is null (${seen.reasons[0]})`);
        else result.notes.push(`null: ${seen.reasons[0]}`);
      } else if (nulls.length) {
        result.accuracy = "failed";
        fail(
          "B",
          `only some byte fields are null: ${nulls.map((f) => REPORT_FIELD[f]).join(", ")}`,
        );
      } else {
        const observed = BYTE_FIELDS.map((field) => ({
          field,
          x: seen.bundle[field] ?? 0,
          range: ranges[field],
        }));
        const describe = ({ field, x, range }: (typeof observed)[number]) =>
          `${REPORT_FIELD[field]} ${x} vs ${range.lo}..${range.hi}`;
        const gross = observed.filter(({ x, range }) => grossError(x, range));
        const bad = observed.filter(({ x, range }) => !inBand(x, range));
        const exception = bad.length ? exceptions.find((e) => e.id === c.id) : undefined;
        const mismatch = exception
          ? exceptionMismatch(exception, {
              version: c.version,
              entry: entryArgs(c.imports)[1] ?? "",
              lock: await lockSha256("corpus", c.id),
              bundler: seen.bundler ?? "",
              bytes: seen.bundle,
              reference: refs,
            })
          : null;
        if (exception && mismatch === null) {
          result.accuracy = "reviewed_exception";
          result.notes.push(
            `reviewed exception (exceptions.json): ${bad.map(describe).join(", ")}`,
          );
        } else {
          const stale = mismatch ? ` (reviewed exception stale: ${mismatch})` : "";
          if (gross.length) fail("A", `gross error: ${gross.map(describe).join(", ")}${stale}`);
          result.accuracy = bad.length ? "out_of_band" : "in_band";
          if (bad.length) fail("B", `outside band: ${bad.map(describe).join(", ")}${stale}`);
        }
      }
    }

    // Gate C: mandatory browser measure cases must equal a stock `vite build` of the same snippet
    // with depfit's documented configuration, made by reference.ts without depfit's code (README
    // "Gate C"). A case without a usable reference is counted as failing, never excluded.
    if (scored && c.expect === "measure" && c.mandatory && c.target === "browser") {
      const vite = viteReference(refs);
      result.counted.push("C");
      if (!vite) fail("C", "no usable `vite` reference");
      else if ("problem" in seen) fail("C", seen.problem);
      else {
        const off = BYTE_FIELDS.flatMap((field) => {
          const x = seen.bundle[field];
          const ref = vite[field];
          const gzip = field === "gzip_bytes" || field === "lazy_gzip_bytes";
          const ok =
            x !== null && (gzip ? Math.abs(x - ref) <= GZIP_RUNTIME_TOLERANCE * ref : x === ref);
          return ok ? [] : [`${REPORT_FIELD[field]} ${x} vs vite ${ref}`];
        });
        if (off.length) fail("C", off.join(", "));
      }
    }

    results.push(result);
    console.log(`${c.id}: ${Object.keys(result.failures).join("") || "ok"}`);
  }
} finally {
  await Promise.all([...scratch.values()].map((dir) => rm(dir, { recursive: true, force: true })));
}

// --- v4 baseline recording -----------------------------------------------------------------------

await mkdir(RESULTS_DIR, { recursive: true });
if (recordV4) {
  const baseline = {
    recorded_at: new Date().toISOString(),
    median_ms: median(results.map((r) => r.ms.without)),
    shapes: { ...v4Shapes, ...withoutShapes },
  };
  await writeFile(V4_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`recorded v4 baseline for ${results.length} cases: median ${baseline.median_ms}ms`);
  process.exit(0);
}

// --- gates ---------------------------------------------------------------------------------------

const counted = (gate: Gate) => results.filter((r) => r.counted.includes(gate));
const passed = (gate: Gate) => counted(gate).filter((r) => !r.failures[gate]).length;
const caseById = new Map(selected.map((c) => [c.id, c]));

const schemaFields = await run("bun", [CLI, "--schema"], { maxBuffer: 1 << 24 }).then(
  (out) => asRecord(asRecord(JSON.parse(out.stdout)).fields),
  () => ({}),
);
const missingDocs = DOC_PATHS.filter((path) => !(path in schemaFields));

const noViteReference = results.filter((r) => r.failures.C?.startsWith("no usable")).length;
// Drifted cases are in no size gate's comparisons or totals.
const scoredResults = results.filter((r) => r.drift !== "drifted");
const nullCases = scoredResults.filter((r) => r.expect === "null");
const nullOk = nullCases.filter((r) => !r.failures.A).length;
const gross = scoredResults.filter((r) => r.failures.A?.startsWith("gross error")).length;
const measured = scoredResults.filter((r) => r.accuracy && r.accuracy !== "no_reference");
const count = (kind: CaseResult["accuracy"]) => measured.filter((r) => r.accuracy === kind).length;
const mandatoryMissed = measured.filter(
  (r) =>
    caseById.get(r.id)?.mandatory &&
    r.accuracy !== "in_band" &&
    r.accuracy !== "reviewed_exception",
).length;
const mandatoryNullMissed = nullCases.filter(
  (r) => caseById.get(r.id)?.mandatory && r.failures.A,
).length;
const tolerableNulls = measured.filter(
  (r) => r.accuracy === "null_with_code" && !caseById.get(r.id)?.mandatory,
).length;

const nowMedian = median(results.map((r) => r.ms.without));
const v4Median = asNumber(v4?.median_ms);
const overhead = median(
  results.flatMap((r) => (r.failures.F ? [] : [(median(r.ms.with) ?? 0) - r.ms.without])),
);

type Verdict = { pass: boolean; summary: string; advisory?: string };
const verdicts: Record<Gate, Verdict> = {
  A: {
    pass: nullOk === nullCases.length && gross === 0,
    summary: `null cases with expected code ${nullOk}/${nullCases.length}, gross errors ${gross} (max 0), drifted cases excluded ${results.length - scoredResults.length}`,
  },
  B: {
    pass:
      count("out_of_band") === 0 &&
      count("failed") === 0 &&
      mandatoryMissed === 0 &&
      mandatoryNullMissed === 0 &&
      tolerableNulls <= 2,
    summary: `measure cases in band ${count("in_band")}/${measured.length}, reviewed exceptions ${count("reviewed_exception")}, coded nulls ${tolerableNulls} (max 2), out-of-band ${count("out_of_band")} (max 0), failed ${count("failed")} (max 0), mandatory missed ${mandatoryMissed + mandatoryNullMissed} (max 0)`,
  },
  C: {
    pass: counted("C").length > 0 && passed("C") === counted("C").length,
    summary: `mandatory browser cases equal to a stock vite build ${passed("C")}/${counted("C").length} (min bytes exact, gzip within ${GZIP_RUNTIME_TOLERANCE * 100}% for the runtime's zlib), counted failing for lack of a reference ${noViteReference}`,
  },
  D: {
    pass: runs >= 2 && counted("D").length > 0 && passed("D") === counted("D").length,
    summary:
      runs < 2 ? "needs --runs 2" : `identical across runs ${passed("D")}/${counted("D").length}`,
  },
  E: {
    pass:
      counted("E").length > 0 && passed("E") === counted("E").length && missingDocs.length === 0,
    summary: `contract ok ${passed("E")}/${counted("E").length}, schema docs missing ${missingDocs.length}/${DOC_PATHS.length}`,
  },
  F: {
    pass: overhead !== null && overhead <= MAX_OVERHEAD_MS && rolldownLoaded.length === 0,
    summary: `no-bundle runs that loaded rolldown or vite ${rolldownLoaded.length} (max 0), median overhead ${overhead === null ? "n/a (no successful runs)" : `${overhead}ms`} (max ${MAX_OVERHEAD_MS})`,
    advisory: `no-bundle median ${nowMedian}ms vs v4 ${v4Median === null ? "n/a (no baseline)" : `${v4Median}ms${nowMedian === null ? "" : ` (${(((nowMedian - v4Median) / v4Median) * 100).toFixed(1)}%)`}`}; network noise is about +-20%, never fails the gate`,
  },
};

console.log(`\nScorecard (${results.length} cases, step ${stepOption})`);
for (const gate of GATE_IDS) {
  const verdict = verdicts[gate];
  console.log(
    `  ${gate} ${GATES[gate].padEnd(12)} ${verdict.pass ? "PASS" : "FAIL"}  ${verdict.summary}`,
  );
  if (verdict.advisory) console.log(`    advisory: ${verdict.advisory}`);
}

console.log("\nFailing cases");
for (const gate of GATE_IDS) {
  const byReason = new Map<string, string[]>();
  for (const r of results) {
    const reason = r.failures[gate];
    if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), r.id]);
  }
  for (const [reason, ids] of byReason) {
    const shown =
      ids.length > 6 ? `${ids.slice(0, 6).join(", ")} +${ids.length - 6} more` : ids.join(", ");
    console.log(`  ${gate} [${ids.length}] ${reason}: ${shown}`);
  }
}
if (missingDocs.length) console.log(`  E schema docs missing: ${missingDocs.join(", ")}`);

const flaked = results.filter((r) => r.network_flake);
const retried = results.filter((r) => r.contract_retried).length;
console.log(
  `\nGate E network flakes (a failed network source differed between runs, still after one retry; not counted as failures): ${flaked.length ? flaked.map((r) => r.id).join(", ") : "none"}; pairs retried ${retried}`,
);
for (const r of flaked) {
  console.log(
    `  ${r.id}: ${r.contract_diff?.path} (without ${shortJson(r.contract_diff?.without_bundle)}, with ${shortJson(r.contract_diff?.with_bundle)})`,
  );
}

const drifted = results.filter((r) => r.drift === "drifted").map((r) => r.id);
const unknownDrift = results.filter((r) => r.drift === "unknown").length;
console.log(
  `\nDrifted from frozen graph (excluded from A, B, C): ${drifted.length ? drifted.join(", ") : "none"}; drift unknown for ${unknownDrift}`,
);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(RESULTS_DIR, `${stamp}.json`);
await writeFile(
  out,
  `${JSON.stringify({ generated_at: new Date().toISOString(), runs, step: stepOption, gates: verdicts, missing_schema_docs: missingDocs, drifted, cases: results }, null, 2)}\n`,
);
console.log(`\nwrote ${out}`);

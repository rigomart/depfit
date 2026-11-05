/**
 * Bundle facts for a package's root entry point, measured two ways (eval/bundle/SPEC.md, iteration
 * 1): the whole entry point (`import * as m`, kept whole), and each export alone, one build per
 * export, all in one Vite child process. Only collect/index.ts imports this, and only for a browser
 * workspace, so Vite and rolldown are never loaded otherwise.
 */
import type { Bundle } from "../report.ts";
import { type BundleEntry, entryModuleSource } from "./bundle-entry.ts";
import {
  type BundleOutcome,
  type BundleProblem,
  buildEntrySource,
  bundleReasons,
  bundlerName,
  externalPackages,
  loadParser,
  outcomeOf,
  problemsFromBuild,
  startViteRunner,
  type ViteBuildResult,
  type ViteLog,
} from "./bundle.ts";
import { errorMessage } from "./util.ts";

/** More exports than this are not built one by one: `bundle: EXPORT_LIMIT <count>`. */
export const EXPORT_LIMIT = 1000;

export type ExportOutcome = { name: string; outcome: BundleOutcome };

/**
 * What was measured. `names` is null when the export names could not be listed (`listProblems`
 * says why); `singles` is null when the names were not built one by one (no names, or more than
 * EXPORT_LIMIT).
 */
export type RootEntryMeasurement = {
  whole: BundleOutcome;
  names: string[] | null;
  listProblems: BundleProblem[];
  singles: ExportOutcome[] | null;
};

const LOCAL = "m";

/** The entry module of one measured build: the namespace, the default, or one named export. */
function entryFor(candidate: string, name: string | null): BundleEntry {
  const clause =
    name === null
      ? { kind: "namespace" as const, local: LOCAL }
      : name === "default"
        ? { kind: "default" as const, local: LOCAL }
        : { kind: "named" as const, imported: name, local: LOCAL };
  return { candidate, imports: [{ source: candidate, clauses: [clause] }], members: [] };
}

const LIST_FAILED: BundleProblem = { code: "BUILD_ERROR", specifier: "export list" };

const isMissingExport = (log: ViteLog) =>
  log.code === "MISSING_EXPORT" || log.code === "IMPORT_IS_UNDEFINED";

/**
 * Export names of the root: what the bundler resolves for `export * from "<name>"` (it never
 * includes `default`), plus `default` when `export { default } from "<name>"` builds. A CommonJS
 * module resolves to `default` alone. null names: a listing build failed, for `problems`.
 */
async function listExports(
  build: (source: string) => Promise<ViteBuildResult>,
  externals: string[],
  candidate: string,
): Promise<{ names: string[] | null; problems: BundleProblem[] }> {
  const from = JSON.stringify(candidate);
  const buildProblems = async (result: ViteBuildResult) =>
    problemsFromBuild(result, externals, candidate, await loadParser());
  const failed = async (result: ViteBuildResult) => {
    const problems = await buildProblems(result);
    return { names: null, problems: problems.length ? problems : [LIST_FAILED] };
  };
  // When the candidate does not resolve, Vite keeps the import and the build still succeeds (NO_ENTRY).
  const unresolved = async (result: ViteBuildResult) =>
    (await buildProblems(result)).some((problem) => problem.code === "NO_ENTRY");
  const star = await build(`export * from ${from};\n`);
  if (star.errors !== null || star.exports === null || (await unresolved(star))) {
    return failed(star);
  }
  const withDefault = await build(`export { default } from ${from};\n`);
  // Only a missing export error means there is no `default`; any other build error leaves the
  // names unknown. Other problems the checks find in a build that succeeds do not matter for names.
  const errors = withDefault.errors ?? [];
  if (errors.length && !errors.every(isMissingExport)) return failed(withDefault);
  const names = [...star.exports, ...(withDefault.errors === null ? ["default"] : [])];
  return { names: [...new Set(names)].sort(), problems: [] };
}

/**
 * Measures the root entry point of `candidate`, installed in `dir`, with `externals` left out:
 * the whole build, then (when it ran on the evaluated toolchain) the export names and each export
 * alone, in sorted order, sequentially in one child process.
 */
export async function measureRootEntry(
  dir: string,
  candidate: string,
  externals: string[],
): Promise<RootEntryMeasurement> {
  const runner = startViteRunner(dir);
  try {
    const build = (source: string, exports = false) =>
      buildEntrySource(runner, dir, source, externals, exports);
    const measure = async (name: string | null) =>
      outcomeOf(await build(entryModuleSource(entryFor(candidate, name))), externals, candidate);

    const whole = await measure(null);
    if (whole.problems.some((problem) => problem.code === "TOOLCHAIN_MISMATCH")) {
      return { whole, names: null, listProblems: whole.problems, singles: null };
    }
    const listed = await listExports((source) => build(source, true), externals, candidate);
    const { names } = listed;
    if (names === null || names.length > EXPORT_LIMIT) {
      return { whole, names, listProblems: listed.problems, singles: null };
    }
    const singles: ExportOutcome[] = [];
    for (const name of names) singles.push({ name, outcome: await measure(name) });
    return { whole, names, listProblems: [], singles };
  } finally {
    runner.close();
  }
}

/** Median of integers, rounded to a whole number; null for none. */
export function medianBytes(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const middle =
    sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return middle === undefined ? null : Math.round(middle);
}

/**
 * The `bundle` section and its `unavailable` entries, one per cause: whole-build problems as in v5
 * (one `bundle: <CODE> [names]` per code); listing problems for codes the whole build does not
 * report; `bundle: EXPORT_LIMIT <count>`; and one `bundle: <n> exports unmeasurable (<codes>)` for
 * the exports whose own build failed for a code the whole build does not report (n counts only
 * those exports).
 */
export function rootEntryFacts(
  measurement: RootEntryMeasurement,
  bundler: string,
  externals: string[],
): { bundle: Bundle; reasons: string[] } {
  const { whole, names, singles } = measurement;
  const measured = singles?.flatMap(({ outcome }) => (outcome.bytes ? [outcome.bytes] : [])) ?? [];
  const failed = singles?.filter(({ outcome }) => outcome.bytes === null) ?? [];
  // One entry per cause (a reason code): a code the whole build already reports is not repeated
  // for the export listing or the per-export summary.
  const wholeCodes = new Set(whole.problems.map((problem) => problem.code));
  const isNew = (problem: BundleProblem) => !wholeCodes.has(problem.code);
  const reasons = new Set(bundleReasons(whole.problems));
  for (const reason of bundleReasons(measurement.listProblems.filter(isNew))) reasons.add(reason);
  if (names !== null && names.length > EXPORT_LIMIT) {
    reasons.add(`bundle: EXPORT_LIMIT ${names.length}`);
  }
  // A failed build that recorded no problem is still reported, as BUILD_ERROR.
  const codesOf = ({ outcome }: ExportOutcome) =>
    outcome.problems.length ? outcome.problems.filter(isNew).map((p) => p.code) : ["BUILD_ERROR"];
  const otherCause = failed.filter((single) => codesOf(single).length);
  if (otherCause.length) {
    const codes = [...new Set(otherCause.flatMap(codesOf))].sort();
    reasons.add(`bundle: ${otherCause.length} exports unmeasurable (${codes.join(", ")})`);
  }
  return {
    bundle: {
      bundler,
      target: "browser",
      entry_point: ".",
      whole_eager_js_min_bytes: whole.bytes?.eager_js_min_bytes ?? null,
      whole_eager_js_gzip9_bytes: whole.bytes?.eager_js_gzip9_bytes ?? null,
      whole_lazy_js_min_bytes: whole.bytes?.lazy_js_min_bytes ?? null,
      whole_lazy_js_gzip9_bytes: whole.bytes?.lazy_js_gzip9_bytes ?? null,
      exports: names?.length ?? null,
      exports_measured: singles === null ? null : measured.length,
      single_export_median_eager_js_gzip9_bytes: medianBytes(
        measured.map((bytes) => bytes.eager_js_gzip9_bytes),
      ),
      external_packages: externals,
    },
    reasons: [...reasons],
  };
}

/**
 * The bundle section for `candidate` installed in `dir`, its peers (from `manifest`) left out. A
 * crashed build gives null numbers and a `bundle: BUNDLER_ERROR` reason.
 */
export async function rootEntryBundle(
  dir: string,
  candidate: string,
  manifest: Record<string, unknown>,
): Promise<{ bundle: Bundle; reasons: string[] }> {
  const externals = externalPackages(manifest);
  const bundler = await bundlerName();
  try {
    return rootEntryFacts(await measureRootEntry(dir, candidate, externals), bundler, externals);
  } catch (error) {
    const crashed: RootEntryMeasurement = {
      whole: { bytes: null, problems: [] },
      names: null,
      listProblems: [],
      singles: null,
    };
    const { bundle } = rootEntryFacts(crashed, bundler, externals);
    return { bundle, reasons: [`bundle: BUNDLER_ERROR ${errorMessage(error)}`] };
  }
}

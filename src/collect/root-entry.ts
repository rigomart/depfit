/**
 * Bundle facts for a package's root entry point, measured two ways (eval/bundle/SPEC.md, iteration
 * 1): the whole entry point (`import * as m`, kept whole), and each export alone, one build per
 * export; and each subpath of its `exports` map, measured whole (iteration 2). The report gets a
 * compact map of the subpaths (at most REPORT_SUBPATH_LIMIT); the full detail per subpath
 * (`subpathDetail`) is kept for a later `inspect` command. All builds run in one Vite child
 * process. collect/index.ts imports this only for a browser workspace, so Vite and rolldown are
 * never loaded otherwise.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { listSubpaths, SUBPATH_LIMIT, type SubpathListing, subpathSpecifier } from "./subpaths.ts";
import { errorMessage, isRecord } from "./util.ts";

/** More exports than this are not built one by one: `bundle: EXPORT_LIMIT <count>`. */
export const EXPORT_LIMIT = 1000;

/** More listed subpaths than this are not built for the default report (SPEC.md amendment 6). */
export const REPORT_SUBPATH_LIMIT = 30;

export type ExportOutcome = { name: string; outcome: BundleOutcome };

export type SubpathOutcome = { key: string; outcome: BundleOutcome };

/**
 * The subpaths of the `exports` map. `exportsMap`, `listed` (how many keys the listing rule admits)
 * and `patterns` are null when the manifest could not be read. `subpaths` holds each listed key's
 * whole build, sorted by key, and is null when none were built: no map, a toolchain mismatch on
 * the root, or a cause of its own in `reason` (`bundle: SUBPATH_LIMIT <count>`,
 * `SUBPATH_LIST_FAILED`, or a crash, `BUNDLER_ERROR`).
 */
export type SubpathMeasurement = {
  exportsMap: boolean | null;
  listed: number | null;
  patterns: string[] | null;
  subpaths: SubpathOutcome[] | null;
  reason: string | null;
};

/** The listing from the installed manifest, or the `unavailable` entry when it cannot be read. */
export type ListingResult = { ok: true; listing: SubpathListing } | { ok: false; reason: string };

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
  /** null when the subpaths were not requested. */
  subpaths: SubpathMeasurement | null;
};

type RootMeasurement = Omit<RootEntryMeasurement, "subpaths">;

const LOCAL = "m";

/**
 * The entry module of one measured build: the namespace, the default, or one named export of
 * `source` (the candidate itself, or one of its subpaths).
 */
function entryFor(candidate: string, name: string | null, source = candidate): BundleEntry {
  const clause =
    name === null
      ? { kind: "namespace" as const, local: LOCAL }
      : name === "default"
        ? { kind: "default" as const, local: LOCAL }
        : { kind: "named" as const, imported: name, local: LOCAL };
  return { candidate, imports: [{ source, clauses: [clause] }], members: [] };
}

/**
 * The subpath listing of `candidate`'s installed package.json. A manifest that cannot be read or
 * parsed gives `bundle: SUBPATH_LIST_FAILED`, naming the file and the error code only (no temp path).
 */
export async function readListing(dir: string, candidate: string): Promise<ListingResult> {
  const file = `${candidate}/package.json`;
  let text: string;
  try {
    text = await readFile(join(dir, "node_modules", file), "utf8");
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "read error";
    return { ok: false, reason: `bundle: SUBPATH_LIST_FAILED ${file} ${code}` };
  }
  try {
    const manifest: unknown = JSON.parse(text);
    if (!isRecord(manifest)) throw new Error("not an object");
    return { ok: true, listing: listSubpaths(manifest) };
  } catch {
    return { ok: false, reason: `bundle: SUBPATH_LIST_FAILED ${file} invalid JSON` };
  }
}

/** The subpath state when none of them is built: from the listing alone, with no new reason. */
export function unbuiltSubpaths(
  listed: ListingResult,
  reason: string | null = null,
): SubpathMeasurement {
  if (!listed.ok) {
    return {
      exportsMap: null,
      listed: null,
      patterns: null,
      subpaths: null,
      reason: listed.reason,
    };
  }
  const { exportsMap, patterns, subpaths } = listed.listing;
  return { exportsMap, listed: subpaths.length, patterns, subpaths: null, reason };
}

/**
 * Builds each listed subpath whole (`import * as m from "<name>/<subpath>"`, kept), once per
 * target file, unless there is no map, the root's toolchain check failed, or the list is over
 * `limit`. Throws when the child fails (the caller keeps the root's results).
 */
async function measureSubpaths(
  measure: (source: string) => Promise<BundleOutcome>,
  candidate: string,
  listed: ListingResult,
  toolchainFailed: boolean,
  limit: number,
): Promise<SubpathMeasurement> {
  if (!listed.ok || !listed.listing.exportsMap || toolchainFailed) return unbuiltSubpaths(listed);
  const { subpaths, patterns } = listed.listing;
  if (subpaths.length > limit) {
    return unbuiltSubpaths(listed, `bundle: SUBPATH_LIMIT ${subpaths.length}`);
  }
  const byTarget = new Map<string, BundleOutcome>();
  const sorted = [...subpaths].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const outcomes: SubpathOutcome[] = [];
  for (const { key, target } of sorted) {
    let outcome = byTarget.get(target);
    if (outcome === undefined) {
      outcome = await measure(subpathSpecifier(candidate, key));
      byTarget.set(target, outcome);
    }
    outcomes.push({ key, outcome });
  }
  return {
    exportsMap: true,
    listed: subpaths.length,
    patterns,
    subpaths: outcomes,
    reason: null,
  };
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

const isToolchainMismatch = (outcome: BundleOutcome) =>
  outcome.problems.some((problem) => problem.code === "TOOLCHAIN_MISMATCH");

/**
 * Measures the root entry point of `candidate`, installed in `dir`, with `externals` left out:
 * the whole build, then (when it ran on the evaluated toolchain) the export names and each export
 * alone, in sorted order; then, when `options.subpaths` is set, each listed subpath whole. All
 * sequentially in one child process.
 * A failure in the root phase throws; one in the subpath phase leaves the root's results as they
 * are and gives the subpaths `bundle: BUNDLER_ERROR`.
 */
export async function measureRootEntry(
  dir: string,
  candidate: string,
  externals: string[],
  options: {
    subpaths?: boolean;
    /** At most this many listed subpaths are built (SUBPATH_LIMIT, the measurement's own cap). */
    subpathLimit?: number;
    runnerScript?: string;
    /**
     * Called with the subpath phase's wall time: reading the manifest, plus the root's last build
     * to the subpaths' final state.
     */
    onSubpathPhase?: (ms: number) => void;
  } = {},
): Promise<RootEntryMeasurement> {
  const listStarted = performance.now();
  const listing = options.subpaths ? await readListing(dir, candidate) : null;
  const listMs = performance.now() - listStarted;
  const runner = startViteRunner(dir, options.runnerScript);
  try {
    const build = (source: string, exports = false) =>
      buildEntrySource(runner, dir, source, externals, exports);
    const measureEntry = async (entry: BundleEntry) =>
      outcomeOf(await build(entryModuleSource(entry)), externals, candidate);
    const measure = (name: string | null) => measureEntry(entryFor(candidate, name));

    const root = await measureRoot(build, measure, externals, candidate);
    if (listing === null) return { ...root, subpaths: null };
    const started = performance.now();
    const subpaths = await measureSubpaths(
      (source) => measureEntry(entryFor(candidate, null, source)),
      candidate,
      listing,
      isToolchainMismatch(root.whole),
      Math.min(options.subpathLimit ?? SUBPATH_LIMIT, SUBPATH_LIMIT),
    ).catch((error: unknown) =>
      unbuiltSubpaths(listing, `bundle: BUNDLER_ERROR ${errorMessage(error)}`),
    );
    options.onSubpathPhase?.(listMs + performance.now() - started);
    return { ...root, subpaths };
  } finally {
    runner.close();
  }
}

async function measureRoot(
  build: (source: string, exports?: boolean) => Promise<ViteBuildResult>,
  measure: (name: string | null) => Promise<BundleOutcome>,
  externals: string[],
  candidate: string,
): Promise<RootMeasurement> {
  const whole = await measure(null);
  if (isToolchainMismatch(whole)) {
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
}

/**
 * Peers the measured builds left out: those any build that gave bytes (the whole entry point or
 * an export alone) still imports. null when no build gave bytes, so nothing was left out of a number.
 */
function leftOut({ whole, singles }: RootEntryMeasurement): string[] | null {
  const measured = [whole, ...(singles ?? []).map((single) => single.outcome)].flatMap((outcome) =>
    outcome.bytes ? [outcome.externals] : [],
  );
  return measured.length ? [...new Set(measured.flat())].sort() : null;
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

/** One subpath in full, the detail kept for `inspect` (not in the default report). */
export type SubpathDetail = {
  entry_point: string;
  whole_eager_js_gzip9_bytes: number | null;
  whole_lazy_js_gzip9_bytes: number | null;
  external_packages: string[] | null;
  unmeasurable_codes: string[];
};

/** The codes of a failed build; BUILD_ERROR when it recorded no problem. */
function failureCodes(outcome: BundleOutcome): string[] {
  const codes = outcome.problems.map((problem) => problem.code);
  return codes.length ? [...new Set(codes)].sort() : ["BUILD_ERROR"];
}

/** Each built subpath in full, sorted by key; null when none were built or none was asked for. */
export function subpathDetail(measurement: RootEntryMeasurement): SubpathDetail[] | null {
  return (
    measurement.subpaths?.subpaths?.map(({ key, outcome }) => ({
      entry_point: key,
      whole_eager_js_gzip9_bytes: outcome.bytes?.eager_js_gzip9_bytes ?? null,
      whole_lazy_js_gzip9_bytes: outcome.bytes?.lazy_js_gzip9_bytes ?? null,
      external_packages: outcome.bytes ? outcome.externals : null,
      unmeasurable_codes: outcome.bytes ? [] : failureCodes(outcome),
    })) ?? null
  );
}

/** An `unavailable` entry and the reason codes it reports, so a later cause can join it. */
type Reason = { text: string; codes: string[] };

/** `bundle: <CODE> ...` entries, one per code (`bundleReasons`), with their codes. */
const perCode = (problems: BundleProblem[]): Reason[] =>
  bundleReasons(problems).map((text) => ({ text, codes: [text.split(" ")[1] ?? ""] }));

/**
 * The subpaths' `unavailable` entries, one per cause: the reason none were built, and for each
 * code of a null subpath, its keys. A code a root entry already reports is appended to that entry
 * (`; <CODE> in subpaths <keys>`); any other gets `bundle: <CODE> in subpaths <keys>`.
 */
function addSubpathReasons(reasons: Reason[], subpaths: SubpathMeasurement): void {
  if (subpaths.reason) reasons.push({ text: subpaths.reason, codes: [] });
  const keysByCode = new Map<string, string[]>();
  for (const { key, outcome } of subpaths.subpaths ?? []) {
    if (outcome.bytes) continue;
    for (const code of failureCodes(outcome))
      keysByCode.set(code, [...(keysByCode.get(code) ?? []), key]);
  }
  for (const code of [...keysByCode.keys()].sort()) {
    const keys = (keysByCode.get(code) ?? []).join(", ");
    const covering = reasons.find((reason) => reason.codes.includes(code));
    if (covering) covering.text += `; ${code} in subpaths ${keys}`;
    else reasons.push({ text: `bundle: ${code} in subpaths ${keys}`, codes: [code] });
  }
}

/** The report's compact subpath fields (SPEC.md amendment 6); all null when none were asked for. */
function compactSubpaths(subpaths: SubpathMeasurement | null) {
  const map = subpaths?.subpaths
    ? Object.fromEntries(
        subpaths.subpaths.map(({ key, outcome }) => [
          key,
          outcome.bytes?.eager_js_gzip9_bytes ?? null,
        ]),
      )
    : null;
  return {
    exports_map: subpaths?.exportsMap ?? null,
    subpaths_listed: subpaths?.listed ?? null,
    subpaths_whole_eager_js_gzip9_bytes: map,
    subpath_patterns_unmeasured: subpaths?.patterns ?? null,
  };
}

/**
 * The `bundle` section and its `unavailable` entries, one per cause: whole-build problems as in v5
 * (one `bundle: <CODE> [names]` per code); listing problems for codes the whole build does not
 * report; `bundle: EXPORT_LIMIT <count>`; one `bundle: <n> exports unmeasurable (<codes>)` for
 * the exports whose own build failed for a code the whole build does not report (n counts only
 * those exports); and the subpaths' entries (`addSubpathReasons`).
 */
export function rootEntryFacts(
  measurement: RootEntryMeasurement,
  bundler: string,
): { bundle: Bundle; reasons: string[] } {
  const { whole, names, singles } = measurement;
  const measured = singles?.flatMap(({ outcome }) => (outcome.bytes ? [outcome.bytes] : [])) ?? [];
  const failed = singles?.filter(({ outcome }) => outcome.bytes === null) ?? [];
  // One entry per cause (a reason code): a code the whole build already reports is not repeated
  // for the export listing or the per-export summary.
  const wholeCodes = new Set(whole.problems.map((problem) => problem.code));
  const isNew = (problem: BundleProblem) => !wholeCodes.has(problem.code);
  const reasons: Reason[] = [...perCode(whole.problems)];
  for (const reason of perCode(measurement.listProblems.filter(isNew))) {
    if (!reasons.some((known) => known.text === reason.text)) reasons.push(reason);
  }
  if (names !== null && names.length > EXPORT_LIMIT) {
    reasons.push({ text: `bundle: EXPORT_LIMIT ${names.length}`, codes: [] });
  }
  // A failed build that recorded no problem is still reported, as BUILD_ERROR.
  const codesOf = ({ outcome }: ExportOutcome) =>
    outcome.problems.length ? outcome.problems.filter(isNew).map((p) => p.code) : ["BUILD_ERROR"];
  const otherCause = failed.filter((single) => codesOf(single).length);
  if (otherCause.length) {
    const codes = [...new Set(otherCause.flatMap(codesOf))].sort();
    reasons.push({
      text: `bundle: ${otherCause.length} exports unmeasurable (${codes.join(", ")})`,
      codes,
    });
  }
  if (measurement.subpaths) addSubpathReasons(reasons, measurement.subpaths);
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
      external_packages: leftOut(measurement),
      ...compactSubpaths(measurement.subpaths),
    },
    reasons: reasons.map((reason) => reason.text),
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
  const listed = await readListing(dir, candidate);
  try {
    const measurement = await measureRootEntry(dir, candidate, externals, {
      subpaths: true,
      subpathLimit: REPORT_SUBPATH_LIMIT,
    });
    return rootEntryFacts(measurement, bundler);
  } catch (error) {
    // The root phase failed, so no subpath was built: the crash is one entry, and an unreadable
    // manifest (a separate cause) keeps its own.
    const crashed: RootEntryMeasurement = {
      whole: { bytes: null, problems: [] },
      names: null,
      listProblems: [],
      singles: null,
      subpaths: unbuiltSubpaths(listed),
    };
    const { bundle, reasons } = rootEntryFacts(crashed, bundler);
    return { bundle, reasons: [`bundle: BUNDLER_ERROR ${errorMessage(error)}`, ...reasons] };
  }
}

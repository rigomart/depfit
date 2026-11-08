/**
 * Bundle facts for a package's root entry point, measured two ways (eval/bundle/SPEC.md, iteration
 * 1): the whole entry point (`import * as m`, kept whole), and each export alone, one build per
 * export; and each subpath of its `exports` map, measured whole (iteration 2). The report gets a
 * compact map of the subpaths (at most REPORT_SUBPATH_LIMIT); the full detail per subpath
 * (`subpathDetail`) is kept for the follow-up flags (`--entries`, #10). The builds run on a pool of
 * Vite worker processes (`vite-pool.ts`), shared by every candidate of a run, and at the same time;
 * the result is the one today's order of the builds gives (SPEC.md, "Parallel builds (#7)").
 * collect/index.ts imports this only for a browser workspace, so Vite and rolldown are never loaded
 * otherwise.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "../report.ts";
import { type BundleEntry, entryModuleSource } from "./bundle-entry.ts";
import {
  type BundleOutcome,
  type BundleProblem,
  bundleReasons,
  bundlerName,
  externalPackages,
  loadParser,
  outcomeOf,
  problemsFromBuild,
  type ViteBuildResult,
  type ViteLog,
} from "./bundle.ts";
import {
  byCodePoint,
  listSubpaths,
  SUBPATH_LIMIT,
  type SubpathListing,
  subpathSpecifier,
} from "./subpaths.ts";
import { errorMessage, isRecord, reasonText } from "./util.ts";
import { bundleWorkers, createVitePool, type VitePool } from "./vite-pool.ts";

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
    return { ok: false, reason: `bundle: SUBPATH_LIST_FAILED ${reasonText(`${file} ${code}`)}` };
  }
  try {
    const manifest: unknown = JSON.parse(text);
    if (!isRecord(manifest)) throw new Error("not an object");
    return { ok: true, listing: listSubpaths(manifest) };
  } catch {
    return { ok: false, reason: `bundle: SUBPATH_LIST_FAILED ${reasonText(file)} invalid JSON` };
  }
}

/**
 * The subpath state when they are not built (SPEC.md iteration 2, states in order): an unknown
 * listing (its own reason), no map, an empty map (`[]`, nothing to build), more than `limit`
 * (`bundle: SUBPATH_LIMIT <n>`), else not built for `reason` (a crash in the subpath phase), or for
 * a root failure, whose own entry explains it (`reason` null).
 */
export function unbuiltSubpaths(
  listed: ListingResult,
  limit: number,
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
  const state = { exportsMap, listed: subpaths.length, patterns };
  if (!exportsMap) return { ...state, subpaths: null, reason: null };
  if (subpaths.length === 0) return { ...state, subpaths: [], reason: null };
  if (subpaths.length > limit) {
    return { ...state, subpaths: null, reason: `bundle: SUBPATH_LIMIT ${subpaths.length}` };
  }
  return { ...state, subpaths: null, reason };
}

/** A promise's outcome as a value, so a build started early never rejects unhandled. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** The value, or the error thrown: the first failure awaited in order is the one that counts. */
function unwrap<T>(settled: Settled<T>): T {
  if (settled.ok) return settled.value;
  throw settled.error;
}

/**
 * Builds each listed subpath whole (`import * as m from "<name>/<subpath>"`, kept), once per
 * target file, unless there is no map, the root's toolchain check failed, or the list is over
 * `limit`. `serial` builds them one after another in key order; otherwise all start at once. Either
 * way the first build in key order that fails to run throws (the caller keeps the root's results).
 */
async function measureSubpaths(
  measure: (source: string) => Promise<BundleOutcome>,
  candidate: string,
  listed: ListingResult,
  toolchainFailed: boolean,
  limit: number,
  serial: boolean,
): Promise<SubpathMeasurement> {
  if (!listed.ok) return unbuiltSubpaths(listed, limit);
  const { exportsMap, subpaths, patterns } = listed.listing;
  const nothingToBuild = !exportsMap || subpaths.length === 0 || subpaths.length > limit;
  if (nothingToBuild || toolchainFailed) return unbuiltSubpaths(listed, limit);
  const sorted = [...subpaths].sort((a, b) => byCodePoint(a.key, b.key));
  const byTarget = new Map<string, () => Promise<Settled<BundleOutcome>>>();
  for (const { key, target } of sorted) {
    if (byTarget.has(target)) continue;
    const build = () => settle(measure(subpathSpecifier(candidate, key)));
    if (serial) {
      let once: Promise<Settled<BundleOutcome>> | null = null;
      byTarget.set(target, () => (once ??= build()));
    } else {
      const started = build();
      byTarget.set(target, () => started);
    }
  }
  const outcomes: SubpathOutcome[] = [];
  for (const { key, target } of sorted) {
    const outcome = byTarget.get(target);
    if (outcome) outcomes.push({ key, outcome: unwrap(await outcome()) });
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
  serial: boolean,
): Promise<{ names: string[] | null; problems: BundleProblem[] }> {
  const from = JSON.stringify(candidate);
  // Both listing builds start at once unless `serial`; the default's result counts only when the
  // star listing succeeded, as when it is built second.
  const starBuild = settle(build(`export * from ${from};\n`));
  const defaultSource = `export { default } from ${from};\n`;
  const early = serial ? null : settle(build(defaultSource));
  const buildProblems = async (result: ViteBuildResult) =>
    problemsFromBuild(result, externals, candidate, await loadParser());
  const failed = async (result: ViteBuildResult) => {
    const problems = await buildProblems(result);
    return { names: null, problems: problems.length ? problems : [LIST_FAILED] };
  };
  // When the candidate does not resolve, Vite keeps the import and the build still succeeds (NO_ENTRY).
  const unresolved = async (result: ViteBuildResult) =>
    (await buildProblems(result)).some((problem) => problem.code === "NO_ENTRY");
  const star = unwrap(await starBuild);
  if (star.errors !== null || star.exports === null || (await unresolved(star))) {
    return failed(star);
  }
  const withDefault = unwrap(await (early ?? settle(build(defaultSource))));
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
 * alone; and, when `options.subpaths` is set, each listed subpath whole. The result is the one
 * today's order of these builds gives (whole, listing, each export in sorted order, each subpath in
 * key order): a build that fails to run (its worker exits, times out or prints an unreadable
 * result) decides it when it comes first in that order, whatever finished first. A failure in the
 * root phase throws; one in the subpath phase leaves the root's results as they are and gives the
 * subpaths `bundle: BUNDLER_ERROR`. Builds after the deciding failure that are still queued are
 * dropped, and those that ran are not reported.
 *
 * The builds run on `options.pool`, or on a pool of the call's own (`bundleWorkers(1)` workers,
 * closed before returning). They start at once, the subpaths as soon as the whole build has passed
 * the toolchain check, unless `options.serial` builds them one after another in today's order (one
 * worker, one candidate at a time: iteration 2's gate F schedule).
 */
export async function measureRootEntry(
  dir: string,
  candidate: string,
  externals: string[],
  options: {
    subpaths?: boolean;
    /** The listing, when the caller has read it already. */
    listing?: ListingResult;
    /** At most this many listed subpaths are built (SUBPATH_LIMIT, the measurement's own cap). */
    subpathLimit?: number;
    /** A stand-in for vite-build.mjs, for the call's own pool (tests). */
    runnerScript?: string;
    /** The run's shared pool. */
    pool?: VitePool;
    serial?: boolean;
    /**
     * Called with the subpath phase's wall time: reading the manifest here (0 when `listing` is
     * given), plus, serially, the end of the root phase to the subpaths' final state (SPEC.md
     * iteration 2, gate F), or otherwise the end of the whole build, when the subpaths may start, to
     * their final state. When the root phase throws, called with the manifest time alone before the
     * error propagates.
     */
    onSubpathPhase?: (ms: number) => void;
  } = {},
): Promise<RootEntryMeasurement> {
  const serial = options.serial === true;
  const listStarted = performance.now();
  const listing = options.subpaths
    ? (options.listing ?? (await readListing(dir, candidate)))
    : null;
  const listMs = options.listing ? 0 : performance.now() - listStarted;
  const own = options.pool
    ? null
    : createVitePool({ size: serial ? 1 : bundleWorkers(1), script: options.runnerScript });
  const pool = options.pool ?? own;
  if (!pool) throw new Error("no vite pool");
  const rootAbort = new AbortController();
  const subpathAbort = new AbortController();
  const builder =
    (signal: AbortSignal) =>
    (source: string, exports = false) =>
      pool.build({ root: dir, source, peers: externals, exports, signal });
  const measurer = (signal: AbortSignal) => async (entry: BundleEntry) =>
    outcomeOf(await builder(signal)(entryModuleSource(entry)), externals, candidate);
  const measure = (name: string | null) => measurer(rootAbort.signal)(entryFor(candidate, name));
  const limit = Math.min(options.subpathLimit ?? SUBPATH_LIMIT, SUBPATH_LIMIT);
  const subpathsOf = (toolchainFailed: boolean) =>
    listing === null
      ? null
      : measureSubpaths(
          (source) => measurer(subpathAbort.signal)(entryFor(candidate, null, source)),
          candidate,
          listing,
          toolchainFailed,
          limit,
          serial,
        ).catch((error: unknown) => {
          subpathAbort.abort();
          return unbuiltSubpaths(
            listing,
            limit,
            `bundle: BUNDLER_ERROR ${reasonText(errorMessage(error))}`,
          );
        });
  try {
    let subpathsStarted = 0;
    let subpathTask: Promise<SubpathMeasurement> | null = null;
    const root = await measureRoot(builder(rootAbort.signal), measure, externals, candidate, {
      serial,
      afterWhole: (whole) => {
        if (serial) return;
        subpathsStarted = performance.now();
        subpathTask = subpathsOf(isToolchainMismatch(whole));
      },
    }).catch((error: unknown) => {
      rootAbort.abort();
      subpathAbort.abort();
      if (listing !== null) options.onSubpathPhase?.(listMs);
      throw error;
    });
    if (listing === null) return { ...root, subpaths: null };
    if (serial) subpathsStarted = performance.now();
    const subpaths = await (subpathTask ?? subpathsOf(isToolchainMismatch(root.whole)));
    options.onSubpathPhase?.(listMs + performance.now() - subpathsStarted);
    return { ...root, subpaths: subpaths ?? unbuiltSubpaths(listing, limit) };
  } finally {
    await own?.close();
  }
}

/**
 * The root phase: the whole build; then, unless it ran on another toolchain, the listing and each
 * export alone (all at once unless `serial`, awaited in sorted order). `afterWhole` runs once the
 * whole build is in.
 */
async function measureRoot(
  build: (source: string, exports?: boolean) => Promise<ViteBuildResult>,
  measure: (name: string | null) => Promise<BundleOutcome>,
  externals: string[],
  candidate: string,
  { serial, afterWhole }: { serial: boolean; afterWhole: (whole: BundleOutcome) => void },
): Promise<RootMeasurement> {
  const whole = await measure(null);
  afterWhole(whole);
  if (isToolchainMismatch(whole)) {
    return { whole, names: null, listProblems: whole.problems, singles: null };
  }
  const listed = await listExports((source) => build(source, true), externals, candidate, serial);
  const { names } = listed;
  if (names === null || names.length > EXPORT_LIMIT) {
    return { whole, names, listProblems: listed.problems, singles: null };
  }
  const singles: ExportOutcome[] = [];
  if (serial) {
    for (const name of names) singles.push({ name, outcome: await measure(name) });
  } else {
    const started = names.map((name) => settle(measure(name)));
    for (const [at, name] of names.entries()) {
      const outcome = started[at];
      if (outcome) singles.push({ name, outcome: unwrap(await outcome) });
    }
  }
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

/** One subpath in full, the detail kept for `--entries` (#10), not in the default report. */
export type SubpathDetail = {
  entry_point: string;
  whole_eager_js_gzip9_bytes: number | null;
  whole_lazy_js_gzip9_bytes: number | null;
  external_packages: string[] | null;
  unmeasurable_codes: string[];
};

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

type Reason = { text: string; joinableCodes: string[] };

const perCode = (problems: BundleProblem[]): Reason[] =>
  bundleReasons(problems).map((text) => ({ text, joinableCodes: [text.split(" ")[1] ?? ""] }));

function addSubpathReasons(reasons: Reason[], subpaths: SubpathMeasurement): void {
  if (subpaths.reason) reasons.push({ text: subpaths.reason, joinableCodes: [] });
  const keysByCode = new Map<string, string[]>();
  for (const { key, outcome } of subpaths.subpaths ?? []) {
    if (outcome.bytes) continue;
    for (const code of failureCodes(outcome))
      keysByCode.set(code, [...(keysByCode.get(code) ?? []), key]);
  }
  for (const code of [...keysByCode.keys()].sort(byCodePoint)) {
    const keys = JSON.stringify(keysByCode.get(code) ?? []);
    const covering = reasons.find((reason) => reason.joinableCodes.includes(code));
    if (covering) covering.text += `; ${code} in subpaths ${keys}`;
    else reasons.push({ text: `bundle: ${code} in subpaths ${keys}`, joinableCodes: [code] });
  }
}

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
    reasons.push({ text: `bundle: EXPORT_LIMIT ${names.length}`, joinableCodes: [] });
  }
  // A failed build that recorded no problem is still reported, as BUILD_ERROR.
  const codesOf = ({ outcome }: ExportOutcome) =>
    outcome.problems.length ? outcome.problems.filter(isNew).map((p) => p.code) : ["BUILD_ERROR"];
  const otherCause = failed.filter((single) => codesOf(single).length);
  if (otherCause.length) {
    const codes = [...new Set(otherCause.flatMap(codesOf))].sort();
    reasons.push({
      text: `bundle: ${otherCause.length} exports unmeasurable (${codes.join(", ")})`,
      joinableCodes: codes,
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
  options: {
    /** Gate F's timing (see `measureRootEntry`), plus this call's own manifest read. */
    onSubpathPhase?: (ms: number) => void;
    /** A stand-in for vite-build.mjs (tests). */
    runnerScript?: string;
    /** The run's shared pool; without one the call uses its own. */
    pool?: VitePool;
    /** Today's order, one build at a time (see `measureRootEntry`). */
    serial?: boolean;
  } = {},
): Promise<{ bundle: Bundle; reasons: string[] }> {
  const { onSubpathPhase, runnerScript, pool, serial } = options;
  const externals = externalPackages(manifest);
  const bundler = await bundlerName();
  const listStarted = performance.now();
  const listed = await readListing(dir, candidate);
  const listMs = performance.now() - listStarted;
  try {
    const measurement = await measureRootEntry(dir, candidate, externals, {
      subpaths: true,
      listing: listed,
      subpathLimit: REPORT_SUBPATH_LIMIT,
      runnerScript,
      pool,
      serial,
      onSubpathPhase: (ms) => onSubpathPhase?.(listMs + ms),
    });
    return rootEntryFacts(measurement, bundler);
  } catch (error) {
    // manifest (a separate cause) keeps its own.
    const crashed: RootEntryMeasurement = {
      whole: { bytes: null, problems: [] },
      names: null,
      listProblems: [],
      singles: null,
      subpaths: unbuiltSubpaths(listed, REPORT_SUBPATH_LIMIT),
    };
    const { bundle, reasons } = rootEntryFacts(crashed, bundler);
    const crash = `bundle: BUNDLER_ERROR ${reasonText(errorMessage(error))}`;
    return { bundle, reasons: [crash, ...reasons] };
  }
}

/**
 * The tree step of the cache (eval/bundle/SPEC.md, "Cache (#8)", "Finding the tree"): npm resolves
 * the tree on every call, and a lockfile whose key is cached is a hit, with no install or build.
 * Nothing here imports Vite; the caller passes the measurement in.
 */
import { join } from "node:path";
import type { BundleOutcome, BundleProblem } from "./bundle.ts";
import type { Cache } from "./cache.ts";
import type { TreeEdge, TreePackage } from "./facts.ts";
import { frozenLock, installInto, readTree, recordFrozenLock, resolveLock } from "./install.ts";
import type {
  ExportOutcome,
  ReportMeasurement,
  RootEntryMeasurement,
  SubpathMeasurement,
  SubpathOutcome,
} from "./root-entry.ts";
import { shipsTypes } from "./types.ts";
import { asArray, isRecord } from "./util.ts";

/** An error from an npm run (execFile's error names the command), not from the cache's files. */
export function isNpmFailure(error: unknown): boolean {
  return isRecord(error) && typeof error.cmd === "string";
}

/**
 * Runs `cached`, and `uncached` instead when the cache failed once open (its directory removed or
 * unwritable, a full disk), so the call still gets every fact. An npm failure is the install's own
 * and is not retried.
 */
export async function withCacheFallback<T>(
  cached: () => Promise<T>,
  uncached: () => Promise<T>,
): Promise<T> {
  try {
    return await cached();
  } catch (error) {
    if (isNpmFailure(error)) throw error;
    return uncached();
  }
}

/** cold: nothing cached for name@version; hit: every part needed was cached; miss: otherwise. */
export type Step = "cold" | "hit" | "miss";

export type CachedFacts = {
  tree: TreePackage[];
  bundledTypes: boolean;
  /** null when not asked for, or when the caller's measurement failed to run. */
  measurement: ReportMeasurement | null;
  step: Step;
};

type FactsPart = { tree: TreePackage[]; bundledTypes: boolean };

export type CachedInstallOptions = {
  /** Measures the install in `dir`; null when bundle facts are not measured in this workspace. */
  measure: ((dir: string) => Promise<ReportMeasurement | null>) | null;
  cacheable: (measurement: ReportMeasurement) => boolean;
  /** Called as an install starts (never on a hit). */
  onInstall?: () => void;
  /** Called once the tree is known, before any build, so lookups that need it can start. */
  onTree?: (tree: TreePackage[]) => void;
};

/**
 * Install facts of name@version, and its measurement when `measure` is given, from the cache when
 * the tree npm resolves now is cached, else from an install of exactly that tree.
 */
export async function cachedInstallFacts(
  cache: Cache,
  resolved: { name: string; version: string; manifest: Record<string, unknown> },
  options: CachedInstallOptions,
): Promise<CachedFacts> {
  const { name, version, manifest } = resolved;
  const staging = await cache.staging();
  let kept = false;
  try {
    const frozen = await frozenLock(name, version);
    const cold = frozen === null && !(await cache.hasVersion(name, version));
    const lock = frozen ?? (cold ? null : await resolveLock(staging, name, version));
    if (lock !== null) {
      const hit = await readHit(
        cache,
        name,
        version,
        cache.keys(lock, name, version).entry,
        options,
      );
      if (hit) {
        options.onTree?.(hit.tree);
        return { ...hit, step: "hit" };
      }
    }
    options.onInstall?.();
    const written = await installInto(staging, name, version, lock);
    if (lock !== null && frozen === null) await recordFrozenLock(staging, name, version);
    const keys = cache.keys(written, name, version);
    const { tree, whole } = await readTree(staging, { omit: cache.npm.omit });
    options.onTree?.(tree);
    const [bundledTypes, measurement] = await Promise.all([
      shipsTypes(join(staging, "node_modules", name), manifest),
      options.measure ? options.measure(staging) : null,
    ]);
    if (whole) {
      // A cache that fails partway leaves this call's facts as measured.
      try {
        const facts: FactsPart = { tree, bundledTypes };
        await cache.write("facts", name, version, keys.entry, facts);
        if (measurement && options.cacheable(measurement)) {
          await cache.write("bundle", name, version, keys.entry, measurement);
        }
        kept = await cache.publishInstall(staging, keys.install);
      } catch {
        kept = false;
      }
    }
    return { tree, bundledTypes, measurement, step: cold ? "cold" : "miss" };
  } finally {
    if (!kept) await cache.discard(staging).catch(() => {});
  }
}

async function readHit(
  cache: Cache,
  name: string,
  version: string,
  key: string,
  options: CachedInstallOptions,
): Promise<Omit<CachedFacts, "step"> | null> {
  const facts = asFacts(await cache.read("facts", name, version, key).catch(() => null));
  if (!facts) return null;
  if (!options.measure) return { ...facts, measurement: null };
  const measurement = asReportMeasurement(
    await cache.read("bundle", name, version, key).catch(() => null),
  );
  return measurement ? { ...facts, measurement } : null;
}

// --- reading parts back, without type assertions -------------------------------------------------

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const nullOr =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T | null =>
    value === null || guard(value);
const arrayOf =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(guard);

function isEdge(value: unknown): value is TreeEdge {
  return isRecord(value) && isString(value.key) && isString(value.name) && isString(value.range);
}

function isTreePackage(value: unknown): value is TreePackage {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.name) &&
    isString(value.version) &&
    arrayOf(isEdge)(value.edges) &&
    typeof value.installed === "boolean" &&
    isNumber(value.diskBytes) &&
    typeof value.hasInstallScript === "boolean" &&
    typeof value.nativeBinary === "boolean" &&
    nullOr(isString)(value.license)
  );
}

function asFacts(value: unknown): FactsPart | null {
  if (!isRecord(value) || typeof value.bundledTypes !== "boolean") return null;
  const tree = asArray(value.tree);
  if (!Array.isArray(value.tree) || !tree.every(isTreePackage)) return null;
  return { tree: tree.filter(isTreePackage), bundledTypes: value.bundledTypes };
}

function isProblem(value: unknown): value is BundleProblem {
  return isRecord(value) && isString(value.code) && nullOr(isString)(value.specifier);
}

function isOutcome(value: unknown): value is BundleOutcome {
  if (!isRecord(value)) return false;
  if (value.bytes === null) return arrayOf(isProblem)(value.problems);
  const bytes = value.bytes;
  return (
    isRecord(bytes) &&
    isNumber(bytes.eager_js_min_bytes) &&
    isNumber(bytes.eager_js_gzip9_bytes) &&
    isNumber(bytes.lazy_js_min_bytes) &&
    isNumber(bytes.lazy_js_gzip9_bytes) &&
    Array.isArray(value.problems) &&
    value.problems.length === 0 &&
    isStringArray(value.externals)
  );
}

function isExportOutcome(value: unknown): value is ExportOutcome {
  return isRecord(value) && isString(value.name) && isOutcome(value.outcome);
}

function isSubpathOutcome(value: unknown): value is SubpathOutcome {
  return isRecord(value) && isString(value.key) && isOutcome(value.outcome);
}

function isSubpaths(value: unknown): value is SubpathMeasurement {
  return (
    isRecord(value) &&
    nullOr((v): v is boolean => typeof v === "boolean")(value.exportsMap) &&
    nullOr(isNumber)(value.listed) &&
    nullOr(isStringArray)(value.patterns) &&
    nullOr(arrayOf(isSubpathOutcome))(value.subpaths) &&
    nullOr(isString)(value.reason)
  );
}

function isMeasurement(value: unknown): value is RootEntryMeasurement {
  return (
    isRecord(value) &&
    isOutcome(value.whole) &&
    nullOr(isStringArray)(value.names) &&
    arrayOf(isProblem)(value.listProblems) &&
    nullOr(arrayOf(isExportOutcome))(value.singles) &&
    nullOr(isSubpaths)(value.subpaths)
  );
}

/** A cached measurement; only measurements that ran (no crash, a time) are ever stored. */
export function asReportMeasurement(value: unknown): ReportMeasurement | null {
  if (!isRecord(value) || value.crash !== null || !isString(value.measuredAt)) return null;
  const { measurement, measuredAt } = value;
  return isMeasurement(measurement) ? { measurement, crash: null, measuredAt } : null;
}

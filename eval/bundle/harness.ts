/**
 * What score.ts and wild-score.ts share: running the depfit CLI, reading its `bundle` fields, and
 * the reference bands.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  errorMessage,
  isRecord,
} from "../../src/collect/util.ts";
import { type Case, CLI } from "./cases.ts";

const run = promisify(execFile);
const TRACE_PRELOAD = join(import.meta.dirname, "trace-loads.js");

/** The four numbers under `packages[].bundle` that gates B and C compare. */
export type ByteField = "min_bytes" | "gzip_bytes" | "lazy_min_bytes" | "lazy_gzip_bytes";
export const BYTE_FIELDS: ByteField[] = [
  "min_bytes",
  "gzip_bytes",
  "lazy_min_bytes",
  "lazy_gzip_bytes",
];

/**
 * Where each number lives under `packages[].bundle`. Keys are the names used in reference.json;
 * this is the only place that knows depfit's JSON names.
 */
export const REPORT_FIELD: Record<ByteField, string> = {
  min_bytes: "eager_js_min_bytes",
  gzip_bytes: "eager_js_gzip9_bytes",
  lazy_min_bytes: "lazy_js_min_bytes",
  lazy_gzip_bytes: "lazy_js_gzip9_bytes",
};

// --- running the CLI -----------------------------------------------------------------------------

export type CliRun = {
  ms: number;
  /** Parsed JSON on stdout, or null when the CLI printed none. */
  report: Record<string, unknown> | null;
  /** First line of stderr when the CLI failed. */
  error: string | null;
  /** Modules named rolldown* or vite* that were resolved during the run. */
  rolldownLoads: string[];
};

export async function depfit(args: string[], scratch: string, trace = false): Promise<CliRun> {
  const traceFile = join(scratch, "loads.log");
  await rm(traceFile, { force: true });
  const bunArgs = trace ? ["--preload", TRACE_PRELOAD, CLI] : [CLI];
  const started = performance.now();
  let stdout = "";
  let error: string | null = null;
  try {
    const out = await run("bun", [...bunArgs, ...args, "--json", "--cwd", scratch], {
      env: { ...process.env, DEPFIT_TRACE_LOADS: traceFile },
      maxBuffer: 1 << 26,
      timeout: 600_000,
    });
    stdout = out.stdout;
  } catch (failure) {
    const stderr = isRecord(failure) ? asString(failure.stderr) : null;
    stdout = isRecord(failure) ? (asString(failure.stdout) ?? "") : "";
    error = (stderr ?? errorMessage(failure)).trim().split("\n")[0] ?? "failed";
  }
  const ms = Math.round(performance.now() - started);
  const loads = await readFile(traceFile, "utf8").catch(() => "");
  let report: Record<string, unknown> | null = null;
  try {
    report = asRecord(JSON.parse(stdout));
  } catch {}
  return {
    ms,
    report,
    error: report ? null : error,
    rolldownLoads: loads.split("\n").filter(Boolean),
  };
}

/** The candidate's entry in the report (the CLI is always run with one candidate). */
export function packageOf(report: Record<string, unknown> | null): Record<string, unknown> | null {
  const packages = asArray(report?.packages);
  return packages.length ? asRecord(packages[0]) : null;
}

export async function scratchProject(target: Case["target"]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-score-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "scratch", private: true }));
  if (target === "workerd") {
    const toml = 'name = "scratch"\ncompatibility_date = "2025-01-01"\n';
    await writeFile(join(dir, "wrangler.toml"), toml);
  }
  return dir;
}

// --- reading what depfit printed ----------------------------------------------------------------

export type Bundle = Record<ByteField, number | null>;
/** Either a problem that makes the run unusable, or the bundle and its `bundle:` reasons. */
export type Observed =
  | { problem: string }
  | { bundle: Bundle; reasons: string[]; target: string | null; bundler: string | null };

export function observe(cli: CliRun | undefined): Observed {
  if (!cli?.report) return { problem: `cli: ${cli?.error ?? "no output"}` };
  const pkg = packageOf(cli.report);
  if (!pkg || !("bundle" in pkg)) return { problem: "package has no `bundle` key" };
  if (!isRecord(pkg.bundle)) return { problem: "bundle is null although --bundle-entry was given" };
  const raw = pkg.bundle;
  const bundle: Bundle = {
    min_bytes: asNumber(raw[REPORT_FIELD.min_bytes]),
    gzip_bytes: asNumber(raw[REPORT_FIELD.gzip_bytes]),
    lazy_min_bytes: asNumber(raw[REPORT_FIELD.lazy_min_bytes]),
    lazy_gzip_bytes: asNumber(raw[REPORT_FIELD.lazy_gzip_bytes]),
  };
  const reasons = asStringArray(pkg.unavailable).filter((entry) => entry.startsWith("bundle:"));
  return { bundle, reasons, target: asString(raw.target), bundler: asString(raw.bundler) };
}

/** Does `unavailable` hold `bundle: <code>`, followed by the specifier when the case names one? */
export function hasCode(reasons: string[], c: Case): boolean {
  const prefix = `bundle: ${c.code}`;
  return reasons.some(
    (entry) =>
      (entry === prefix || entry.startsWith(`${prefix} `)) &&
      (!c.specifier || entry.includes(c.specifier)),
  );
}

// --- references and bands ------------------------------------------------------------------------

export type Range = { lo: number; hi: number };

/**
 * min/max of the successful rollup and webpack builds for one field, or null when neither built.
 * A bundler listed in the case's `band_excluded` (reference.json) is left out, with its reason there.
 * Vite is not part of the band (it is gate C's anchor).
 */
export function referenceRange(refs: Record<string, unknown>, field: ByteField): Range | null {
  const excluded = asRecord(refs.band_excluded);
  const values = ["rollup", "webpack"]
    .filter((bundler) => typeof excluded[bundler] !== "string")
    .map((bundler) => asNumber(asRecord(refs[bundler])[field]))
    .filter((value): value is number => value !== null);
  return values.length ? { lo: Math.min(...values), hi: Math.max(...values) } : null;
}

/**
 * Absolute slack of the band and the gross-error range (SPEC "Band"). A larger one (1000 B) was
 * rejected in Codex review round 4 because it hid a 16.7% error; explained differences in wrapper
 * code go in exceptions.json instead.
 */
export const SLACK_BYTES = 100;
export const inBand = (x: number, r: Range) =>
  x >= 0.9 * r.lo - SLACK_BYTES && x <= 1.1 * r.hi + SLACK_BYTES;
export const grossError = (x: number, r: Range) =>
  x < 0.5 * r.lo - SLACK_BYTES || x > 2 * r.hi + SLACK_BYTES;

/** The band of every byte field, or null when the case has no successful reference build. */
export function referenceRanges(refs: Record<string, unknown>): Record<ByteField, Range> | null {
  const [min, gzip, lazyMin, lazyGzip] = BYTE_FIELDS.map((field) => referenceRange(refs, field));
  return min && gzip && lazyMin && lazyGzip
    ? { min_bytes: min, gzip_bytes: gzip, lazy_min_bytes: lazyMin, lazy_gzip_bytes: lazyGzip }
    : null;
}

/**
 * Gate C's conformance build: a stock `vite build` of the same snippet with depfit's documented
 * configuration, made by reference.ts without depfit's code (`vite` in reference.json), all four
 * fields; null when it was not (or could not be) built.
 */
export function viteReference(refs: Record<string, unknown>): Record<ByteField, number> | null {
  const vite = asRecord(refs.vite);
  const values = BYTE_FIELDS.map((field) => asNumber(vite[field]));
  const [min, gzip, lazyMin, lazyGzip] = values;
  return min != null && gzip != null && lazyMin != null && lazyGzip != null
    ? { min_bytes: min, gzip_bytes: gzip, lazy_min_bytes: lazyMin, lazy_gzip_bytes: lazyGzip }
    : null;
}

/**
 * Gate C: minified bytes must be identical (the same build); gzip may differ by this fraction,
 * because depfit gzips with its runtime's zlib (Bun) and reference.ts with Node's.
 */
export const GZIP_RUNTIME_TOLERANCE = 0.01;

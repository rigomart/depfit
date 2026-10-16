/**
 * Gate W (SPEC.md, README.md "Gate W"): runs the depfit CLI on every package of wild.json as
 * `import * as m from "<name>"`, compares numbers with wild-reference.json, and joins the
 * independent auditor's findings from the reference builds. Started by `score.ts --wild`.
 *
 * Pass: (i) no package where depfit gives a number and the auditor found code fetched from outside
 * the bundle (`import()` of a non-chunk target, `importScripts`), (ii) no gross error against the
 * references, except a reviewed one in wild-exceptions.json whose recorded package, lock, depfit
 * bytes and reference bytes all still match exactly, (iii) every null carries a code.
 * The null rate by code is reported, with no threshold. Other auditor findings (require, eval,
 * Function) are information only.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asNumber, asRecord, asString } from "../../src/collect/util.ts";
import { entryArgs, loadWild, loadWildPackages } from "./cases.ts";
import {
  BYTE_FIELDS,
  depfit,
  grossError,
  inBand,
  observe,
  REPORT_FIELD,
  referenceRanges,
  scratchProject,
  viteValue,
} from "./harness.ts";
import { type Hit, hasFetch } from "./wild-audit.ts";

const HERE = import.meta.dirname;
const RESULTS_DIR = join(HERE, "results");
const RUN_DIR = join(RESULTS_DIR, "wild-run");
/** Same pause as eval/run.ts between CLI runs: npm's downloads API rate-limits bursts. */
const PAUSE_MS = 3000;
const CONCURRENCY = 2;

type Outcome = "number" | "null" | "error";
type Audit = { rollup: Hit[] | null; webpack: Hit[] | null };

type WildResult = {
  id: string;
  name: string;
  version: string;
  downloads_last_month: number;
  outcome: Outcome;
  /** The four byte fields when outcome is "number". */
  bytes: Record<string, number | null> | null;
  /** Code of the first `bundle:` entry in `unavailable` when outcome is "null". */
  code: string | null;
  /** All `bundle:` entries of `unavailable`. */
  reasons: string[];
  /** Why the CLI result is unusable when outcome is "error". */
  problem: string | null;
  ms: number;
  reference: { rollup: boolean; webpack: boolean };
  audit: Audit | null;
  /** Gate W (i): the auditor found a load in the rollup or webpack output. */
  auditor_fetch: boolean;
  /** Gate W (ii): gross errors against the references, unless a reviewed exception matches. */
  gross: string[];
  /** Gross errors a reviewed exception in wild-exceptions.json covers: listed, not failed. */
  reviewed_exception: string[];
  out_of_band: string[];
};

function parseHits(value: unknown): Hit[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const raw = asRecord(item);
    return {
      pattern: asString(raw.pattern) ?? "?",
      strength: raw.strength === "fetch" ? "fetch" : raw.strength === "load" ? "load" : "mention",
      snippet: asString(raw.snippet) ?? "",
      count: asNumber(raw.count) ?? 0,
    };
  });
}

const describeHits = (hits: Hit[] | null) =>
  hits === null
    ? "(no output: the reference build failed)"
    : hits.length
      ? hits
          .map((hit) => `${hit.strength} \`${hit.pattern}\` x${hit.count}: \`${hit.snippet}\``)
          .join("\n    ")
      : "(no matches)";

/**
 * A gross error reviewed and explained by hand (wild-exceptions.json). It covers one package only
 * while everything it was reviewed on is unchanged: version, frozen lock, depfit's four byte fields,
 * and both references' four byte fields. Any difference makes the gross error count again.
 */
type ReviewedException = {
  id: string;
  version: string;
  lock_sha256: string;
  bytes: Record<string, number>;
  rollup: Record<string, number>;
  webpack: Record<string, number>;
  cause: string;
};

async function loadExceptions(): Promise<ReviewedException[]> {
  const raw = asRecord(JSON.parse(await readFile(join(HERE, "wild-exceptions.json"), "utf8")));
  const numbers = (value: unknown) =>
    Object.fromEntries(BYTE_FIELDS.map((field) => [field, asNumber(asRecord(value)[field]) ?? -1]));
  return (Array.isArray(raw.exceptions) ? raw.exceptions : []).map((item) => {
    const entry = asRecord(item);
    return {
      id: asString(entry.id) ?? "",
      version: asString(entry.version) ?? "",
      lock_sha256: asString(entry.lock_sha256) ?? "",
      bytes: numbers(entry.bytes),
      rollup: numbers(entry.rollup),
      webpack: numbers(entry.webpack),
      cause: asString(entry.cause) ?? "",
    };
  });
}

export async function lockSha256(id: string): Promise<string> {
  const lock = await readFile(join(HERE, "locks", "wild", `${id}.json`));
  return createHash("sha256").update(lock).digest("hex");
}

/** Why a reviewed exception does not cover this result, or null when it does. */
function exceptionMismatch(
  exception: ReviewedException,
  version: string,
  lock: string,
  bytes: Record<string, number | null>,
  reference: Record<string, unknown>,
): string | null {
  if (exception.version !== version) return `version ${version} vs reviewed ${exception.version}`;
  if (exception.lock_sha256 !== lock) return "lock changed since review";
  for (const field of BYTE_FIELDS) {
    if (bytes[field] !== exception.bytes[field]) return `depfit ${field} changed since review`;
    for (const side of ["rollup", "webpack"] as const) {
      const now = asNumber(asRecord(reference[side])[field]);
      if (now !== exception[side][field]) return `${side} ${field} changed since review`;
    }
  }
  return null;
}

async function measureOne(
  scratch: string,
  reference: Record<string, unknown>,
  pkg: { id: string; name: string; version: string; downloads: number },
  args: string[],
  exception: ReviewedException | null,
): Promise<WildResult> {
  const cli = await depfit([`${pkg.name}@${pkg.version}`, ...args], scratch);
  const seen = observe(cli);
  const ranges = referenceRanges(reference);
  const audit: Audit = {
    rollup: parseHits(asRecord(reference.audit).rollup),
    webpack: parseHits(asRecord(reference.audit).webpack),
  };
  const base = {
    id: pkg.id,
    name: pkg.name,
    version: pkg.version,
    downloads_last_month: pkg.downloads,
    ms: cli.ms,
    reference: {
      rollup: asNumber(asRecord(reference.rollup).gzip_bytes) !== null,
      webpack: asNumber(asRecord(reference.webpack).gzip_bytes) !== null,
    },
    audit,
    auditor_fetch: hasFetch(audit.rollup ?? []) || hasFetch(audit.webpack ?? []),
    gross: [] as string[],
    reviewed_exception: [] as string[],
    out_of_band: [] as string[],
  };
  if ("problem" in seen) {
    return {
      ...base,
      outcome: "error",
      bytes: null,
      code: null,
      reasons: [],
      problem: seen.problem,
    };
  }
  const nulls = BYTE_FIELDS.filter((field) => seen.bundle[field] === null);
  if (nulls.length) {
    const reasons = seen.reasons;
    const code = reasons[0]?.split(" ")[1] ?? null;
    const partial = nulls.length < BYTE_FIELDS.length;
    return {
      ...base,
      outcome: partial || !reasons.length ? "error" : "null",
      bytes: null,
      code,
      reasons,
      problem: partial
        ? "only some byte fields are null"
        : reasons.length
          ? null
          : "null without a `bundle:` entry in unavailable",
    };
  }
  let gross: string[] = [];
  let reviewed: string[] = [];
  const outOfBand: string[] = [];
  if (ranges) {
    for (const field of BYTE_FIELDS) {
      const x = seen.bundle[field] ?? 0;
      const range = ranges[field];
      const text = `${REPORT_FIELD[field]} ${x} vs ${range.lo}..${range.hi}, vite ${viteValue(reference, field) ?? "not built"}`;
      if (grossError(x, range)) gross.push(text);
      else if (!inBand(x, range)) outOfBand.push(text);
    }
  }
  if (gross.length && exception) {
    const lock = await lockSha256(pkg.id);
    const mismatch = exceptionMismatch(exception, pkg.version, lock, seen.bundle, reference);
    if (mismatch) gross = gross.map((text) => `${text} (reviewed exception stale: ${mismatch})`);
    else [reviewed, gross] = [[...gross, `cause: ${exception.cause}`], []];
  }
  return {
    ...base,
    outcome: "number",
    bytes: seen.bundle,
    code: null,
    reasons: seen.reasons,
    problem: null,
    gross,
    reviewed_exception: reviewed,
    out_of_band: outOfBand,
  };
}

async function runAll(resume: boolean): Promise<WildResult[]> {
  const packages = await loadWild();
  const downloads = new Map(
    (await loadWildPackages()).map((pkg) => [pkg.name, pkg.downloads_last_month]),
  );
  const references = asRecord(
    asRecord(JSON.parse(await readFile(join(HERE, "wild-reference.json"), "utf8"))).cases,
  );
  const exceptions = await loadExceptions();
  if (!resume) await rm(RUN_DIR, { recursive: true, force: true });
  await mkdir(RUN_DIR, { recursive: true });
  const scratch = await scratchProject("browser");
  const queue = [...packages];
  const done: WildResult[] = [];
  try {
    const workers = Array.from({ length: CONCURRENCY }, async (_, index) => {
      await new Promise((resolve) => setTimeout(resolve, index * (PAUSE_MS / CONCURRENCY)));
      for (let c = queue.shift(); c; c = queue.shift()) {
        const file = join(RUN_DIR, `${c.id}.json`);
        const cached = resume ? await readFile(file, "utf8").catch(() => null) : null;
        if (cached) {
          done.push(JSON.parse(cached));
          continue;
        }
        const result = await measureOne(
          scratch,
          asRecord(references[c.id]),
          {
            id: c.id,
            name: c.package,
            version: c.version,
            downloads: downloads.get(c.package) ?? 0,
          },
          entryArgs(c.imports),
          exceptions.find((e) => e.id === c.id) ?? null,
        );
        await writeFile(file, `${JSON.stringify(result)}\n`);
        done.push(result);
        console.log(
          `${done.length}/${packages.length} ${c.package}: ${result.outcome}${result.code ? ` ${result.code}` : ""}${result.auditor_fetch ? " [auditor: fetch]" : ""}`,
        );
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    });
    await Promise.all(workers);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const order = new Map(packages.map((c, i) => [c.id, i]));
  return done.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function runWild(options: { resume: boolean }): Promise<void> {
  const results = await runAll(options.resume);
  const numbers = results.filter((r) => r.outcome === "number");
  const nulls = results.filter((r) => r.outcome === "null");
  const errors = results.filter((r) => r.outcome === "error");
  const fetchedNumbers = numbers.filter((r) => r.auditor_fetch);
  const grossErrors = numbers.filter((r) => r.gross.length);
  const reviewedExceptions = numbers.filter((r) => r.reviewed_exception?.length);
  const unverified = numbers.filter((r) => !r.reference.rollup && !r.reference.webpack);
  const unaudited = numbers.filter((r) => !r.audit?.rollup && !r.audit?.webpack);
  const otherLoads = (r: WildResult) =>
    [r.audit?.rollup, r.audit?.webpack].some((hits) => hits?.some((h) => h.strength === "load"));

  const byCode = new Map<string, number>();
  for (const r of nulls) byCode.set(r.code ?? "?", (byCode.get(r.code ?? "?") ?? 0) + 1);
  const pct = (n: number) => `${((100 * n) / (results.length || 1)).toFixed(1)}%`;
  const verdict = (count: number) => (count ? "FAIL" : "PASS");

  const lines: string[] = [];
  lines.push(`Gate W: wild corpus (${results.length} packages)`);
  lines.push(
    `  numbers ${numbers.length} (${pct(numbers.length)}), nulls ${nulls.length} (${pct(nulls.length)}), without a usable result ${errors.length}`,
  );
  lines.push(
    `  null rate by code: ${[...byCode].map(([code, n]) => `${code} ${n} (${pct(n)})`).join(", ") || "none"}`,
  );
  lines.push(
    `  (i) numbers where the auditor found code fetched from outside the bundle: ${fetchedNumbers.length} (max 0) ${verdict(fetchedNumbers.length)}`,
  );
  lines.push(
    `  (ii) gross errors against the references (reviewed exceptions excluded): ${grossErrors.length} (max 0) ${verdict(grossErrors.length)}`,
  );
  lines.push(
    `  (iii) packages that are neither a number nor a null with a code: ${errors.length} (max 0) ${verdict(errors.length)}`,
  );
  lines.push(
    `  info: gross errors covered by a reviewed exception ${reviewedExceptions.length}; numbers outside the band but not gross ${numbers.filter((r) => r.out_of_band.length).length}; numbers with neither reference built ${unverified.length}; numbers with no audited output ${unaudited.length}; numbers where the auditor found other loads (require, eval, Function, ...) ${numbers.filter(otherLoads).length}`,
  );
  if (fetchedNumbers.length) {
    lines.push("\n(i) numbers with code fetched from outside the bundle:");
    for (const r of fetchedNumbers) {
      for (const side of ["rollup", "webpack"] as const) {
        const fetches = (r.audit?.[side] ?? []).filter((hit) => hit.strength === "fetch");
        if (fetches.length)
          lines.push(`  ${r.name}@${r.version} [${side}]\n    ${describeHits(fetches)}`);
      }
    }
  }
  if (grossErrors.length) {
    lines.push("\n(ii) gross errors:");
    for (const r of grossErrors) lines.push(`  ${r.name}@${r.version}: ${r.gross.join(", ")}`);
  }
  if (reviewedExceptions.length) {
    lines.push(
      "\ngross errors covered by a reviewed exception (wild-exceptions.json, not failed):",
    );
    for (const r of reviewedExceptions)
      lines.push(`  ${r.name}@${r.version}: ${r.reviewed_exception.join(", ")}`);
  }
  if (errors.length) {
    lines.push("\n(iii) no usable result:");
    for (const r of errors) lines.push(`  ${r.name}@${r.version}: ${r.problem}`);
  }
  console.log(`\n${lines.join("\n")}`);

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS_DIR, `wild-${stamp}.json`);
  await writeFile(
    out,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        summary: {
          packages: results.length,
          numbers: numbers.length,
          nulls: nulls.length,
          errors: errors.length,
          null_by_code: Object.fromEntries(byCode),
          numbers_with_auditor_fetch: fetchedNumbers.map((r) => r.name),
          gross_errors: grossErrors.map((r) => r.name),
          reviewed_exceptions: reviewedExceptions.map((r) => r.name),
          numbers_with_other_auditor_loads: numbers.filter(otherLoads).map((r) => r.name),
        },
        packages: results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${out}`);
}

/**
 * Iteration 2's scorecard (SPEC.md, "Iteration 2: subpaths of the `exports` map, measured whole",
 * with bar amendment 6). One subcommand per group of gates; writes results/subpath-<gate>-<time>.json
 * (gitignored) and prints the verdicts.
 *
 *   bun eval/bundle/subpath-score.ts listing     # L (ii): 288 manifests against resolve.exports 2.0.3
 *   bun eval/bundle/subpath-score.ts reference   # A, B, C, D on subpath-set.json (subpath-reference.json)
 *   bun eval/bundle/subpath-score.ts probes      # A and D on the probe packages; F's subpath time
 *   bun eval/bundle/subpath-score.ts report [--on dir] [--again dir] [--off dir]   # E, D, R
 *   bun eval/bundle/subpath-score.ts comprehension   # H0 prompt and key (11 questions)
 *
 * `listing` fetches manifests from the npm registry. `reference` replays the frozen wild locks.
 * `probes` replays the frozen probe trees (`--locks`, default eval/results/v7/locks) at the versions
 * of the control run (`--control`, default eval/results/v7-control). `report` reads three runs of
 * eval/run.ts over those trees, as root-score.ts does for iteration 1.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { externalPackages } from "../../src/collect/bundle.ts";
import { withIsolatedInstall } from "../../src/collect/install.ts";
import {
  measureRootEntry,
  REPORT_SUBPATH_LIMIT,
  type RootEntryMeasurement,
  rootEntryBundle,
  rootEntryFacts,
  subpathDetail,
} from "../../src/collect/root-entry.ts";
import { byCodePoint, listSubpaths } from "../../src/collect/subpaths.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  isRecord,
} from "../../src/collect/util.ts";
import { FIELD_DESCRIPTIONS } from "../../src/schema-docs.ts";
import { loadWildPackages, wildId } from "./cases.ts";
import { firstDiff, NETWORK_ENTRY, withoutBundle } from "./contract.ts";
import {
  BYTE_FIELDS,
  type ByteField,
  depfit,
  GZIP_RUNTIME_TOLERANCE,
  grossError,
  inBand,
  referenceRanges,
  scratchProject,
} from "./harness.ts";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const REPO = join(HERE, "../..");
const RESULTS_DIR = join(HERE, "results");
const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");
const NPM_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
const PROBE_COUNT = 32;
/** sha256 of the frozen holdout probes (STATUS.md). */
const HOLDOUT_SHA256: Record<string, string> = {
  "holdout-1": "f792fac58becfaed39b978a33e2e118526652b9cb6c9214b424d9cf2461f8466",
  "holdout-2": "c39c0792cdc4fc44b13b7e34b8202fe06307d6c64d468463903a0b73e34a3dde",
};

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8").catch(() => "null"));

async function save(gate: string, data: unknown): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS_DIR, `subpath-${gate}-${stamp}.json`);
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}

// --- L: listing ---------------------------------------------------------------------------------

type Spec = { name: string; version: string; source: string };

/** The npm packages of every probe report in `dir`, as name@version, with their count per probe. */
async function probeSpecs(dir: string): Promise<Map<string, Spec & { count: number }>> {
  const specs = new Map<string, Spec & { count: number }>();
  for (const { project, base } of await probeFiles(dir)) {
    const report = asRecord(await readJson(join(dir, project, `${base}.json`)));
    for (const pkg of asArray(report.packages).map(asRecord)) {
      const name = asString(pkg.name);
      const version = asString(pkg.version);
      if (pkg.kind !== "npm" || !name || !version) continue;
      const key = `${name}@${version}`;
      const count = (specs.get(key)?.count ?? 0) + 1;
      specs.set(key, { name, version, source: "probe", count });
    }
  }
  return specs;
}

async function fetchManifest(name: string, version: string): Promise<Record<string, unknown>> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url);
    if (response.ok) return asRecord(await response.json());
    await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
  }
  throw new Error(`${name}@${version}: registry fetch failed`);
}

type ResolveExports = (pkg: unknown, entry: string, options: unknown) => string[] | undefined;

/** resolve.exports 2.0.3, the resolver Vite 8.3.4 bundles, installed into a temp dir. */
async function loadResolveExports(): Promise<{ resolve: ResolveExports; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-resolve-exports-"));
  await writeFile(join(dir, "package.json"), '{ "private": true }');
  await run("npm", ["install", "resolve.exports@2.0.3", "--save-exact", ...NPM_FLAGS], {
    cwd: dir,
    timeout: 120_000,
  });
  const entry = join(dir, "node_modules", "resolve.exports", "dist", "index.mjs");
  const mod = asRecord(await import(pathToFileURL(entry).href));
  const resolve = mod.exports;
  if (typeof resolve !== "function") throw new Error("resolve.exports has no exports()");
  return {
    resolve: (pkg, entryKey, options) => {
      const result: unknown = resolve(pkg, entryKey, options);
      return Array.isArray(result) ? asStringArray(result) : undefined;
    },
    dir,
  };
}

/**
 * The listing rule (SPEC.md) with resolve.exports doing the resolution: keys and pattern keys,
 * independent of depfit's own resolver.
 */
function independentListing(
  manifest: Record<string, unknown>,
  resolve: ResolveExports,
): { exportsMap: boolean; keys: string[]; patterns: string[] } {
  const field = manifest.exports;
  if (!field) return { exportsMap: false, keys: [], patterns: [] };
  if (!isRecord(field)) return { exportsMap: true, keys: [], patterns: [] };
  const all = Object.keys(field);
  if (!all[0]?.startsWith(".")) return { exportsMap: true, keys: [], patterns: [] };
  const keys: string[] = [];
  const patterns = all.filter((key) => key.includes("*"));
  for (const key of all) {
    if (key.includes("*") || key === "." || key === "./package.json" || key.endsWith("/")) continue;
    if (!key.startsWith("./")) continue;
    let target: string | undefined;
    try {
      target = resolve({ name: "x", ...manifest }, key, {
        conditions: ["module", "browser", "production", "import"],
        unsafe: true,
      })?.[0];
    } catch {
      target = undefined;
    }
    if (target !== undefined && /\.(?:m|c)?jsx?$/.test(target)) keys.push(key);
  }
  return { exportsMap: true, keys, patterns };
}

/** Gate B's rule over listed keys: all when 3 or fewer, else first, middle and last, sorted. */
function pickThree(keys: string[]): string[] {
  const sorted = [...keys].sort(byCodePoint);
  if (sorted.length <= 3) return sorted;
  return [sorted[0], sorted[Math.floor((sorted.length - 1) / 2)], sorted.at(-1)].flatMap((key) =>
    key === undefined ? [] : [key],
  );
}

async function scoreListing(control: string): Promise<void> {
  const { resolve, dir } = await loadResolveExports();
  const specs: Spec[] = [
    ...[...(await probeSpecs(control)).values()].map(({ name, version, source }) => ({
      name,
      version,
      source,
    })),
    ...(await loadWildPackages()).map((p) => ({
      name: p.name,
      version: p.version,
      source: "wild",
    })),
  ];
  const coverage: string[] = [];
  if (specs.length !== 288) coverage.push(`${specs.length} manifests, not 288`);
  const differences: string[] = [];
  const listings = new Map<string, string[]>();
  let listed = 0;
  try {
    for (const spec of specs) {
      const manifest = await fetchManifest(spec.name, spec.version);
      const depfit = listSubpaths(manifest);
      const independent = independentListing(manifest, resolve);
      const keys = depfit.subpaths.map((s) => s.key);
      listed += keys.length;
      const label = `${spec.source} ${spec.name}@${spec.version}`;
      if (depfit.exportsMap !== independent.exportsMap) differences.push(`${label}: exports_map`);
      if (JSON.stringify(keys) !== JSON.stringify(independent.keys)) {
        differences.push(`${label}: keys ${keys.join(" ")} vs ${independent.keys.join(" ")}`);
      }
      if (JSON.stringify(depfit.patterns) !== JSON.stringify(independent.patterns)) {
        differences.push(`${label}: patterns ${depfit.patterns} vs ${independent.patterns}`);
      }
      if (spec.source === "wild") listings.set(spec.name, independent.keys);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Gate B's frozen set must be what this listing gives under the rule.
  const set = asArray(asRecord(await readJson(join(HERE, "subpath-set.json"))).packages).map(
    asRecord,
  );
  const fromRule = (await loadWildPackages())
    .filter((p) => (listings.get(p.name) ?? []).length > 0)
    .slice(0, 20)
    .map((p) => ({ package: p.name, subpaths: pickThree(listings.get(p.name) ?? []) }));
  const frozen = set.map((p) => ({
    package: asString(p.package) ?? "",
    subpaths: asStringArray(p.subpaths),
  }));
  const setMatches = JSON.stringify(fromRule) === JSON.stringify(frozen);
  const lines = [
    `Iteration 2, gate L (ii): ${specs.length} manifests, ${listed} listed keys`,
    `  coverage: ${coverage.length} problems ${verdict(!coverage.length)}`,
    ...coverage.map((c) => `    ${c}`),
    `  depfit's listing equals resolve.exports 2.0.3 under the rule: ${differences.length} differences ${verdict(!differences.length && !coverage.length)}`,
    ...differences.map((d) => `    ${d}`),
    `  gate B's frozen set equals the rule over this listing: ${verdict(setMatches)}`,
  ];
  console.log(lines.join("\n"));
  await save("listing", { coverage, differences, fromRule, setMatches });
}

// --- A, B, C, D on the reference set -----------------------------------------------------------

type ExpectedNull = { package: string; subpath: string; code: string; specifiers: unknown };

async function loadExpectedNulls(): Promise<ExpectedNull[]> {
  const raw = asRecord(await readJson(join(HERE, "subpath-nulls.json")));
  // Each entry carries its own review; an unreviewed or pending entry waives nothing.
  const isReviewed = (item: unknown) => {
    const reviewed = asString(asRecord(item).reviewed) ?? "";
    return reviewed !== "" && !reviewed.startsWith("pending");
  };
  return asArray(raw.nulls)
    .filter(isReviewed)
    .map((item) => {
      const entry = asRecord(item);
      return {
        package: asString(entry.package) ?? "",
        subpath: asString(entry.subpath) ?? "",
        code: asString(entry.code) ?? "",
        specifiers: entry.specifiers,
      };
    });
}

type Problem = { code: string; specifier: string | null };

/** Why a subpath null fails gate A, or null when it is a listed null with its listed reason. */
function nullProblem(
  expected: ExpectedNull[],
  pkg: string,
  subpath: string,
  problems: Problem[],
): string | null {
  const listed = expected.find((e) => e.package === pkg && e.subpath === subpath);
  if (!listed) return "unexpected null (not in a reviewed subpath-nulls.json)";
  const codes = [...new Set(problems.map((p) => p.code))];
  if (codes.length !== 1 || codes[0] !== listed.code) {
    return `codes ${codes.join(", ") || "none"}, expected ${listed.code}`;
  }
  const allowed = (specifier: string | null) =>
    listed.specifiers === "node-builtins"
      ? specifier !== null && isBuiltin(specifier)
      : listed.specifiers === "worker"
        ? specifier?.startsWith("worker ") === true
        : asStringArray(listed.specifiers).includes(specifier ?? "");
  const other = problems.filter((p) => !allowed(p.specifier)).map((p) => p.specifier ?? "none");
  return other.length ? `unexpected specifiers ${[...new Set(other)].join(", ")}` : null;
}

/**
 * The subpath groups of one `unavailable` entry (SPEC.md iteration 2): each
 * `<CODE> in subpaths <JSON array>`, found after `bundle: ` or `; `, its array parsed as JSON from
 * its `[` to the matching `]` (strings and escapes respected).
 */
export function subpathGroups(entry: string): Array<{ code: string; keys: string[] }> {
  const groups: Array<{ code: string; keys: string[] }> = [];
  const head = /(?:^bundle: |; )([A-Z][A-Z_]*) in subpaths \[/g;
  for (let match = head.exec(entry); match; match = head.exec(entry)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < entry.length; i++) {
      const char = entry[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "[") depth++;
      else if (char === "]" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    groups.push({
      code: match[1] ?? "",
      keys: asStringArray(JSON.parse(entry.slice(start, end + 1))),
    });
    head.lastIndex = end + 1;
  }
  return groups;
}

/** Every reason code one `unavailable` entry reports: its leading code, a summary's, its groups'. */
function entryCodes(entry: string): Set<string> {
  const codes = new Set<string>();
  const leading = /^bundle: ([A-Z][A-Z_]*)\b/.exec(entry)?.[1];
  if (leading) codes.add(leading);
  const summary = /^bundle: \d+ exports unmeasurable \(([^)]*)\)/.exec(entry)?.[1];
  for (const code of summary?.split(", ") ?? []) codes.add(code);
  for (const group of subpathGroups(entry)) codes.add(group.code);
  return codes;
}

/** Codes reported by more than one entry (one entry per cause, amendment 4). */
function repeatedCodes(reasons: string[]): string[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    for (const code of entryCodes(reason)) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([code, n]) => `${n} entries report ${code}`);
}

/** The (key, code) pairs the entries name, each with how many times it is named. */
function namedPairs(reasons: string[]): Map<string, number> {
  const pairs = new Map<string, number>();
  for (const reason of reasons) {
    for (const { code, keys } of subpathGroups(reason)) {
      for (const key of keys) pairs.set(`${key} ${code}`, (pairs.get(`${key} ${code}`) ?? 0) + 1);
    }
  }
  return pairs;
}

/** Gate A (ii) and E (iv) for one null value: each of its codes named exactly once with its key. */
function nullNamingProblems(reasons: string[], key: string, codes: string[]): string[] {
  const pairs = namedPairs(reasons);
  const problems = codes
    .filter((code) => pairs.get(`${key} ${code}`) !== 1)
    .map((code) => `${key} with ${code} named ${pairs.get(`${key} ${code}`) ?? 0} times`);
  const extra = [...pairs.keys()].filter(
    (pair) => pair.startsWith(`${key} `) && !codes.includes(pair.slice(key.length + 1)),
  );
  return [...problems, ...extra.map((pair) => `${pair} named but not a code of its build`)];
}

/** The facts gate D compares: per-subpath detail and the report's subpath fields and reasons. */
function subpathState(m: RootEntryMeasurement): string {
  const facts = rootEntryFacts(m, "vite");
  const problems = (m.subpaths?.subpaths ?? []).map(({ key, outcome }) => [
    key,
    [...new Set(outcome.problems.map((p) => `${p.code} ${p.specifier ?? ""}`))].sort(),
  ]);
  const { bundle } = facts;
  return JSON.stringify([
    subpathDetail(m),
    problems,
    bundle.exports_map,
    bundle.subpaths_listed,
    bundle.subpaths_whole_eager_js_gzip9_bytes,
    bundle.subpath_patterns_unmeasured,
    [...facts.reasons].sort(),
  ]);
}

type Bytes = Record<ByteField, number>;

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

/** Installs a frozen wild lock as reference.ts does (`npm ci`, peers left out). */
async function installFrozen(id: string, name: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-subpath-score-"));
  const lock = await readFile(join(HERE, "locks", "wild", `${id}.json`), "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "ref", private: true, dependencies: { [name]: version } }),
  );
  await writeFile(join(dir, "package-lock.json"), lock);
  await run("npm", ["ci", "--legacy-peer-deps", ...NPM_FLAGS], { cwd: dir, timeout: 300_000 });
  return dir;
}

const manifestIn = async (dir: string, name: string) =>
  asRecord(JSON.parse(await readFile(join(dir, "node_modules", name, "package.json"), "utf8")));

async function scoreReference(): Promise<void> {
  const set = asArray(asRecord(await readJson(join(HERE, "subpath-set.json"))).packages).map(
    asRecord,
  );
  const reference = asArray(
    asRecord(await readJson(join(HERE, "subpath-reference.json"))).packages,
  ).map(asRecord);
  const expected = await loadExpectedNulls();
  const coverage: string[] = [];
  const cases = set.reduce((n, p) => n + asStringArray(p.subpaths).length, 0);
  if (set.length !== 20 || cases !== 51) coverage.push(`${set.length} packages, ${cases} cases`);
  if (!expected.length) coverage.push("subpath-nulls.json is not reviewed");
  const aFail: string[] = [];
  const honestNulls: string[] = [];
  const bFail: string[] = [];
  const bGross: string[] = [];
  const cFail: string[] = [];
  const dFail: string[] = [];
  const results: Record<string, unknown>[] = [];
  let measuredCases = 0;
  for (const item of set) {
    const name = asString(item.package) ?? "";
    const version = asString(item.version) ?? "";
    const ref = reference.find((r) => r.package === name && r.version === version);
    if (!ref) {
      coverage.push(`${name}@${version}: no reference`);
      continue;
    }
    const dir = await installFrozen(wildId(name), name, version);
    try {
      const externals = externalPackages(await manifestIn(dir, name));
      const first = await measureRootEntry(dir, name, externals, { subpaths: true });
      const second = await measureRootEntry(dir, name, externals, { subpaths: true });
      if (subpathState(first) !== subpathState(second)) dFail.push(`${name}: two runs differ`);
      const reasons = rootEntryFacts(first, "vite").reasons;
      for (const repeated of repeatedCodes(reasons)) aFail.push(`${name}: ${repeated}`);
      const outcomes = new Map((first.subpaths?.subpaths ?? []).map((s) => [s.key, s.outcome]));
      for (const key of asStringArray(item.subpaths)) {
        const label = `${name} ${key}`;
        const outcome = outcomes.get(key);
        const refs = asRecord(asRecord(ref.subpaths)[key]);
        if (!outcome) {
          aFail.push(`${label}: not listed or not built by depfit`);
          continue;
        }
        if (!outcome.bytes) {
          const problem = nullProblem(expected, name, key, outcome.problems);
          const codes = [...new Set(outcome.problems.map((p) => p.code))].sort();
          const naming = nullNamingProblems(reasons, key, codes.length ? codes : ["BUILD_ERROR"]);
          if (problem || naming.length) {
            aFail.push(`${label}: ${[problem, ...naming].filter(Boolean).join("; ")}`);
          } else honestNulls.push(`${label}: ${codes.join(", ")}`);
          results.push({ name, key, problems: outcome.problems });
          continue;
        }
        measuredCases += 1;
        const bytes: Bytes = {
          min_bytes: outcome.bytes.eager_js_min_bytes,
          gzip_bytes: outcome.bytes.eager_js_gzip9_bytes,
          lazy_min_bytes: outcome.bytes.lazy_js_min_bytes,
          lazy_gzip_bytes: outcome.bytes.lazy_js_gzip9_bytes,
        };
        const ranges = referenceRanges(refs);
        if (!ranges) bFail.push(`${label}: no rollup/webpack reference built`);
        else {
          for (const field of ["gzip_bytes", "lazy_gzip_bytes"] as const) {
            const range = ranges[field];
            const text = `${label} ${field} ${bytes[field]} vs ${range.lo}..${range.hi}`;
            if (grossError(bytes[field], range)) bGross.push(text);
            if (!inBand(bytes[field], range)) bFail.push(text);
          }
        }
        const mismatch = conformance(bytes, refs.vite);
        if (mismatch) cFail.push(`${label}: ${mismatch}`);
        results.push({
          name,
          key,
          bytes,
          rollup: refs.rollup,
          webpack: refs.webpack,
          vite: refs.vite,
        });
      }
      console.log(`${name}@${version}: ${first.subpaths?.listed ?? "?"} listed`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const pass = (ok: boolean) => verdict(ok && coverage.length === 0);
  const lines = [
    `Iteration 2, subpath reference set: ${set.length} packages, ${cases} cases (${measuredCases} measured)`,
    `  coverage: ${coverage.length} problems ${verdict(!coverage.length)}`,
    ...coverage.map((c) => `    ${c}`),
    `  A. ${honestNulls.length} nulls with their listed reason, named in unavailable; ${aFail.length} other ${pass(!aFail.length)}`,
    ...[...aFail, ...honestNulls].map((f) => `    ${f}`),
    `  B. in the rollup/webpack band (both gzip fields): ${measuredCases - new Set(bFail.map((f) => f.split(" ").slice(0, 2).join(" "))).size}/${measuredCases} ${pass(!bFail.length)}; gross errors ${bGross.length} ${pass(!bGross.length)}`,
    ...[...bFail, ...bGross].map((f) => `    ${f}`),
    `  C. equal to a stock vite build (min identical, gzip within ${GZIP_RUNTIME_TOLERANCE * 100}%): ${cFail.length} failures over ${measuredCases} ${pass(!cFail.length)}`,
    ...cFail.map((f) => `    ${f}`),
    `  D. two runs per package: ${dFail.length} differences ${pass(!dFail.length)}`,
    ...dFail.map((f) => `    ${f}`),
  ];
  console.log(lines.join("\n"));
  await save("reference", { coverage, aFail, honestNulls, bFail, bGross, cFail, dFail, results });
}

// --- A, D and F's subpath time on the probe packages ---------------------------------------------

async function scoreProbePackages(locks: string, control: string): Promise<void> {
  process.env.DEPFIT_LOCK_DIR = locks;
  const expected = await loadExpectedNulls();
  const specs = await probeSpecs(control);
  const aFail: string[] = [];
  const honestNulls: string[] = [];
  const dFail: string[] = [];
  const coverage: string[] = [];
  const candidates = [...specs.values()].reduce((n, s) => n + s.count, 0);
  if (specs.size !== 88 || candidates !== 94) {
    coverage.push(`${specs.size} packages and ${candidates} candidates, not 88 and 94`);
  }
  const times: Array<{ spec: string; ms: number; count: number; built: number }> = [];
  /** Per package, the measurement call's results (cap 100), for gate E's correspondence. */
  const measured: Record<string, unknown> = {};
  for (const [spec, { name, version, count }] of specs) {
    await withIsolatedInstall(name, version, async ({ dir }) => {
      const externals = externalPackages(await manifestIn(dir, name));
      // (i) The measurement call, cap 100, twice: A's coverage and D.
      const first = await measureRootEntry(dir, name, externals, { subpaths: true });
      const second = await measureRootEntry(dir, name, externals, { subpaths: true });
      if (subpathState(first) !== subpathState(second)) dFail.push(`${spec}: two runs differ`);
      for (const { key, outcome } of first.subpaths?.subpaths ?? []) {
        if (outcome.bytes) continue;
        const problem = nullProblem(expected, name, key, outcome.problems);
        const codes = [...new Set(outcome.problems.map((p) => p.code))].sort();
        if (problem) aFail.push(`${spec} ${key}: ${problem}`);
        else honestNulls.push(`${spec} ${key}: ${codes.join(", ")}`);
      }
      measured[spec] = {
        listed: first.subpaths?.listed ?? null,
        reason: first.subpaths?.reason ?? null,
        subpaths: subpathDetail(first),
        problems: Object.fromEntries(
          (first.subpaths?.subpaths ?? []).map(({ key, outcome }) => [key, outcome.problems]),
        ),
      };
      // Coverage: every listed key is built when the measurement call can build them all.
      const listedCount = first.subpaths?.listed ?? null;
      const builtCount = first.subpaths?.subpaths?.length ?? 0;
      const buildable =
        first.subpaths?.exportsMap === true && listedCount !== null && listedCount <= 100;
      const rootFailed = first.whole.problems.some((p) => p.code === "TOOLCHAIN_MISMATCH");
      if (buildable && !rootFailed && builtCount !== listedCount) {
        coverage.push(`${spec}: ${builtCount} of ${listedCount} listed subpaths built`);
      }
      // The default report's call, the CLI's own (`rootEntryBundle`, cap 30): F's time, the
      // number of builds, and A (ii) on its reasons.
      let ms = 0;
      const report = await rootEntryBundle(dir, name, await manifestIn(dir, name), (elapsed) => {
        ms = elapsed;
      });
      const map = report.bundle.subpaths_whole_eager_js_gzip9_bytes;
      const built = map ? Object.keys(map).length : 0;
      times.push({ spec, ms: Math.round(ms), count, built });
      for (const repeated of repeatedCodes(report.reasons)) aFail.push(`${spec}: ${repeated}`);
      for (const detail of subpathDetail(first) ?? []) {
        if (!map || map[detail.entry_point] !== null) continue;
        const naming = nullNamingProblems(
          report.reasons,
          detail.entry_point,
          detail.unmeasurable_codes,
        );
        for (const problem of naming) aFail.push(`${spec} (default report): ${problem}`);
      }
    });
    const last = times.at(-1);
    console.log(
      `${spec}: subpath phase ${last?.ms ?? "?"} ms, ${last?.built ?? 0} built (default call)`,
    );
  }
  const sorted = times.flatMap((t) => Array<number>(t.count).fill(t.ms)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p90 = sorted[Math.floor(0.9 * sorted.length)] ?? 0;
  const max = sorted.at(-1) ?? 0;
  const maxBuilt = Math.max(0, ...times.map((t) => t.built));
  const lines = [
    `Iteration 2, probe packages: ${specs.size} distinct packages, ${sorted.length} probe candidates`,
    `  coverage: ${coverage.length} problems ${verdict(!coverage.length)} (every gate below fails while this does)`,
    ...coverage.map((c) => `    ${c}`),
    `  A (i) and (ii). ${honestNulls.length} nulls with their listed reason; ${aFail.length} other ${verdict(!aFail.length && !coverage.length)}`,
    ...[...aFail, ...honestNulls].map((f) => `    ${f}`),
    `  D. measurement call twice per package: ${dFail.length} differences ${verdict(!dFail.length)}`,
    ...dFail.map((f) => `    ${f}`),
    `  F. default call's subpath phase per candidate: median ${median} ms (max 250) ${verdict(median <= 250)}, p90 ${p90} ms (max 1000) ${verdict(p90 <= 1000)}, max ${max} ms (${times.find((t) => t.ms === max)?.spec ?? "?"}); most subpaths built for one package ${maxBuilt} (max ${REPORT_SUBPATH_LIMIT}) ${verdict(maxBuilt <= REPORT_SUBPATH_LIMIT)}`,
  ];
  console.log(lines.join("\n"));
  await save("probes", {
    coverage,
    aFail,
    honestNulls,
    dFail,
    times,
    median,
    p90,
    max,
    maxBuilt,
    measured,
  });
}

// --- E, D and R on the reports ----------------------------------------------------------------------

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

const BUNDLE_KEYS = Object.keys(FIELD_DESCRIPTIONS)
  .filter((path) => path.startsWith("packages[].bundle."))
  .map((path) => path.slice("packages[].bundle.".length))
  .sort();
const bundleEntries = (pkg: Record<string, unknown>) =>
  asStringArray(pkg.unavailable).filter((entry) => entry.startsWith("bundle:"));

type Measured = {
  listed: number | null;
  reason: string | null;
  subpaths: Array<{
    entry_point: string;
    whole_eager_js_gzip9_bytes: number | null;
    unmeasurable_codes: string[];
  }> | null;
};

/** The latest `probes` result: the measurement call's results per name@version (gate E (iii)). */
async function latestMeasured(): Promise<Map<string, Measured>> {
  const files = (await readdir(RESULTS_DIR).catch(() => []))
    .filter((f) => f.startsWith("subpath-probes-") && f.endsWith(".json"))
    .sort();
  const last = files.at(-1);
  if (!last) return new Map();
  const measured = asRecord(asRecord(await readJson(join(RESULTS_DIR, last))).measured);
  return new Map(
    Object.entries(measured).map(([spec, value]) => {
      const m = asRecord(value);
      const subpaths = Array.isArray(m.subpaths)
        ? m.subpaths.map(asRecord).map((d) => ({
            entry_point: asString(d.entry_point) ?? "",
            whole_eager_js_gzip9_bytes: asNumber(d.whole_eager_js_gzip9_bytes),
            unmeasurable_codes: asStringArray(d.unmeasurable_codes),
          }))
        : null;
      return [spec, { listed: asNumber(m.listed), reason: asString(m.reason), subpaths }];
    }),
  );
}

/**
 * Gate E for one package's bundle (SPEC.md iteration 2, amended 2026-11-07): (i) fields and the
 * states' precedence, (ii) the map's serialized member order, (iii) correspondence with the
 * measurement call on the same frozen tree, (iv) every (key, code) pair named once and every code
 * in one entry. JSON.parse keeps members in serialized order for keys that are not array indices,
 * and every key starts with "./", so Object.keys is the serialized order.
 */
function contractProblems(pkg: Record<string, unknown>, measured: Measured | undefined): string[] {
  if (!("bundle" in pkg)) return ["no bundle key"];
  if (pkg.bundle === null) {
    if (pkg.error !== null || pkg.kind === "builtin" || pkg.cost === null) return [];
    return bundleEntries(pkg).some((r) => r.startsWith("bundle: skipped"))
      ? []
      : ["null bundle, no reason"];
  }
  const bundle = asRecord(pkg.bundle);
  const keys = Object.keys(bundle).sort();
  if (JSON.stringify(keys) !== JSON.stringify(BUNDLE_KEYS)) return [`keys ${keys.join(",")}`];
  const problems: string[] = [];
  const reasons = bundleEntries(pkg);
  const map = bundle.subpaths_whole_eager_js_gzip9_bytes;
  const listed = bundle.subpaths_listed;
  const exportsMap = bundle.exports_map;
  const patterns = bundle.subpath_patterns_unmeasured;
  problems.push(...repeatedCodes(reasons));
  // (i) Metadata comes from the listing alone; the map follows the first state that applies.
  if (exportsMap === null) {
    if (listed !== null || map !== null || patterns !== null)
      problems.push("unknown listing, non-null fields");
    if (!reasons.some((r) => r.startsWith("bundle: SUBPATH_LIST_FAILED"))) {
      problems.push("unknown listing without SUBPATH_LIST_FAILED");
    }
    return problems;
  }
  if (typeof exportsMap !== "boolean") problems.push("exports_map is not a boolean");
  if (typeof listed !== "number") return [...problems, "subpaths_listed is not a number"];
  if (!Array.isArray(patterns)) problems.push("patterns not a list");
  const rootFailed = reasons.some((r) => /^bundle: (TOOLCHAIN_MISMATCH|BUNDLER_ERROR)\b/.test(r));
  if (exportsMap === false) {
    if (map !== null || listed !== 0) problems.push("no map, yet subpaths");
  } else if (listed === 0) {
    if (!isRecord(map) || Object.keys(map).length) problems.push("empty listing, map not {}");
  } else if (listed > REPORT_SUBPATH_LIMIT) {
    if (map !== null) problems.push("over the cap, map not null");
    if (!reasons.includes(`bundle: SUBPATH_LIMIT ${listed}`)) {
      problems.push(`over the cap without bundle: SUBPATH_LIMIT ${listed}`);
    }
  } else if (map === null) {
    if (!rootFailed) problems.push("null map without a reason");
  } else if (!isRecord(map)) problems.push("map is not an object");
  else {
    // (ii) Serialized order and unique keys.
    const mapKeys = Object.keys(map);
    if (JSON.stringify(mapKeys) !== JSON.stringify([...mapKeys].sort(byCodePoint))) {
      problems.push("map members not in code-point order");
    }
    if (mapKeys.length !== listed)
      problems.push(`map has ${mapKeys.length} keys, listed ${listed}`);
    // (iii) Correspondence with the measurement call.
    if (!measured?.subpaths) problems.push("no measurement-call result to compare");
    else {
      const expectedKeys = measured.subpaths.map((d) => d.entry_point);
      if (JSON.stringify(mapKeys) !== JSON.stringify(expectedKeys)) {
        problems.push(`keys ${mapKeys.join(" ")} vs measured ${expectedKeys.join(" ")}`);
      }
      for (const detail of measured.subpaths) {
        const value = map[detail.entry_point];
        if (value !== detail.whole_eager_js_gzip9_bytes) {
          problems.push(
            `${detail.entry_point}: ${String(value)} vs measured ${String(detail.whole_eager_js_gzip9_bytes)}`,
          );
        }
        // (iv) and A (ii): a null value's codes, each named once with its key, and nothing else.
        const codes = value === null ? detail.unmeasurable_codes : [];
        problems.push(...nullNamingProblems(reasons, detail.entry_point, codes));
      }
    }
  }
  if (map === null || !isRecord(map)) {
    if ([...namedPairs(reasons).keys()].length) problems.push("keys named without a map");
  }
  return problems;
}

const failedIn = (report: unknown) =>
  asArray(asRecord(report).packages).flatMap((pkg) =>
    asStringArray(asRecord(pkg).unavailable).flatMap(
      (entry) => NETWORK_ENTRY.exec(entry)?.[1]?.toLowerCase() ?? [],
    ),
  );

/** Gate R's miss classes (SPEC.md iteration 2), from the snippet's shape and the listing. */
const FRAMEWORK_SUBPATH = /\/(react|preact|vue|svelte|solid|angular)$/;

type Candidate = {
  probe: string;
  set: string;
  name: string;
  real: number | null;
  real_reason: string | null;
  snippet: string | null;
  L: number | null;
  U: number | null;
  uncovered: string[];
  bracketed: boolean | null;
  miss_class: string | null;
};

async function probeSets(): Promise<Map<string, string>> {
  const probes = asArray(await readJson(join(REPO, "eval", "probes.json"))).map(asRecord);
  const counters = new Map<string, number>();
  const sets = new Map<string, string>();
  for (const probe of probes) {
    const project = asString(probe.project) ?? "";
    const n = (counters.get(project) ?? 0) + 1;
    counters.set(project, n);
    const packages = asStringArray(probe.packages);
    sets.set(
      `${project}/${n}-${packages.join("-vs-").replaceAll("/", "_")}`,
      asString(probe.set) ?? "",
    );
  }
  return sets;
}

/**
 * Gate R's algorithm (SPEC.md iteration 2): the numbers for the entry points real usage imports.
 * Returns L, U, the uncovered entry points, and the miss class when out of range.
 */
function scoreCandidate(
  pkg: Record<string, unknown>,
  snippet: string,
  real: number,
): Pick<Candidate, "L" | "U" | "uncovered" | "bracketed" | "miss_class"> {
  const name = asString(pkg.name) ?? "";
  const bundle = asRecord(pkg.bundle);
  const sources = [
    ...new Set(
      [...snippet.matchAll(/(?:from\s+|import\s+)"([^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((s) => s === name || s.startsWith(`${name}/`)),
    ),
  ];
  const map = isRecord(bundle.subpaths_whole_eager_js_gzip9_bytes)
    ? bundle.subpaths_whole_eager_js_gzip9_bytes
    : null;
  const patterns = asStringArray(bundle.subpath_patterns_unmeasured);
  const median = asNumber(bundle.single_export_median_eager_js_gzip9_bytes);
  const whole = asNumber(bundle.whole_eager_js_gzip9_bytes);
  const lowers: Array<number | null> = [];
  const uppers: Array<number | null> = [];
  const uncovered: string[] = [];
  const kinds = new Set<string>();
  for (const source of sources) {
    if (source === name) {
      lowers.push(median);
      uppers.push(whole);
      continue;
    }
    const key = `./${source.slice(name.length + 1)}`;
    const value = map && key in map ? map[key] : undefined;
    if (typeof value === "number") {
      lowers.push(value);
      uppers.push(value);
      continue;
    }
    const matchesPattern = patterns.some((pattern) => {
      const [pre = "", post = ""] = pattern.split("*");
      return key.startsWith(pre) && key.endsWith(post) && key.length > pre.length + post.length - 1;
    });
    if (value === null) kinds.add("null");
    else if (bundle.exports_map === false) kinds.add("1a");
    else if (
      map === null &&
      asNumber(bundle.subpaths_listed) !== null &&
      (asNumber(bundle.subpaths_listed) ?? 0) > REPORT_SUBPATH_LIMIT
    )
      kinds.add("1c");
    else if (matchesPattern) kinds.add("1b");
    else kinds.add("unlisted");
    uncovered.push(key);
  }
  let L: number | null;
  let U: number | null;
  if (lowers.length) {
    L = lowers.some((v) => v === null) ? null : Math.max(...lowers.map((v) => v ?? 0));
    U = uppers.some((v) => v === null) ? null : uppers.reduce<number>((a, v) => a + (v ?? 0), 0);
  } else {
    L = median;
    U = whole;
  }
  const bracketed = L !== null && U !== null && real >= 0.9 * L && real <= 1.1 * U;
  let missClass: string | null = null;
  if (!bracketed) {
    const subpaths = sources.filter((s) => s !== name);
    if (subpaths.some((s) => FRAMEWORK_SUBPATH.test(s))) missClass = "3 framework subpath";
    else if (kinds.has("1a")) missClass = "1a add-on, no exports map";
    else if (kinds.has("1b")) missClass = "1b pattern subpath";
    else if (kinds.has("1c")) missClass = "1c over the report's cap";
    else if (
      L !== null &&
      real < 0.9 * L &&
      subpaths.some((s) => typeof map?.[`./${s.slice(name.length + 1)}`] === "number")
    ) {
      missClass = "4 part of a listed subpath";
    } else if (/;\s*[A-Za-z_$][\w$]*\.[A-Za-z_$]/.test(snippet))
      missClass = "2 members of one export";
  }
  return { L, U, uncovered, bracketed, miss_class: missClass };
}

async function scoreReports(options: { on: string; again: string; off: string }): Promise<void> {
  const files = await probeFiles(options.on);
  const coverage: string[] = [];
  const probes = asArray(await readJson(join(REPO, "eval", "probes.json"))).map(asRecord);
  for (const [set, sha] of Object.entries(HOLDOUT_SHA256)) {
    const entries = probes.filter((p) => p.set === set);
    const actual = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    if (actual !== sha) coverage.push(`${set} probes changed (sha256 ${actual})`);
  }
  if (files.length !== PROBE_COUNT)
    coverage.push(`${files.length} probe reports, not ${PROBE_COUNT}`);
  const sets = await probeSets();
  const expected = await loadExpectedNulls();
  const measured = await latestMeasured();
  if (!measured.size) coverage.push("no subpath-probes result (run `probes` first)");
  const eFail: string[] = [];
  const eDiffs: string[] = [];
  const eFlakes: string[] = [];
  const dFail: string[] = [];
  const candidates: Candidate[] = [];
  const coverageR: string[] = [];
  const overCap: string[] = [];
  for (const { project, base } of files) {
    const id = `${project}/${base}`;
    const on = asRecord(await readJson(join(options.on, project, `${base}.json`)));
    const again = asRecord(await readJson(join(options.again, project, `${base}.json`)));
    const off = await readJson(join(options.off, project, `${base}.json`));
    const onPackages = asArray(on.packages).map(asRecord);
    const againPackages = asArray(again.packages).map(asRecord);
    for (const [i, pkg] of onPackages.entries()) {
      const other = againPackages[i] ?? {};
      const a = JSON.stringify([pkg.version, pkg.bundle, bundleEntries(pkg).sort()]);
      const b = JSON.stringify([other.version, other.bundle, bundleEntries(other).sort()]);
      if (a !== b) dFail.push(`${id} ${asString(pkg.name)}: two runs differ`);
      const spec = `${asString(pkg.name)}@${asString(pkg.version)}`;
      for (const problem of contractProblems(pkg, measured.get(spec))) {
        eFail.push(`${id} ${spec}: ${problem}`);
      }
    }
    if (!off) eDiffs.push(`${id}: no bundling-off run`);
    else {
      const diff = firstDiff(withoutBundle(asRecord(off)), withoutBundle(on));
      if (diff) {
        const failed = new Set([...failedIn(on), ...failedIn(off)]);
        const rest = failed.size
          ? firstDiff(withoutBundle(asRecord(off), failed), withoutBundle(on, failed))
          : diff;
        const text = `${id} ${diff.path}: ${JSON.stringify(diff.without_bundle)} vs ${JSON.stringify(diff.with_bundle)}`;
        (rest ? eDiffs : eFlakes).push(text);
      }
    }
    const snippets = asArray(
      await readJson(join(options.on, project, `${base}.snippets.json`)),
    ).map(asRecord);
    for (const pkg of onPackages) {
      if (pkg.kind !== "npm") continue;
      const name = asString(pkg.name) ?? "";
      const truth = snippets.find((s) => s.requested === pkg.requested);
      const real = asNumber(truth?.eager_js_gzip9_bytes);
      const snippet = asString(truth?.entry);
      const base: Candidate = {
        probe: id,
        set: sets.get(id) ?? "?",
        name,
        real,
        real_reason: truth
          ? ((asStringArray(truth.reasons).join("; ") || asString(truth.error)) ?? null)
          : "no snippet",
        snippet,
        L: null,
        U: null,
        uncovered: [],
        bracketed: null,
        miss_class: null,
      };
      if (real === null || snippet === null) {
        candidates.push(base);
        continue;
      }
      const scored = scoreCandidate(pkg, snippet, real);
      candidates.push({ ...base, ...scored });
      // R (c): every imported subpath the listing rule admits, of a package with at most 30
      // listed keys, is a key of the map, and a null one is a listed null under A.
      const imported = [...snippet.matchAll(/(?:from\s+|import\s+)"([^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((source) => source.startsWith(`${name}/`));
      if (!imported.length) continue;
      const version = asString(pkg.version) ?? "";
      const listing = listSubpaths(await fetchManifest(name, version));
      const admitted = new Set(listing.subpaths.map((s) => s.key));
      const bundle = asRecord(pkg.bundle);
      const map = isRecord(bundle.subpaths_whole_eager_js_gzip9_bytes)
        ? bundle.subpaths_whole_eager_js_gzip9_bytes
        : null;
      for (const source of imported) {
        const key = `./${source.slice(name.length + 1)}`;
        if (!admitted.has(key)) continue;
        const label = `${id} ${name} ${key}`;
        if (admitted.size > REPORT_SUBPATH_LIMIT) overCap.push(label);
        else if (!map || !(key in map)) coverageR.push(`${label}: not a key of the map`);
        else if (
          map[key] === null &&
          !expected.some((e) => e.package === name && e.subpath === key)
        ) {
          coverageR.push(`${label}: null, not a listed null`);
        }
      }
    }
  }
  const withTruth = candidates.filter((c) => c.bracketed !== null);
  const bracketed = withTruth.filter((c) => c.bracketed);
  const misses = withTruth.filter((c) => !c.bracketed);
  const unclassified = misses.filter((c) => !c.miss_class);
  const unclassifiedPairs = () => pairs.filter((p) => !p.agrees && !p.miss_class);
  type Pair = { probe: string; a: string; b: string; agrees: boolean; miss_class: string | null };
  const pairs: Pair[] = [];
  const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const scored = withTruth.filter((c) => c.L !== null && c.U !== null);
  for (const [i, a] of scored.entries()) {
    for (const b of scored.slice(i + 1)) {
      if (a.probe !== b.probe) continue;
      const way = sign((a.L ?? 0) - (b.L ?? 0));
      if (way === 0 || way !== sign((a.U ?? 0) - (b.U ?? 0))) continue;
      const [ra, rb] = [a.real ?? 0, b.real ?? 0];
      if (Math.max(ra, rb) < 1.1 * Math.min(ra, rb)) continue;
      const agrees = sign(ra - rb) === way;
      // A disagreeing pair is classified by its candidates' miss classes (as in iteration 1).
      const missClass = agrees ? null : (a.miss_class ?? b.miss_class);
      pairs.push({ probe: a.probe, a: a.name, b: b.name, agrees, miss_class: missClass });
    }
  }
  const agree = pairs.filter((p) => p.agrees).length;
  const rA = bracketed.length >= 0.85 * withTruth.length;
  const rB = pairs.length === 0 || agree >= 0.9 * pairs.length;
  const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(1)}%`;
  const perSet = [...new Set(withTruth.map((c) => c.set))].sort().map((set) => {
    const inSet = withTruth.filter((c) => c.set === set);
    return `${set} ${inSet.filter((c) => c.bracketed).length}/${inSet.length}`;
  });
  const pass = (ok: boolean) => verdict(ok && coverage.length === 0);
  const lines = [
    `Iteration 2, reports: ${files.length} probes (${options.on})`,
    `  coverage: ${coverage.length} problems ${verdict(!coverage.length)}`,
    ...coverage.map((c) => `    ${c}`),
    `  E. contract (fields, states, named nulls): ${eFail.length} problems ${pass(!eFail.length)}; non-bundle fields with DEPFIT_BUNDLE=0: ${eDiffs.length} differences ${pass(!eDiffs.length)} (${eFlakes.length} network flakes)`,
    ...[...eFail, ...eDiffs, ...eFlakes.map((f) => `flake: ${f}`)].map((f) => `    ${f}`),
    `  D. two runs on the same frozen installs: ${dFail.length} differences ${pass(!dFail.length)}`,
    ...dFail.map((f) => `    ${f}`),
    `  R (a). real usage in [0.9 x L, 1.1 x U]: ${bracketed.length}/${withTruth.length} (${pct(bracketed.length, withTruth.length)}, min 85%) ${pass(rA)}; by set: ${perSet.join(", ")}`,
    `  R (b). pairs pointing the same way, real usage >= 10% apart: ${agree}/${pairs.length} agree (${pct(agree, pairs.length)}, min 90%) ${pass(rB)}`,
    ...pairs
      .filter((p) => !p.agrees)
      .map((p) => `    disagrees (${p.miss_class ?? "UNCLASSIFIED"}): ${p.probe} ${p.a} vs ${p.b}`),
    `  R (c). imported subpaths the listing rule admits, at most 30 listed: ${coverageR.length} not covered ${pass(!coverageR.length)}; over the cap, reported separately: ${overCap.length}`,
    ...[...coverageR, ...overCap.map((c) => `over cap: ${c}`)].map((f) => `    ${f}`),
    `  R (d). misses: ${misses.length}, unclassified ${unclassified.length}; disagreeing pairs unclassified ${unclassifiedPairs().length} ${pass(!unclassified.length && !unclassifiedPairs().length)}`,
    ...misses.map(
      (c) =>
        `    ${c.miss_class ?? "UNCLASSIFIED"}: ${c.probe} ${c.name} real ${c.real} L ${c.L} U ${c.U}${c.uncovered.length ? ` uncovered ${c.uncovered.join(" ")}` : ""}`,
    ),
    `  left out (real usage null): ${
      candidates
        .filter((c) => c.bracketed === null)
        .map((c) => `${c.name} (${c.real_reason})`)
        .join("; ") || "none"
    }`,
  ];
  console.log(lines.join("\n"));
  await save("report", {
    coverage,
    eFail,
    eDiffs,
    eFlakes,
    dFail,
    candidates,
    pairs,
    coverageR,
    overCap,
  });
}

// --- H0: comprehension ------------------------------------------------------------------------------

/** Gate H0's questions (SPEC.md): iteration 1's five, then six on subpaths (amended 2026-11-07). */
const H0_QUESTIONS = [
  "Report 1, valibot: what code does `bundle.whole_eager_js_gzip9_bytes` count?",
  "Report 1, valibot: what does `bundle.single_export_median_eager_js_gzip9_bytes` describe?",
  "Report 1: an app in this workspace would import a few of valibot's exports. Does either bundle number say how many gzip bytes adding valibot would add to this app's JavaScript? Explain.",
  "Report 2, simple-git: `bundle.exports_measured` is lower than `bundle.exports`. What does that mean?",
  "Report 3: `bundle` is null for both packages. Why, and what does that say about their browser bundle size?",
  "Report 4, shiki: what does the value for `./core` in `bundle.subpaths_whole_eager_js_gzip9_bytes` count, and is it in addition to shiki's `bundle.whole_eager_js_gzip9_bytes`?",
  "Report 4: an app would import `highlight.js/lib/core` and `highlight.js/lib/languages/typescript`. Where in the report is a size for each of these two imports, if anywhere?",
  "Report 4, dayjs: `bundle.exports_map` is false. What does that mean for an app that imports `dayjs/plugin/relativeTime`?",
  "Report 4, @formkit/auto-animate: why is the value for `./react` in `bundle.subpaths_whole_eager_js_gzip9_bytes` null?",
  "Report 4, shiki: an app imports both `shiki/core` and `shiki/engine/javascript`. What do you get by adding the two values for `./core` and `./engine/javascript`?",
  "Report 4, date-fns: `bundle.subpaths_whole_eager_js_gzip9_bytes` is null. Given `bundle.subpaths_listed`, what does that mean?",
];

const H0_KEY = [
  'Every export of the root entry point (`import * as m from "valibot"`, all kept): the eager JS (entry chunk plus its static imports) of a standalone production Vite build, gzipped, with peers left out; the root only, not subpaths.',
  "The median, over valibot's exports, of one export's eager gzip bytes when that export is the only import, each in its own build: a typical single export, not an app's usage.",
  "No: both are standalone builds of named imports, neither is this app's usage nor its marginal cost (what it adds given what the app already bundles); real usage of a few exports usually lies between the median and the whole.",
  "Some exports' own builds failed depfit's checks (unmeasurable) and are left out of the median; unavailable gives the reason, one entry per cause. It does not mean they do not exist or are unused.",
  "The workspace has no browser signal (project.browser_signals is empty), so bundle facts were not measured (`bundle: skipped, no browser signal in workspace`); it says nothing about their size or whether they work in a browser.",
  "Everything `shiki/core` exports, kept whole: the eager JS (entry chunk plus static imports) of a standalone build of that subpath alone, gzipped, peers left out. It is not added to the root's number: it is its own build, not root plus core.",
  "`highlight.js/lib/core` is the `./lib/core` value of `subpaths_whole_eager_js_gzip9_bytes`. `highlight.js/lib/languages/typescript` matches the pattern `./lib/languages/*` in `subpath_patterns_unmeasured`, which is not expanded or measured: it has no number of its own and its standalone size is unknown (it is not zero and not inside lib/core's number).",
  "dayjs has no exports map, so any file of the package can be imported, `dayjs/plugin/relativeTime` included; no subpath is listed or measured, so the report has no size for that plugin.",
  "Its build was unmeasurable: unavailable names `./react` with its code (UNRESOLVED_IMPORT: an import, react, does not resolve in the isolated build because the package does not declare it). The size is unknown, not zero.",
  "An upper figure, not exact: each value is a separate standalone build, and the two can share code, so the sum can count that shared code twice; it is still not the app's marginal cost.",
  "The exports map lists more than 30 subpaths (subpaths_listed gives how many), so none was built for this report (`bundle: SUBPATH_LIMIT <count>` in unavailable). It does not mean date-fns has no subpaths, and their sizes are unknown here.",
];

async function writeComprehension(): Promise<void> {
  const browser = await scratchProject("browser", true);
  const plain = await scratchProject("browser", false);
  try {
    const reports = [
      (await depfit(["zod", "valibot"], browser)).report,
      (await depfit(["simple-git@4.0.2"], browser)).report,
      (await depfit(["zod", "valibot"], plain)).report,
      (
        await depfit(
          ["highlight.js", "shiki", "@formkit/auto-animate", "dayjs", "date-fns"],
          browser,
        )
      ).report,
    ];
    if (reports.some((r) => r === null)) throw new Error("a CLI run printed no report");
    const { stdout: schema } = await run("bun", [join(REPO, "src/cli.ts"), "--schema"]);
    const out = join(RESULTS_DIR, "comprehension-subpaths");
    await mkdir(out, { recursive: true });
    const prompt = [
      "You are given four JSON reports from a command-line tool that compares npm packages for a project, and the tool's field descriptions (`--schema`). Answer each question from these materials only, in one to three sentences.",
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

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    on: { type: "string", default: join(REPO, "eval/results/v7") },
    again: { type: "string", default: join(REPO, "eval/results/v7-b") },
    off: { type: "string", default: join(REPO, "eval/results/v7-off") },
    control: { type: "string", default: join(REPO, "eval/results/v7-control") },
    locks: { type: "string", default: join(REPO, "eval/results/v7/locks") },
  },
});
switch (positionals[0]) {
  case "listing":
    await scoreListing(values.control);
    break;
  case "reference":
    await scoreReference();
    break;
  case "probes":
    await scoreProbePackages(values.locks, values.control);
    break;
  case "report":
    await scoreReports({ on: values.on, again: values.again, off: values.off });
    break;
  case "comprehension":
    await writeComprehension();
    break;
  default:
    console.error(
      "usage: subpath-score.ts listing|reference|probes|report|comprehension [options]",
    );
    process.exitCode = 2;
}

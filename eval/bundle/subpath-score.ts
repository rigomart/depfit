/**
 * Iteration 2's scorecard (SPEC.md, "Iteration 2: subpaths of the `exports` map, measured whole",
 * with bar amendment 6). One subcommand per group of gates; writes results/subpath-<gate>-<time>.json
 * (gitignored) and prints the verdicts.
 *
 *   bun eval/bundle/subpath-score.ts listing     # L (ii): 288 manifests against resolve.exports 2.0.3
 *   bun eval/bundle/subpath-score.ts reference   # A, B, C, D on subpath-set.json (subpath-reference.json)
 *   bun eval/bundle/subpath-score.ts probes      # A and D on the probe packages; F's subpath time
 *   bun eval/bundle/subpath-score.ts report --measured <subpath-probes-*.json> [--on dir] [--again dir] [--off dir]   # E, D, R
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
import { byCodePoint, listSubpaths, SUBPATH_LIMIT } from "../../src/collect/subpaths.ts";
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
import { parseReason } from "./reasons.ts";

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

const fileSha256 = async (path: string): Promise<string | null> =>
  readFile(path).then(
    (data) => createHash("sha256").update(data).digest("hex"),
    () => null,
  );

async function sourceIdentity(): Promise<string | null> {
  const status = (await run("git", ["-C", REPO, "status", "--porcelain", "--", "src"])).stdout;
  if (status.trim()) return null;
  return (await run("git", ["-C", REPO, "rev-parse", "HEAD:src"])).stdout.trim();
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8").catch(() => "null"));

async function save(gate: string, data: unknown): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS_DIR, `subpath-${gate}-${stamp}.json`);
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}

type Spec = { name: string; version: string; source: string };

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

/** resolve.exports 2.0.3, the resolver Vite 8.3.4 bundles. */
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
    if (target !== undefined && /\.(?:js|mjs|cjs|jsx)$/.test(target)) keys.push(key);
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
  const set = asArray(asRecord(await readJson(join(HERE, "subpath-set.json"))).packages).map(
    asRecord,
  );
  const fromRule = (await loadWildPackages())
    .filter((p) => (listings.get(p.name) ?? []).length > 0)
    .slice(0, 20)
    .map((p) => ({
      package: p.name,
      version: p.version,
      subpaths: pickThree(listings.get(p.name) ?? []),
    }));
  const frozen = set.map((p) => ({
    package: asString(p.package) ?? "",
    version: asString(p.version) ?? "",
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

type ExpectedNull = { package: string; subpath: string; code: string; specifiers: unknown };

async function loadExpectedNulls(): Promise<ExpectedNull[]> {
  const raw = asRecord(await readJson(join(HERE, "subpath-nulls.json")));
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

function entryCodes(entry: string): Set<string> {
  const { free, groups } = parseReason(entry);
  const codes = new Set<string>();
  const leading = /^bundle: ([A-Z][A-Z_]*)\b/.exec(free)?.[1];
  if (leading) codes.add(leading);
  const summary = /^bundle: \d+ exports unmeasurable \(([^)]*)\)/.exec(free)?.[1];
  for (const code of summary?.split(", ") ?? []) codes.add(code);
  for (const group of groups) codes.add(group.code);
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

function framingProblems(reasons: string[]): string[] {
  return reasons.flatMap((reason) =>
    parseReason(reason).errors.map((error) => `${error} in "${reason.slice(0, 80)}"`),
  );
}

function namedPairs(reasons: string[]): Map<string, number> {
  const pairs = new Map<string, number>();
  for (const reason of reasons) {
    for (const { code, keys } of parseReason(reason).groups) {
      for (const key of keys) {
        const pair = JSON.stringify([key, code]);
        pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
      }
    }
  }
  return pairs;
}

/**
 * Gate A (ii) and E (iii)-(iv): the named (key, code) pairs equal `expected` exactly, each named
 * once. `expected` maps every null value's key to the codes of its failed build; any other pair
 * (a measured key, a key not in the map, a wrong code) is a problem.
 */
function pairProblems(reasons: string[], expected: Map<string, string[]>): string[] {
  const named = namedPairs(reasons);
  const want = new Set(
    [...expected].flatMap(([key, codes]) => codes.map((code) => JSON.stringify([key, code]))),
  );
  const problems: string[] = [];
  for (const pair of want) {
    const n = named.get(pair) ?? 0;
    if (n !== 1) problems.push(`${pair} named ${n} times`);
  }
  for (const pair of named.keys())
    if (!want.has(pair)) problems.push(`${pair} named but not expected`);
  return problems;
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

/** Installs a frozen wild lock with `npm ci --legacy-peer-deps`, peers left out. */
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
    const lock = await fileSha256(join(HERE, "locks", "wild", `${wildId(name)}.json`));
    if (lock === null || lock !== asString(ref.lock_sha256)) {
      coverage.push(`${name}@${version}: frozen lock differs from the one the reference used`);
    }
    const dir = await installFrozen(wildId(name), name, version);
    try {
      const externals = externalPackages(await manifestIn(dir, name));
      const first = await measureRootEntry(dir, name, externals, { subpaths: true });
      const second = await measureRootEntry(dir, name, externals, { subpaths: true });
      if (subpathState(first) !== subpathState(second)) dFail.push(`${name}: two runs differ`);
      const reasons = rootEntryFacts(first, "vite").reasons;
      for (const repeated of repeatedCodes(reasons)) aFail.push(`${name}: ${repeated}`);
      for (const framing of framingProblems(reasons)) aFail.push(`${name}: ${framing}`);
      const nullCodes = new Map(
        (subpathDetail(first) ?? [])
          .filter((d) => d.whole_eager_js_gzip9_bytes === null)
          .map((d) => [d.entry_point, d.unmeasurable_codes]),
      );
      for (const naming of pairProblems(reasons, nullCodes)) aFail.push(`${name}: ${naming}`);
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
          if (problem) aFail.push(`${label}: ${problem}`);
          else honestNulls.push(`${label}: ${codes.join(", ")}`);
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
  const measured: Record<string, SavedMeasurement> = {};
  for (const [spec, { name, version, count }] of specs) {
    await withIsolatedInstall(name, version, async ({ dir }) => {
      const externals = externalPackages(await manifestIn(dir, name));
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
        exports_map: first.subpaths?.exportsMap ?? null,
        listed: first.subpaths?.listed ?? null,
        patterns: first.subpaths?.patterns ?? null,
        reason: first.subpaths?.reason ?? null,
        lock_sha256: await fileSha256(
          join(locks, `${name.replace("/", "__")}@${version}.package-lock.json`),
        ),
        subpaths: subpathDetail(first),
        problems: Object.fromEntries(
          (first.subpaths?.subpaths ?? []).map(({ key, outcome }) => [key, outcome.problems]),
        ),
      };
      const listedCount = first.subpaths?.listed ?? null;
      const builtCount = first.subpaths?.subpaths?.length ?? 0;
      const buildable =
        first.subpaths?.exportsMap === true && listedCount !== null && listedCount <= SUBPATH_LIMIT;
      const rootFailed = first.whole.problems.some((p) => p.code === "TOOLCHAIN_MISMATCH");
      if (buildable && !rootFailed && builtCount !== listedCount) {
        coverage.push(`${spec}: ${builtCount} of ${listedCount} listed subpaths built`);
      }
      // number of builds, and A (ii) on its reasons. Gate F is timed on the serial schedule (one
      // worker, one candidate at a time, today's order: SPEC.md, "Parallel builds (#7)").
      let ms = 0;
      const report = await rootEntryBundle(dir, name, await manifestIn(dir, name), {
        serial: true,
        onSubpathPhase: (elapsed) => {
          ms = elapsed;
        },
      });
      const map = report.bundle.subpaths_whole_eager_js_gzip9_bytes;
      const built = map ? Object.keys(map).length : 0;
      times.push({ spec, ms: Math.round(ms), count, built });
      for (const repeated of repeatedCodes(report.reasons)) aFail.push(`${spec}: ${repeated}`);
      for (const framing of framingProblems(report.reasons)) aFail.push(`${spec}: ${framing}`);
      const nullCodes = new Map(
        (subpathDetail(first) ?? [])
          .filter((d) => map !== null && map[d.entry_point] === null)
          .map((d) => [d.entry_point, d.unmeasurable_codes]),
      );
      for (const problem of pairProblems(report.reasons, nullCodes)) {
        aFail.push(`${spec} (default report): ${problem}`);
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
    source: await sourceIdentity(),
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

type SavedMeasurement = Measured & { reason: string | null; problems: Record<string, Problem[]> };

type Measured = {
  exports_map: boolean | null;
  listed: number | null;
  patterns: string[] | null;
  lock_sha256: string | null;
  subpaths: Array<{
    entry_point: string;
    whole_eager_js_gzip9_bytes: number | null;
    unmeasurable_codes: string[];
  }> | null;
};

async function loadMeasured(
  file: string,
  locks: string,
): Promise<{ measured: Map<string, Measured>; problems: string[] }> {
  const raw = asRecord(await readJson(file));
  const problems: string[] = [];
  if (!Object.keys(raw).length) return { measured: new Map(), problems: [`${file}: unreadable`] };
  if (asArray(raw.coverage).length) problems.push(`${file}: its coverage failed`);
  const source = await sourceIdentity();
  if (source === null || asString(raw.source) !== source) {
    problems.push(
      `${file}: made with src/ ${asString(raw.source) ?? "?"}, now ${source ?? "uncommitted"}`,
    );
  }
  const measured = new Map<string, Measured>();
  for (const [spec, value] of Object.entries(asRecord(raw.measured))) {
    const m = asRecord(value);
    const at = spec.lastIndexOf("@");
    const lock = await fileSha256(
      join(
        locks,
        `${spec.slice(0, at).replace("/", "__")}@${spec.slice(at + 1)}.package-lock.json`,
      ),
    );
    if (lock === null || lock !== asString(m.lock_sha256))
      problems.push(`${spec}: lockfile changed`);
    const subpaths = Array.isArray(m.subpaths)
      ? m.subpaths.map(asRecord).map((d) => ({
          entry_point: asString(d.entry_point) ?? "",
          whole_eager_js_gzip9_bytes: asNumber(d.whole_eager_js_gzip9_bytes),
          unmeasurable_codes: asStringArray(d.unmeasurable_codes),
        }))
      : null;
    measured.set(spec, {
      exports_map: typeof m.exports_map === "boolean" ? m.exports_map : null,
      listed: asNumber(m.listed),
      patterns: Array.isArray(m.patterns) ? asStringArray(m.patterns) : null,
      lock_sha256: asString(m.lock_sha256),
      subpaths,
    });
  }
  return { measured, problems };
}

/**
 * The members of every `subpaths_whole_eager_js_gzip9_bytes` object in a report's raw JSON text,
 * in order of appearance, duplicates kept: null for a null map. JSON.parse would drop duplicate
 * members, so gate E (ii) reads them from the text the CLI printed.
 */
export function rawMapKeys(text: string): Array<string[] | null> {
  const maps: Array<string[] | null> = [];
  const field = '"subpaths_whole_eager_js_gzip9_bytes": ';
  for (let at = text.indexOf(field); at >= 0; at = text.indexOf(field, at + 1)) {
    let i = at + field.length;
    if (text.startsWith("null", i)) {
      maps.push(null);
      continue;
    }
    const keys: string[] = [];
    i++;
    for (;;) {
      while (/\s|,/.test(text[i] ?? "")) i++;
      if (text[i] === "}" || i >= text.length) break;
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      keys.push(String(JSON.parse(text.slice(i, end + 1))));
      i = end + 1;
      while (text[i] !== "," && text[i] !== "}" && i < text.length) i++;
    }
    maps.push(keys);
  }
  return maps;
}

/**
 * Gate E for one package's bundle (SPEC.md iteration 2, amended 2026-11-07): (i) fields and the
 * states' precedence, the metadata equal to the measurement call's listing; (ii) the map's
 * serialized members (`rawKeys`, from the printed JSON) unique and in code-point order; (iii)
 * correspondence with the measurement call on the same frozen tree; (iv) every (key, code) pair
 * named once, nothing else named, framing kept, and every code in one entry.
 */
function contractProblems(
  pkg: Record<string, unknown>,
  measured: Measured | undefined,
  rawKeys: string[] | null | undefined,
): string[] {
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
  const reasons = bundleEntries(pkg);
  const problems: string[] = [...repeatedCodes(reasons), ...framingProblems(reasons)];
  const map = bundle.subpaths_whole_eager_js_gzip9_bytes;
  const listed = bundle.subpaths_listed;
  const exportsMap = bundle.exports_map;
  const patterns = bundle.subpath_patterns_unmeasured;
  const noPairs = () => {
    if (namedPairs(reasons).size) problems.push("subpath keys named, but the map has no values");
  };
  if (!measured) return [...problems, "no measurement-call result for this package"];
  if (exportsMap !== measured.exports_map)
    problems.push(`exports_map ${String(exportsMap)} vs measured ${String(measured.exports_map)}`);
  if (listed !== measured.listed)
    problems.push(`subpaths_listed ${String(listed)} vs measured ${String(measured.listed)}`);
  if (JSON.stringify(patterns) !== JSON.stringify(measured.patterns))
    problems.push("patterns differ from the measurement");
  const rootFailed = reasons.some((r) => /^bundle: (TOOLCHAIN_MISMATCH|BUNDLER_ERROR)\b/.test(r));
  if (exportsMap === null) {
    if (listed !== null || map !== null || patterns !== null)
      problems.push("unknown listing, non-null fields");
    if (!reasons.some((r) => r.startsWith("bundle: SUBPATH_LIST_FAILED"))) {
      problems.push("unknown listing without SUBPATH_LIST_FAILED");
    }
    noPairs();
    return problems;
  }
  if (typeof exportsMap !== "boolean") problems.push("exports_map is not a boolean");
  if (typeof listed !== "number") return [...problems, "subpaths_listed is not a number"];
  if (!Array.isArray(patterns)) problems.push("patterns not a list");
  if (exportsMap === false) {
    if (map !== null || listed !== 0) problems.push("no map, yet subpaths");
    noPairs();
    return problems;
  }
  if (listed === 0) {
    if (!isRecord(map) || Object.keys(map).length) problems.push("empty listing, map not {}");
    noPairs();
    return problems;
  }
  if (listed > REPORT_SUBPATH_LIMIT) {
    if (map !== null) problems.push("over the cap, map not null");
    if (!reasons.includes(`bundle: SUBPATH_LIMIT ${listed}`)) {
      problems.push(`over the cap without bundle: SUBPATH_LIMIT ${listed}`);
    }
    noPairs();
    return problems;
  }
  if (rootFailed) {
    if (map !== null) problems.push("the root failed, map not null");
    noPairs();
    return problems;
  }
  if (map === null) {
    problems.push("null map without a reason of its own");
    noPairs();
    return problems;
  }
  if (!isRecord(map)) return [...problems, "map is not an object"];
  const members = rawKeys ?? [];
  if (rawKeys === undefined || rawKeys === null)
    problems.push("map members not found in the JSON text");
  if (new Set(members).size !== members.length) problems.push("duplicate map members");
  if (JSON.stringify(members) !== JSON.stringify([...members].sort(byCodePoint))) {
    problems.push("map members not in code-point order");
  }
  if (members.length !== listed)
    problems.push(`map has ${members.length} members, listed ${listed}`);
  if (!measured.subpaths) return [...problems, "measurement call built no subpaths"];
  const expectedKeys = measured.subpaths.map((d) => d.entry_point);
  if (JSON.stringify(members) !== JSON.stringify(expectedKeys)) {
    problems.push(`keys ${members.join(" ")} vs measured ${expectedKeys.join(" ")}`);
  }
  const nullCodes = new Map<string, string[]>();
  for (const detail of measured.subpaths) {
    const value = map[detail.entry_point];
    if (value !== detail.whole_eager_js_gzip9_bytes) {
      problems.push(
        `${detail.entry_point}: ${String(value)} vs measured ${String(detail.whole_eager_js_gzip9_bytes)}`,
      );
    }
    if (value === null) nullCodes.set(detail.entry_point, detail.unmeasurable_codes);
  }
  problems.push(...pairProblems(reasons, nullCodes));
  return problems;
}

const failedIn = (report: unknown) =>
  asArray(asRecord(report).packages).flatMap((pkg) =>
    asStringArray(asRecord(pkg).unavailable).flatMap(
      (entry) => NETWORK_ENTRY.exec(entry)?.[1]?.toLowerCase() ?? [],
    ),
  );

/** Framework entry points: gate R's miss class 3 (SPEC.md iteration 2). */
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

/** Gate R's algorithm (SPEC.md iteration 2). */
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

async function scoreReports(options: {
  on: string;
  again: string;
  off: string;
  measured: string | undefined;
  locks: string;
  control: string;
}): Promise<void> {
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
  if (!options.measured) coverage.push("no --measured <subpath-probes result> given");
  const loaded = options.measured
    ? await loadMeasured(options.measured, options.locks)
    : { measured: new Map<string, Measured>(), problems: [] };
  const { measured } = loaded;
  coverage.push(...loaded.problems);
  const eFail: string[] = [];
  const eDiffs: string[] = [];
  const eFlakes: string[] = [];
  const dFail: string[] = [];
  const candidates: Candidate[] = [];
  const coverageR: string[] = [];
  const overCap: string[] = [];
  for (const { project, base } of files) {
    const id = `${project}/${base}`;
    const onText = await readFile(join(options.on, project, `${base}.json`), "utf8");
    const on = asRecord(JSON.parse(onText));
    const raw = rawMapKeys(onText);
    const withBundle = asArray(on.packages).filter((p) => asRecord(p).bundle !== null).length;
    if (raw.length !== withBundle) {
      coverage.push(`${id}: ${raw.length} subpath maps in the text, ${withBundle} bundles`);
    }
    let withMap = 0;
    const again = asRecord(await readJson(join(options.again, project, `${base}.json`)));
    const off = await readJson(join(options.off, project, `${base}.json`));
    const onPackages = asArray(on.packages).map(asRecord);
    const againPackages = asArray(again.packages).map(asRecord);
    const control = asRecord(await readJson(join(options.control, project, `${base}.json`)));
    const controlVersions = asArray(control.packages).map((p) => asString(asRecord(p).version));
    const versions = onPackages.map((p) => asString(p.version));
    if (JSON.stringify(versions) !== JSON.stringify(controlVersions)) {
      coverage.push(
        `${id}: versions ${versions.join(" ")} vs control ${controlVersions.join(" ")}`,
      );
    }
    for (const [i, pkg] of onPackages.entries()) {
      const other = againPackages[i] ?? {};
      const a = JSON.stringify([pkg.version, pkg.bundle, bundleEntries(pkg).sort()]);
      const b = JSON.stringify([other.version, other.bundle, bundleEntries(other).sort()]);
      if (a !== b) dFail.push(`${id} ${asString(pkg.name)}: two runs differ`);
      const spec = `${asString(pkg.name)}@${asString(pkg.version)}`;
      const rawKeys = pkg.bundle === null ? undefined : raw[withMap++];
      for (const problem of contractProblems(pkg, measured.get(spec), rawKeys)) {
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
    measured: { type: "string" },
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
    await scoreReports({
      on: values.on,
      again: values.again,
      off: values.off,
      measured: values.measured,
      locks: values.locks,
      control: values.control,
    });
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

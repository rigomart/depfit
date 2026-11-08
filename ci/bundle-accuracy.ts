/**
 * Replays the bundle eval's frozen reference cases (eval/bundle) on their saved install trees and
 * requires depfit's exact numbers and expected reason codes. Installs replay through the CLI's
 * `DEPFIT_LOCK_DIR` switch, so every result is deterministic and any difference is a real change
 * in depfit's numbers. Cases are read from the eval's files, so new ones are picked up as added.
 *
 * - single-reference.json, whole entry point: the CLI's four `whole_*` fields equal the stock Vite
 *   build (`whole_vite`), on every package that has one.
 * - single-reference.json, each export alone: depfit's four byte numbers equal the export's stock
 *   Vite build, and the exports listed in single-nulls.json are null with exactly their code.
 * - cases.json, null cases that import the root: the CLI's whole build is null, and `unavailable`
 *   holds the case's `bundle: <code>` (and specifier).
 * - subpath-reference.json, each subpath of an exports map alone and whole: depfit's four byte
 *   numbers equal the subpath's stock Vite build, and the subpaths listed in subpath-nulls.json are
 *   null with exactly their code and kind of specifier.
 *
 *   bun ci/bundle-accuracy.ts [--timings file]   # {"bundle.<step>.<name>": ms} for ci/perf.ts
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type BundleBytes, externalPackages } from "../src/collect/bundle.ts";
import { withIsolatedInstall } from "../src/collect/install.ts";
import { measureRootEntry } from "../src/collect/root-entry.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  isRecord,
} from "../src/collect/util.ts";

const REPO = join(import.meta.dirname, "..");
const CLI = join(REPO, "src/cli.ts");
const EVAL = join(REPO, "eval/bundle");

const REFERENCE_FILES: Record<string, string> = {
  "single-reference.json": "replayed",
  "subpath-reference.json": "replayed",
  "reference.json":
    "not replayed: v1 import-snippet cases, measured through the snippet API that schema 6 removed",
  "wild-reference.json":
    "not replayed: gate W's corpus of about 200 packages, too slow for every pull request",
};

const REF_KEYS = ["min_bytes", "gzip_bytes", "lazy_min_bytes", "lazy_gzip_bytes"] as const;
type RefKey = (typeof REF_KEYS)[number];
const WHOLE_FIELDS: Record<RefKey, string> = {
  min_bytes: "whole_eager_js_min_bytes",
  gzip_bytes: "whole_eager_js_gzip9_bytes",
  lazy_min_bytes: "whole_lazy_js_min_bytes",
  lazy_gzip_bytes: "whole_lazy_js_gzip9_bytes",
};
const OUTCOME_FIELDS: Record<RefKey, keyof BundleBytes> = {
  min_bytes: "eager_js_min_bytes",
  gzip_bytes: "eager_js_gzip9_bytes",
  lazy_min_bytes: "lazy_js_min_bytes",
  lazy_gzip_bytes: "lazy_js_gzip9_bytes",
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const lockName = (name: string, version: string) =>
  `${name.replace("/", "__")}@${version}.package-lock.json`;

function byteDiffs(got: (key: RefKey) => unknown, ref: unknown): string[] {
  const reference = asRecord(ref);
  return REF_KEYS.flatMap((key) => {
    const want = asNumber(reference[key]);
    const have = asNumber(got(key));
    if (want === null) return [`reference has no ${key} (${asString(reference.error) ?? "?"})`];
    return have === want ? [] : [`${key} ${have ?? "null"} vs reference ${want}`];
  });
}

type CliCase = { label: string; spec: string; check: (pkg: Record<string, unknown>) => string[] };
type ExportNull = { package: string; export: string; code: string; specifiers: unknown };
type SubpathNull = { package: string; subpath: string; code: string; specifiers: unknown };

const { values } = parseArgs({ options: { timings: { type: "string" } } });
const failures: string[] = [];
const counts: Record<string, number> = {};
const timings: Record<string, number> = {};
const count = (set: string) => {
  counts[set] = (counts[set] ?? 0) + 1;
};

for (const file of (await readdir(EVAL)).filter((f) => /reference.*\.json$/.test(f)).sort()) {
  if (!(file in REFERENCE_FILES)) {
    failures.push(
      `eval/bundle/${file}: a reference set ci/bundle-accuracy.ts does not replay; add a check for it, or list it in REFERENCE_FILES with why it is not replayed`,
    );
  }
}

const singleRef = asRecord(await readJson(join(EVAL, "single-reference.json")));
const references = asArray(singleRef.packages).map(asRecord);
const exportNulls: ExportNull[] = asArray(
  asRecord(await readJson(join(EVAL, "single-nulls.json"))).nulls,
).map((raw) => {
  const entry = asRecord(raw);
  return {
    package: asString(entry.package) ?? "",
    export: asString(entry.export) ?? "",
    code: asString(entry.code) ?? "",
    specifiers: entry.specifiers,
  };
});
const subpathRefs = asArray(
  asRecord(await readJson(join(EVAL, "subpath-reference.json"))).packages,
).map(asRecord);
const subpathNulls: SubpathNull[] = asArray(
  asRecord(await readJson(join(EVAL, "subpath-nulls.json"))).nulls,
).map((raw) => {
  const entry = asRecord(raw);
  return {
    package: asString(entry.package) ?? "",
    subpath: asString(entry.subpath) ?? "",
    code: asString(entry.code) ?? "",
    specifiers: entry.specifiers,
  };
});
const nullCases = asArray(await readJson(join(EVAL, "cases.json")))
  .map(asRecord)
  .filter(
    (c) =>
      c.expect === "null" &&
      (c.step ?? "1") === "1" &&
      c.target === "browser" &&
      asArray(c.imports).every((i) => asRecord(i).from === c.package),
  );

const lockDir = await mkdtemp(join(tmpdir(), "depfit-ci-locks-"));
const scratch = await mkdtemp(join(tmpdir(), "depfit-ci-web-"));
await writeFile(join(scratch, "package.json"), JSON.stringify({ name: "scratch", private: true }));
await writeFile(join(scratch, "index.html"), "<!doctype html>\n");
const frozen = new Map<string, string>();
async function freeze(name: string, version: string, source: string): Promise<void> {
  const target = lockName(name, version);
  const earlier = frozen.get(target);
  if (earlier && (await readFile(earlier, "utf8")) !== (await readFile(source, "utf8"))) {
    failures.push(`${name}@${version}: two different frozen trees (${earlier}, ${source})`);
  }
  frozen.set(target, source);
  await copyFile(source, join(lockDir, target));
}
for (const ref of references) {
  const id = asString(ref.id) ?? "";
  await freeze(
    asString(ref.package) ?? "",
    asString(ref.version) ?? "",
    join(EVAL, "locks/wild", `${id}.json`),
  );
}
for (const ref of subpathRefs) {
  const lock = join(EVAL, "locks/wild", `${asString(ref.id) ?? ""}.json`);
  // The tree must be the one the reference was built from (subpath-reference.json records it).
  const sha = createHash("sha256")
    .update(await readFile(lock))
    .digest("hex");
  if (sha !== asString(ref.lock_sha256)) {
    failures.push(
      `${asString(ref.package)}: frozen tree differs from the reference's (lock_sha256)`,
    );
  }
  await freeze(asString(ref.package) ?? "", asString(ref.version) ?? "", lock);
}
for (const c of nullCases) {
  await freeze(
    asString(c.package) ?? "",
    asString(c.version) ?? "",
    join(EVAL, "locks", `${asString(c.id)}.json`),
  );
}
process.env.DEPFIT_LOCK_DIR = lockDir;
// The trees were frozen with `npm ci --legacy-peer-deps` (eval/bundle/reference.ts); no bundle
// includes peers.
process.env.npm_config_legacy_peer_deps = "true";

function cli(spec: string): Promise<{ report: unknown; error: string | null; ms: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, spec, "--json", "--cwd", scratch],
      { maxBuffer: 1 << 26, timeout: 600_000 },
      (error, stdout, stderr) => {
        const ms = Math.round(performance.now() - started);
        try {
          resolve({ report: JSON.parse(stdout), error: null, ms });
        } catch {
          resolve({
            report: null,
            error: (stderr || String(error)).trim().split("\n")[0] ?? "",
            ms,
          });
        }
      },
    );
  });
}

const cliCases: CliCase[] = [
  ...references
    .filter((ref) => isRecord(ref.whole_vite))
    .map((ref) => ({
      label: `whole ${asString(ref.package)}@${asString(ref.version)}`,
      spec: `${asString(ref.package)}@${asString(ref.version)}`,
      check: (pkg: Record<string, unknown>) => {
        const bundle = asRecord(pkg.bundle);
        const diffs = byteDiffs((key) => bundle[WHOLE_FIELDS[key]], ref.whole_vite);
        const unavailable = asStringArray(pkg.unavailable);
        return diffs.length && unavailable.length
          ? [...diffs, `unavailable: ${unavailable.join("; ")}`]
          : diffs;
      },
    })),
  ...nullCases.map((c) => {
    const code = asString(c.code) ?? "";
    const specifier = asString(c.specifier);
    return {
      label: `null ${asString(c.id)} (${asString(c.package)}@${asString(c.version)})`,
      spec: `${asString(c.package)}@${asString(c.version)}`,
      check: (pkg: Record<string, unknown>) => {
        const bundle = pkg.bundle;
        const reasons = asStringArray(pkg.unavailable).filter((e) => e.startsWith("bundle: "));
        const problems: string[] = [];
        if (!isRecord(bundle)) problems.push("bundle is null");
        else {
          const set = Object.values(WHOLE_FIELDS).filter((field) => bundle[field] !== null);
          if (set.length) problems.push(`${set.join(", ")} not null`);
        }
        const prefix = `bundle: ${code}`;
        const found = reasons.some(
          (e) =>
            (e === prefix || e.startsWith(`${prefix} `)) && (!specifier || e.includes(specifier)),
        );
        if (!found)
          problems.push(
            `no "${prefix}${specifier ? ` ${specifier}` : ""}" in unavailable (got ${reasons.join("; ") || "none"})`,
          );
        return problems;
      },
    };
  }),
];

let cliTotal = 0;
for (const c of cliCases) {
  const run = await cli(c.spec);
  timings[`bundle.cli.${c.spec}`] = run.ms;
  cliTotal += run.ms;
  const pkg = asRecord(asArray(asRecord(run.report).packages)[0]);
  const problems = run.report ? c.check(pkg) : [`no report: ${run.error}`];
  count(c.label.split(" ")[0] === "whole" ? "whole entry point (CLI)" : "null case (CLI)");
  failures.push(...problems.map((p) => `${c.label}: ${p}`));
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.label} ${run.ms} ms`);
}
timings["bundle.cli.total"] = cliTotal;

function nullProblem(
  listed: { code: string; specifiers: unknown },
  problems: Array<{ code: string; specifier: string | null }>,
): string | null {
  const codes = [...new Set(problems.map((p) => p.code))];
  if (codes.length !== 1 || codes[0] !== listed.code) {
    return `null with ${codes.join(", ") || "no code"}, expected ${listed.code}`;
  }
  const allowed = (s: string | null) =>
    listed.specifiers === "node-builtins"
      ? s !== null && isBuiltin(s)
      : listed.specifiers === "worker"
        ? s?.startsWith("worker ") === true
        : asStringArray(listed.specifiers).includes(s ?? "");
  const other = [
    ...new Set(problems.filter((p) => !allowed(p.specifier)).map((p) => p.specifier ?? "none")),
  ];
  return other.length ? `unexpected specifiers ${other.join(", ")}` : null;
}

let measureTotal = 0;
for (const ref of references) {
  const name = asString(ref.package) ?? "";
  const version = asString(ref.version) ?? "";
  try {
    const measured = await withIsolatedInstall(name, version, async ({ dir }) => {
      const manifest = asRecord(await readJson(join(dir, "node_modules", name, "package.json")));
      const started = performance.now();
      const m = await measureRootEntry(dir, name, externalPackages(manifest));
      return { m, ms: Math.round(performance.now() - started) };
    });
    timings[`bundle.measure.${name}`] = measured.ms;
    measureTotal += measured.ms;
    const outcomes = new Map((measured.m.singles ?? []).map((s) => [s.name, s.outcome]));
    let bad = 0;
    for (const exportName of asStringArray(ref.exports)) {
      count("export alone (library)");
      const label = `export ${name}@${version} ${exportName}`;
      const outcome = outcomes.get(exportName);
      const listed = exportNulls.find((n) => n.package === name && n.export === exportName);
      let problems: string[];
      if (!outcome)
        problems = [`not among depfit's ${measured.m.names?.length ?? "unlisted"} exports`];
      else if (listed) {
        const problem = outcome.bytes
          ? `measured, but single-nulls.json lists it as ${listed.code}`
          : nullProblem(listed, outcome.problems);
        problems = problem ? [problem] : [];
      } else if (!outcome.bytes) {
        problems = [
          `null with ${outcome.problems.map((p) => `${p.code} ${p.specifier ?? ""}`.trim()).join(", ")}`,
        ];
      } else {
        const bytes = outcome.bytes;
        problems = byteDiffs(
          (key) => bytes[OUTCOME_FIELDS[key]],
          asRecord(asRecord(ref.singles)[exportName]).vite,
        );
      }
      if (problems.length) bad += 1;
      failures.push(...problems.map((p) => `${label}: ${p}`));
    }
    console.log(`${bad ? "FAIL" : "ok  "} exports ${name}@${version} ${measured.ms} ms`);
  } catch (error) {
    failures.push(
      `exports ${name}@${version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
timings["bundle.measure.total"] = measureTotal;

let subpathTotal = 0;
for (const ref of subpathRefs) {
  const name = asString(ref.package) ?? "";
  const version = asString(ref.version) ?? "";
  try {
    const measured = await withIsolatedInstall(name, version, async ({ dir }) => {
      const manifest = asRecord(await readJson(join(dir, "node_modules", name, "package.json")));
      const started = performance.now();
      const m = await measureRootEntry(dir, name, externalPackages(manifest), { subpaths: true });
      return { m, ms: Math.round(performance.now() - started) };
    });
    timings[`bundle.subpaths.${name}`] = measured.ms;
    subpathTotal += measured.ms;
    const outcomes = new Map((measured.m.subpaths?.subpaths ?? []).map((s) => [s.key, s.outcome]));
    let bad = 0;
    for (const [key, refs] of Object.entries(asRecord(ref.subpaths))) {
      count("subpath alone (library)");
      const label = `subpath ${name}@${version} ${key}`;
      const outcome = outcomes.get(key);
      const listed = subpathNulls.find((n) => n.package === name && n.subpath === key);
      let problems: string[];
      if (!outcome) problems = ["not listed or not built by depfit"];
      else if (listed) {
        const problem = outcome.bytes
          ? `measured, but subpath-nulls.json lists it as ${listed.code}`
          : nullProblem(listed, outcome.problems);
        problems = problem ? [problem] : [];
      } else if (!outcome.bytes) {
        problems = [
          `null with ${outcome.problems.map((p) => `${p.code} ${p.specifier ?? ""}`.trim()).join(", ")}`,
        ];
      } else {
        const bytes = outcome.bytes;
        problems = byteDiffs((k) => bytes[OUTCOME_FIELDS[k]], asRecord(refs).vite);
      }
      if (problems.length) bad += 1;
      failures.push(...problems.map((p) => `${label}: ${p}`));
    }
    console.log(`${bad ? "FAIL" : "ok  "} subpaths ${name}@${version} ${measured.ms} ms`);
  } catch (error) {
    failures.push(
      `subpaths ${name}@${version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
timings["bundle.subpaths.total"] = subpathTotal;

await rm(lockDir, { recursive: true, force: true });
await rm(scratch, { recursive: true, force: true });
if (values.timings) await writeFile(values.timings, `${JSON.stringify(timings, null, 2)}\n`);

const lines = [
  "## Bundle accuracy",
  "",
  "| Reference cases | Checked |",
  "|---|---|",
  ...Object.entries(counts).map(([set, n]) => `| ${set} | ${n} |`),
  "",
  ...Object.entries(REFERENCE_FILES)
    .filter(([, why]) => why !== "replayed")
    .map(([file, why]) => `- \`eval/bundle/${file}\`: ${why}`),
  "",
  failures.length ? `**${failures.length} failures**` : "All cases exact.",
  ...failures.map((f) => `- ${f}`),
];
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `\n${Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ")}; ${failures.length} failures`,
);
process.exitCode = failures.length ? 1 : 0;

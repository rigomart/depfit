/**
 * End-to-end check of the CLI on the small projects in test/fixtures, on the runtime that runs this
 * script (`bun ci/e2e.ts` or `node ci/e2e.ts`): each `--json` report must follow the output
 * contract (ci/contract.ts), plus a few structural expectations per project. Live facts are
 * checked for shape only. Needs network access and `npm` on PATH.
 *
 *   bun ci/e2e.ts [--timings file]   # writes {"e2e.<runtime>.<run>": ms, ...} for ci/perf.ts
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { asArray, asNumber, asRecord, asString, isRecord } from "../src/collect/util.ts";
import * as fixtures from "../test/reports.ts";
import { kindsOf, structureProblems, unavailableProblems } from "./contract.ts";

const REPO = join(import.meta.dirname, "..");
const CLI = join(REPO, "src/cli.ts");
const FIXTURES = join(REPO, "test/fixtures");
const RUNTIME = process.versions.bun ? "bun" : `node${process.versions.node.split(".")[0]}`;

type Run = { code: number; stdout: string; stderr: string; ms: number };

/**
 * Every run gets its own empty cache directory unless it names one, so no scenario reads another's
 * results and none ever touches the user's own cache (SPEC.md, "Cache (#8)", K6).
 */
const CACHE_ROOT = await mkdtemp(join(tmpdir(), "depfit-e2e-cache-"));
let cacheRuns = 0;
const freshCacheHome = () => join(CACHE_ROOT, String(cacheRuns++));

function depfit(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cacheHome: string = freshCacheHome(),
): Promise<Run> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...env, XDG_CACHE_HOME: cacheHome }, maxBuffer: 1 << 26, timeout: 300_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) });
      },
    );
  });
}

type Package = Record<string, unknown>;
type Scenario = {
  name: string;
  cwd: string;
  specs: string[];
  /** Default 0; the CLI exits 1 only when no spec could be resolved. */
  exit?: number;
  env?: NodeJS.ProcessEnv;
  expect: Array<(report: Record<string, unknown>, pkgs: Package[]) => string | null>;
};

const lockfile = (name: string) => (report: Record<string, unknown>) =>
  asRecord(report.project).lockfile === name ? null : `project.lockfile is not ${name}`;
const installedZod = (_: unknown, pkgs: Package[]) =>
  asArray(asRecord(pkgs[0]?.in_repo).installed_versions).length
    ? null
    : "zod is not reported as installed (it is in the lockfile)";

/**
 * No GitHub token: a failing `gh` goes first on PATH, since a logged-in gh reads its token from the
 * OS keyring.
 */
async function noTokenEnv(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-e2e-gh-"));
  await writeFile(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { GITHUB_TOKEN: _a, GH_TOKEN: _b, ...env } = process.env;
  return { env: { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ""}` }, dir };
}

async function scenarios(noToken: NodeJS.ProcessEnv): Promise<Scenario[]> {
  return [
    {
      name: "npm-lockfile",
      cwd: "lockfile-npm",
      specs: ["zod", "valibot@^1", "node:sqlite", "depfit-ci-no-such-package"],
      expect: [
        lockfile("package-lock.json"),
        installedZod,
        (_, p) => (p[2]?.kind === "builtin" ? null : "node:sqlite is not kind builtin"),
        (_, p) => (asString(p[3]?.error) ? null : "the missing package has no error"),
      ],
    },
    {
      name: "only-missing",
      cwd: "lockfile-npm",
      specs: ["depfit-ci-no-such-package"],
      exit: 1,
      expect: [(_, p) => (asString(p[0]?.error) ? null : "the missing package has no error")],
    },
    {
      name: "pnpm-lockfile",
      cwd: "lockfile-pnpm",
      specs: ["zod"],
      expect: [lockfile("pnpm-lock.yaml"), installedZod],
    },
    {
      name: "yarn-lockfile",
      cwd: "lockfile-yarn",
      specs: ["zod"],
      expect: [lockfile("yarn.lock"), installedZod],
    },
    {
      name: "bun-lockfile",
      cwd: "lockfile-bun",
      specs: ["zod"],
      expect: [lockfile("bun.lock"), installedZod],
    },
    {
      name: "bun-workspace",
      cwd: "bun-workspace/apps/api",
      specs: ["hono", "bun:sqlite"],
      expect: [
        (r) =>
          asRecord(r.project).runtime === "cloudflare-workers"
            ? null
            : "apps/api is not a Workers workspace",
      ],
    },
    {
      name: "pnpm-workspace",
      cwd: "pnpm-workspace/packages/ui",
      specs: ["react"],
      expect: [
        (_, p) =>
          p[0]?.version_source === "declared_range" ? null : "react's catalog: range was not used",
      ],
    },
    {
      name: "browser-workspace",
      cwd: "browser-app",
      specs: ["clsx"],
      expect: [
        (r) => (asArray(asRecord(r.project).browser_signals).length ? null : "no browser signal"),
        (_, p) =>
          (asNumber(asRecord(p[0]?.bundle).whole_eager_js_min_bytes) ?? 0) > 0
            ? null
            : "clsx has no whole_eager_js_min_bytes",
      ],
    },
    {
      name: "no-github-token",
      cwd: "lockfile-npm",
      specs: ["zod"],
      env: noToken,
      expect: [
        (_, p) =>
          asArray(p[0]?.unavailable).includes("github: no token")
            ? null
            : 'no "github: no token" entry',
      ],
    },
  ];
}

/** The facts a hit must give byte for byte as the build it reuses (SPEC.md, gate K1). */
function cachedFacts(report: Record<string, unknown>): string {
  return JSON.stringify(
    asArray(report.packages).map((value) => {
      const pkg = asRecord(value);
      const { measured_at: _measuredAt, ...bundle } = asRecord(pkg.bundle);
      const compatibility = asRecord(pkg.compatibility);
      return {
        bundle,
        reasons: asArray(pkg.unavailable).filter((entry) => String(entry).startsWith("bundle:")),
        cost: pkg.cost,
        types: [
          compatibility.types_source,
          compatibility.types_package,
          compatibility.licenses_in_tree,
        ],
      };
    }),
  );
}

const measuredAt = (report: Record<string, unknown>) =>
  asArray(report.packages).map((value) => asRecord(asRecord(value).bundle).measured_at ?? null);

/**
 * The browser workspace twice on one cache, then with --no-cache: the second call is a hit (the
 * first's facts and measured_at, and npm only resolves: no install, no npm ci); the third builds.
 */
async function cacheScenario(): Promise<string[]> {
  const cwd = join(FIXTURES, "browser-app");
  const cacheHome = freshCacheHome();
  const wrapperDir = await mkdtemp(join(tmpdir(), "depfit-e2e-npm-"));
  const log = join(wrapperDir, "args.log");
  // First on PATH, it logs its arguments and runs the npm that comes after it on PATH.
  await writeFile(
    join(wrapperDir, "npm"),
    `#!/bin/sh\necho "$*" >> "$DEPFIT_E2E_NPM_LOG"\nPATH="\${PATH#*${delimiter}}" exec npm "$@"\n`,
    { mode: 0o755 },
  );
  const env = (name: string) => ({
    ...process.env,
    PATH: `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`,
    DEPFIT_E2E_NPM_LOG: `${log}.${name}`,
  });
  const problems: string[] = [];
  try {
    const runs: Record<string, Record<string, unknown>> = {};
    for (const [name, extra] of [
      ["cold", []],
      ["hit", []],
      ["off", ["--no-cache"]],
    ] as const) {
      const run = await depfit(["clsx", "--json", "--cwd", cwd, ...extra], env(name), cacheHome);
      timings[`e2e.${RUNTIME}.cache-${name}`] = run.ms;
      if (run.code !== 0) problems.push(`${name}: exit code ${run.code}`);
      runs[name] = asRecord(JSON.parse(run.stdout || "{}"));
    }
    const { cold = {}, hit = {}, off = {} } = runs;
    if (cachedFacts(hit) !== cachedFacts(cold))
      problems.push("the hit's facts differ from the cold call's");
    if (cachedFacts(off) !== cachedFacts(cold))
      problems.push("--no-cache's facts differ from the cold call's");
    const [coldAt] = measuredAt(cold);
    if (typeof coldAt !== "string") problems.push("the cold call has no measured_at");
    if (measuredAt(hit)[0] !== coldAt)
      problems.push("the hit does not keep the cold call's measured_at");
    if (measuredAt(off)[0] === coldAt) problems.push("--no-cache kept the cached measured_at");
    const hitNpm = (await readFile(`${log}.hit`, "utf8").catch(() => "")).trim().split("\n");
    const materializing = hitNpm.filter(
      (line) => /^(ci\b|install\b)/.test(line) && !line.startsWith("install --package-lock-only"),
    );
    if (materializing.length) problems.push(`the hit ran ${materializing.join("; ")}`);
    if (!hitNpm.some((line) => line.startsWith("install --package-lock-only"))) {
      problems.push("the hit did not resolve the tree with npm");
    }
  } finally {
    await rm(wrapperDir, { recursive: true, force: true });
  }
  console.log(`${problems.length ? "FAIL" : "ok  "} cache (clsx: cold, hit, --no-cache)`);
  return problems;
}

const { values } = parseArgs({ options: { timings: { type: "string" } } });
const failures: string[] = [];
const timings: Record<string, number> = {};
const fail = (run: string, problems: string[]) =>
  failures.push(...problems.map((p) => `${run}: ${p}`));

const schemaRun = await depfit(["--schema"]);
timings[`e2e.${RUNTIME}.schema`] = schemaRun.ms;
const schema = asRecord(JSON.parse(schemaRun.stdout || "{}"));
const fields: Record<string, string> = {};
for (const [path, text] of Object.entries(asRecord(schema.fields))) {
  if (typeof text === "string" && text) fields[path] = text;
  else fail("--schema", [`${path} has no description`]);
}
if (schemaRun.code !== 0 || !Object.keys(fields).length)
  fail("--schema", ["no field descriptions"]);

const samples = Object.values(fixtures).flatMap((value): unknown[] => {
  if (!isRecord(value)) return [];
  if ("schema_version" in value) return [value];
  if ("requested" in value) return [{ packages: [value] }];
  if ("workspace" in value) return [{ project: value }];
  return [];
});
const kinds = kindsOf(samples, fields);
const untyped = Object.keys(fields).filter((path) => !kinds.has(path));
if (untyped.length) fail("fixtures", [`no sample value for ${untyped.join(", ")}`]);

const gh = await noTokenEnv();
try {
  for (const scenario of await scenarios(gh.env)) {
    const cwd = join(FIXTURES, scenario.cwd);
    const run = await depfit([...scenario.specs, "--json", "--cwd", cwd], scenario.env);
    timings[`e2e.${RUNTIME}.${scenario.name}`] = run.ms;
    const label = `${scenario.name} (${scenario.specs.join(" ")})`;
    if (run.code !== (scenario.exit ?? 0))
      fail(label, [`exit code ${run.code}: ${run.stderr.trim().split("\n")[0]}`]);
    let report: Record<string, unknown>;
    try {
      report = asRecord(JSON.parse(run.stdout));
    } catch {
      fail(label, [`no JSON on stdout: ${run.stderr.trim().split("\n")[0]}`]);
      continue;
    }
    const pkgs = asArray(report.packages).map(asRecord);
    const problems = [
      ...(report.schema_version === schema.schema_version
        ? []
        : ["schema_version differs from --schema"]),
      ...(pkgs.length === scenario.specs.length
        ? []
        : [`${pkgs.length} packages for ${scenario.specs.length} specs`]),
      ...structureProblems(report, fields, kinds),
      ...unavailableProblems(report, fields),
      ...scenario.expect.map((check) => check(report, pkgs)).filter((p): p is string => p !== null),
    ];
    fail(label, problems);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${label} ${run.ms} ms`);
  }
  fail("cache", await cacheScenario());
  const table = await depfit(["zod", "--table", "--cwd", join(FIXTURES, "lockfile-npm")]);
  timings[`e2e.${RUNTIME}.table`] = table.ms;
  if (table.code !== 0 || !table.stdout.includes("zod"))
    fail("--table", [`exit ${table.code}, no table`]);
} finally {
  await rm(gh.dir, { recursive: true, force: true });
  await rm(CACHE_ROOT, { recursive: true, force: true });
}

timings[`e2e.${RUNTIME}.total`] = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
if (values.timings) await writeFile(values.timings, `${JSON.stringify(timings, null, 2)}\n`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(`\n${RUNTIME}: ${failures.length} contract problems`);
process.exitCode = failures.length ? 1 : 0;

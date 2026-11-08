/**
 * End-to-end check of the CLI on the small projects in test/fixtures, on the runtime that runs this
 * script (`bun ci/e2e.ts` or `node ci/e2e.ts`): each `--json` report must follow the output contract
 * (ci/contract.ts), plus a few structural expectations per project. Live facts are checked for
 * shape only. Needs network access and `npm` on PATH.
 *
 *   bun ci/e2e.ts [--timings file]   # writes {"e2e.<runtime>.<run>": ms, ...} for ci/perf.ts
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function depfit(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env, maxBuffer: 1 << 26, timeout: 300_000 },
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
  /** Exit code the CLI must return (default 0): 1 when no spec could be resolved. */
  exit?: number;
  env?: NodeJS.ProcessEnv;
  /** Structural expectations beyond the contract; each returns a problem or null. */
  expect: Array<(report: Record<string, unknown>, pkgs: Package[]) => string | null>;
};

const lockfile = (name: string) => (report: Record<string, unknown>) =>
  asRecord(report.project).lockfile === name ? null : `project.lockfile is not ${name}`;
const installedZod = (_: unknown, pkgs: Package[]) =>
  asArray(asRecord(pkgs[0]?.in_repo).installed_versions).length
    ? null
    : "zod is not reported as installed (it is in the lockfile)";

/**
 * An environment where depfit finds no GitHub token: no env token, and a `gh` first on PATH that
 * fails (a logged-in gh can read its token from the OS keyring whatever its config dir).
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

// The JSON kind of every path, from the hand-written typed Report fixtures.
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
  const table = await depfit(["zod", "--table", "--cwd", join(FIXTURES, "lockfile-npm")]);
  timings[`e2e.${RUNTIME}.table`] = table.ms;
  if (table.code !== 0 || !table.stdout.includes("zod"))
    fail("--table", [`exit ${table.code}, no table`]);
} finally {
  await rm(gh.dir, { recursive: true, force: true });
}

timings[`e2e.${RUNTIME}.total`] = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
if (values.timings) await writeFile(values.timings, `${JSON.stringify(timings, null, 2)}\n`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(`\n${RUNTIME}: ${failures.length} contract problems`);
process.exitCode = failures.length ? 1 : 0;

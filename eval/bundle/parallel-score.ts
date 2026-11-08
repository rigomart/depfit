/**
 * #7's scorecard (SPEC.md, "Parallel builds (#7)"). Each subcommand loads the measurement code from
 * the checkout `--repo` names (default: this one), so the same script measures today's code (a
 * checkout of #7's parent) and #7's, and their outputs compare directly.
 *
 *   bun eval/bundle/parallel-score.ts same --out f.json [--repo dir] [--variants a,b] [--extra-locks dir] [--extra name@version...]
 *       P1 (a): every reference package (single-reference.json, the root null cases of cases.json,
 *       subpath-reference.json, and each --extra) on its frozen tree: the measurement call with the
 *       cap of 100 and the default report's call, in full, once per variant. Variants: `plain` (the
 *       call as written, the only one today's code has), `w1`, `w2`, `w4` (a pool of that size),
 *       `lifo1`, `lifo4` (newest build first) and `serial` (today's order, one worker).
 *   bun eval/bundle/parallel-score.ts compare <today.json> <ours.json>
 *       Every variant of the second file against the first file's `plain`; exits 1 on a difference.
 *   bun eval/bundle/parallel-score.ts step --installs dir [--repo dir] [--workers n] <pkg...>
 *       P2, P3: the bundle step of one call, as collect/index.ts runs it (every candidate at once;
 *       #7's code on one pool sized by `bundleWorkers`, or --workers). Prints one JSON line: wall
 *       ms, the summed and per-process peak memory of this process and its descendants (sampled
 *       every 100 ms), workers started and most live, and a sha256 of the reports. CPU time comes
 *       from running it under `/usr/bin/time -l`.
 *   bun eval/bundle/parallel-score.ts probe-call --control dir --locks dir --probe project/base [--repo dir]
 *       Iteration 2's default-call bound: the bundle step of one probe call (its npm candidates at
 *       the control run's versions, on the frozen trees), printed like `step`.
 *   bun eval/bundle/parallel-score.ts probe-list --control dir
 *       The probe calls with a browser signal, one `project/base` per line.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { asArray, asRecord, asString } from "../../src/collect/util.ts";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string", default: join(HERE, "..", "..") },
    out: { type: "string" },
    variants: { type: "string", default: "plain" },
    "extra-locks": { type: "string" },
    extra: { type: "string", multiple: true, default: [] },
    installs: { type: "string" },
    workers: { type: "string" },
    control: { type: "string" },
    locks: { type: "string" },
    probe: { type: "string" },
  },
});
const [command, ...rest] = positionals;
const repo = resolve(values.repo);

type RootEntryModule = typeof import("../../src/collect/root-entry.ts");
type BundleModule = typeof import("../../src/collect/bundle.ts");
type InstallModule = typeof import("../../src/collect/install.ts");
type PoolModule = typeof import("../../src/collect/vite-pool.ts");

const rootEntry: RootEntryModule = await import(join(repo, "src/collect/root-entry.ts"));
const bundle: BundleModule = await import(join(repo, "src/collect/bundle.ts"));
const install: InstallModule = await import(join(repo, "src/collect/install.ts"));
/** null for today's code, which has no pool. */
const poolModule: PoolModule | null = await import(join(repo, "src/collect/vite-pool.ts")).catch(
  () => null,
);

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const lockName = (name: string, version: string) =>
  `${name.replace("/", "__")}@${version}.package-lock.json`;

type Problem = { code: string; specifier: string | null };
const problemSet = (problems: Problem[]) =>
  [...new Set(problems.map((p) => `${p.code} ${p.specifier ?? ""}`))].sort();
const outcome = (value: { bytes: unknown; problems: Problem[]; externals?: string[] }) => ({
  bytes: value.bytes,
  problems: problemSet(value.problems),
  externals: value.externals ?? null,
});

/** A measurement in full, problem lists as sets (their order follows Vite's resolution order). */
function normalized(m: Awaited<ReturnType<RootEntryModule["measureRootEntry"]>>) {
  return {
    whole: outcome(m.whole),
    names: m.names,
    listProblems: problemSet(m.listProblems),
    singles: m.singles?.map((s) => [s.name, outcome(s.outcome)]) ?? null,
    subpaths: m.subpaths
      ? {
          exportsMap: m.subpaths.exportsMap,
          listed: m.subpaths.listed,
          patterns: m.subpaths.patterns,
          reason: m.subpaths.reason,
          subpaths: m.subpaths.subpaths?.map((s) => [s.key, outcome(s.outcome)]) ?? null,
        }
      : null,
  };
}

type Variant = { size: number | null; lifo: boolean; serial: boolean };
/** A variant by name; `#<n>` after it names a repetition (`plain#2`, the second run, for D). */
function variant(full: string): Variant {
  const name = full.split("#")[0] ?? full;
  if (name === "plain") return { size: null, lifo: false, serial: false };
  if (name === "serial") return { size: 1, lifo: false, serial: true };
  const match = /^(w|lifo)([1-4])$/.exec(name);
  if (!match) throw new Error(`unknown variant ${name}`);
  return { size: Number(match[2]), lifo: match[1] === "lifo", serial: false };
}

/** The reference packages, each with its frozen tree, copied into one lock directory. */
async function referencePackages(): Promise<Array<{ name: string; version: string }>> {
  const lockDir = await mkdtemp(join(tmpdir(), "depfit-parallel-locks-"));
  const seen = new Map<string, { name: string; version: string }>();
  const add = async (name: string, version: string, lock: string) => {
    await copyFile(lock, join(lockDir, lockName(name, version)));
    seen.set(`${name}@${version}`, { name, version });
  };
  for (const file of ["single-reference.json", "subpath-reference.json"]) {
    for (const ref of asArray(asRecord(await readJson(join(HERE, file))).packages).map(asRecord)) {
      const name = asString(ref.package) ?? "";
      const version = asString(ref.version) ?? "";
      await add(name, version, join(HERE, "locks/wild", `${asString(ref.id) ?? ""}.json`));
    }
  }
  for (const c of asArray(await readJson(join(HERE, "cases.json"))).map(asRecord)) {
    const imports = asArray(c.imports).map(asRecord);
    const root = imports.every((i) => i.from === c.package);
    if (c.expect !== "null" || (c.step ?? "1") !== "1" || c.target !== "browser" || !root) continue;
    const name = asString(c.package) ?? "";
    const version = asString(c.version) ?? "";
    await add(name, version, join(HERE, "locks", `${asString(c.id) ?? ""}.json`));
  }
  for (const spec of values.extra) {
    const at = spec.lastIndexOf("@");
    const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
    if (!values["extra-locks"]) throw new Error("--extra needs --extra-locks");
    await add(name, version, join(values["extra-locks"], lockName(name, version)));
  }
  process.env.DEPFIT_LOCK_DIR = lockDir;
  // The trees were frozen with `npm ci --legacy-peer-deps` (reference.ts); no bundle includes peers.
  process.env.npm_config_legacy_peer_deps = "true";
  return [...seen.values()];
}

async function manifestIn(dir: string, name: string): Promise<Record<string, unknown>> {
  return asRecord(await readJson(join(dir, "node_modules", name, "package.json")));
}

async function same(): Promise<void> {
  if (!values.out) throw new Error("same needs --out");
  const names = values.variants.split(",");
  const out: Record<string, Record<string, unknown>> = Object.fromEntries(
    names.map((name) => [name, {}]),
  );
  for (const { name, version } of await referencePackages()) {
    const key = `${name}@${version}`;
    await install.withIsolatedInstall(name, version, async ({ dir }) => {
      const manifest = await manifestIn(dir, name);
      const externals = bundle.externalPackages(manifest);
      for (const variantName of names) {
        const { size, lifo, serial } = variant(variantName);
        const fresh = () =>
          size === null || !poolModule ? undefined : poolModule.createVitePool({ size, lifo });
        const pool = fresh();
        const measurement = await rootEntry
          .measureRootEntry(dir, name, externals, { subpaths: true, pool, serial })
          .then(normalized, (error: unknown) => ({ error: String(error) }));
        await pool?.close();
        const reportPool = fresh();
        const report = await rootEntry.rootEntryBundle(dir, name, manifest, {
          pool: reportPool,
          serial,
        });
        await reportPool?.close();
        const target = out[variantName];
        if (target) target[key] = { measurement, report: JSON.stringify(report) };
      }
    });
    console.log(`${key}: ${names.join(", ")}`);
  }
  await writeFile(values.out, `${JSON.stringify(out)}\n`);
}

async function compare(): Promise<void> {
  const [todayFile, oursFile] = rest;
  if (!todayFile || !oursFile) throw new Error("compare needs two files");
  const today = asRecord(asRecord(await readJson(todayFile)).plain);
  const ours = asRecord(await readJson(oursFile));
  let differences = 0;
  for (const [variantName, packages] of Object.entries(ours)) {
    const got = asRecord(packages);
    const keys = new Set([...Object.keys(today), ...Object.keys(got)]);
    let equal = 0;
    for (const key of keys) {
      if (JSON.stringify(today[key]) === JSON.stringify(got[key])) equal += 1;
      else {
        differences += 1;
        console.log(`DIFF ${variantName} ${key}`);
      }
    }
    console.log(`${variantName}: ${equal}/${keys.size} packages identical`);
  }
  process.exitCode = differences ? 1 : 0;
}

/** Peak memory of this process and its descendants, per process and summed (MiB). */
function sampler() {
  const perPid = new Map<number, number>();
  let sum = 0;
  let stop = false;
  const done = (async () => {
    while (!stop) {
      const out = await run("ps", ["-A", "-o", "pid=,ppid=,rss="]).catch(() => null);
      if (out) {
        const rows = out.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));
        const children = new Map<number, number[]>();
        for (const [pid = 0, ppid = 0] of rows) {
          children.set(ppid, [...(children.get(ppid) ?? []), pid]);
        }
        const owned = new Set<number>([process.pid]);
        const walk = (pid: number) => {
          for (const child of children.get(pid) ?? []) {
            if (owned.has(child)) continue;
            owned.add(child);
            walk(child);
          }
        };
        walk(process.pid);
        let total = 0;
        for (const [pid = 0, , rss = 0] of rows) {
          if (!owned.has(pid)) continue;
          total += rss;
          perPid.set(pid, Math.max(perPid.get(pid) ?? 0, rss));
        }
        sum = Math.max(sum, total);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  })();
  return async () => {
    stop = true;
    await done;
    return {
      sumMiB: Math.round(sum / 1024),
      largestMiB: Math.round(Math.max(0, ...perPid.values()) / 1024),
    };
  };
}

/** The bundle step for candidates installed in `dirs`, as collect/index.ts runs it. */
async function bundleStep(dirs: Array<{ name: string; dir: string }>): Promise<void> {
  const manifests = await Promise.all(dirs.map(({ dir, name }) => manifestIn(dir, name)));
  const size = values.workers
    ? Number(values.workers)
    : (poolModule?.bundleWorkers(dirs.length) ?? null);
  const pool = poolModule && size !== null ? poolModule.createVitePool({ size }) : undefined;
  const peak = sampler();
  const started = performance.now();
  const reports = await Promise.all(
    dirs.map(({ dir, name }, at) =>
      rootEntry.rootEntryBundle(dir, name, manifests[at] ?? {}, { pool }),
    ),
  );
  await pool?.close();
  const wallMs = Math.round(performance.now() - started);
  const memory = await peak();
  const sha = createHash("sha256").update(JSON.stringify(reports)).digest("hex").slice(0, 16);
  const line = {
    wallMs,
    ...memory,
    started: pool?.stats.started ?? null,
    peakLive: pool?.stats.peakLive ?? null,
    workers: size,
    reports: sha,
  };
  console.log(JSON.stringify(line));
}

async function step(): Promise<void> {
  if (!values.installs) throw new Error("step needs --installs");
  const installs = values.installs;
  await bundleStep(rest.map((name) => ({ name, dir: join(installs, name.replace("/", "__")) })));
}

/** The probe reports of a run of eval/run.ts, as `project/base` (as subpath-score.ts finds them). */
async function probeFiles(control: string): Promise<string[]> {
  const found: string[] = [];
  for (const project of await readdir(control, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name === "locks") continue;
    for (const file of await readdir(join(control, project.name))) {
      if (/^\d+-.*\.json$/.test(file) && !/\.(snippets|nobundle)\.json$/.test(file)) {
        found.push(`${project.name}/${file.slice(0, -".json".length)}`);
      }
    }
  }
  return found.sort();
}

async function probeCandidates(control: string, probe: string) {
  const report = asRecord(await readJson(join(control, `${probe}.json`)));
  const browser = asArray(asRecord(report.project).browser_signals).length > 0;
  const candidates = asArray(report.packages)
    .map(asRecord)
    .flatMap((pkg) => {
      const name = asString(pkg.name);
      const version = asString(pkg.version);
      return pkg.kind === "npm" && name && version ? [{ name, version }] : [];
    });
  return { browser, candidates };
}

async function probeList(): Promise<void> {
  const control = values.control;
  if (!control) throw new Error("probe-list needs --control");
  for (const probe of await probeFiles(control)) {
    const { browser, candidates } = await probeCandidates(control, probe);
    if (browser && candidates.length) console.log(probe);
  }
}

async function probeCall(): Promise<void> {
  const { control, locks, probe } = values;
  if (!control || !locks || !probe) throw new Error("probe-call needs --control, --locks, --probe");
  process.env.DEPFIT_LOCK_DIR = locks;
  const { candidates } = await probeCandidates(control, probe);
  const installed: Array<{ name: string; dir: string }> = [];
  const nest = async (at: number): Promise<void> => {
    const next = candidates[at];
    if (!next) return bundleStep(installed);
    await install.withIsolatedInstall(next.name, next.version, async ({ dir }) => {
      installed.push({ name: next.name, dir });
      await nest(at + 1);
    });
  };
  await nest(0);
}

if (command === "same") await same();
else if (command === "compare") await compare();
else if (command === "step") await step();
else if (command === "probe-list") await probeList();
else if (command === "probe-call") await probeCall();
else {
  console.error("usage: see the comment at the top of eval/bundle/parallel-score.ts");
  process.exitCode = 2;
}

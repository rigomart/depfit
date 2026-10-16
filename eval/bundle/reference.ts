/**
 * Builds the reference sizes in eval/bundle/reference.json: every case's imports through rollup 4
 * (+ terser) and webpack 5, which share no resolver, CJS transform, tree-shaker or minifier with
 * rolldown/oxc, with the same production semantics (`process.env.NODE_ENV`, `import.meta.env`).
 * Mandatory browser measure cases also get gate C's conformance build, a stock `vite build` with
 * depfit's documented configuration (the `vite` key; not part of the rollup/webpack band, because
 * depfit is Vite).
 *   bun eval/bundle/reference.ts [caseId...]
 * Re-runs itself under Node when started with Bun, so gzip (node:zlib) is the same either way.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  asArray,
  asRecord,
  asString,
  asStringArray,
  errorMessage,
} from "../../src/collect/util.ts";
import {
  type Case,
  type ImportStatement,
  loadCases,
  loadWild,
  snippetParts,
  type Target,
} from "./cases.ts";
import { auditBuild, type Hit, type ParseModule } from "./wild-audit.ts";

if (process.versions.bun) {
  // Whole-package namespaces (the wild corpus) can be large; give Node room.
  const rerun = spawnSync(
    "node",
    ["--max-old-space-size=8192", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(rerun.status ?? 1);
}

// Vite reads the process environment: build as a clean production shell would (SETTINGS.md).
process.env.NODE_ENV = "production";
for (const key of Object.keys(process.env)) if (key.startsWith("VITE_")) delete process.env[key];

const run = promisify(execFile);
const WILD = process.argv.includes("--wild");
const REFERENCE_FILE = join(import.meta.dirname, WILD ? "wild-reference.json" : "reference.json");
const LOCKS_DIR = join(import.meta.dirname, "locks", ...(WILD ? ["wild"] : []));
/** Wild packages are built this many at a time; npm is paced between installs. */
const WILD_CONCURRENCY = 3;
const BUILD_TIMEOUT_MS = 10 * 60_000;

/** Exact pins. Bumping any of them means regenerating reference.json. */
const PINNED_TOOLS: Record<string, string> = {
  rollup: "4.64.7",
  "@rollup/plugin-commonjs": "29.0.3",
  "@rollup/plugin-json": "6.1.0",
  "@rollup/plugin-node-resolve": "16.0.3",
  "@rollup/plugin-replace": "6.0.3",
  "@rollup/plugin-terser": "1.0.0",
  terser: "5.51.2",
  webpack: "5.112.0",
  vite: "8.3.4",
};

/** Resolution conditions per target (SETTINGS.md); rollup/webpack add import/require/default. */
const CONDITIONS: Record<Target, string[]> = {
  browser: ["module", "browser", "production"],
  workerd: ["workerd", "worker", "browser", "module", "production"],
};

const NPM_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
const NODE_ENV = JSON.stringify("production");
/**
 * What Vite defines in a production client build, given to rollup and webpack too so all three
 * share production semantics: `import.meta.env` branches are dead code (zustand's devtools).
 */
const IMPORT_META_ENV = { BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: false };
const PRODUCTION_DEFINES: Record<string, string> = {
  "process.env.NODE_ENV": NODE_ENV,
  "import.meta.env": JSON.stringify(IMPORT_META_ENV),
  ...Object.fromEntries(
    Object.entries(IMPORT_META_ENV).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  ),
};
const CSS_FILE = /\.css(\?.*)?$/;
const WASM_FILE = /\.wasm(\?.*)?$/;
const ASSET_FILE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|ttf|woff2?|eot|otf|mp3|mp4|webm|ogg|wav)(\?.*)?$/;
const NON_JS_FILE = new RegExp(
  `(${[CSS_FILE, WASM_FILE, ASSET_FILE].map((re) => re.source).join("|")})`,
);

type Measured = {
  min_bytes: number;
  gzip_bytes: number;
  lazy_min_bytes: number;
  lazy_gzip_bytes: number;
  css_bytes_unminified: number;
  asset_bytes_not_inlined: number;
  wasm_bytes: number;
};
type Outcome = Measured | { error: string };
type Chunk = { code: string; eager: boolean };
/** A non-JS file the bundle references, by absolute path or emitted name (query stripped). */
type SideFile = { name: string; bytes: number };

// --- tools ---------------------------------------------------------------------------------------

async function installTools(): Promise<{ dir: string; versions: Record<string, string> }> {
  const dir = join(tmpdir(), "depfit-eval-bundle-tools");
  // Vite's rolldown is pinned like depfit's own (package.json `overrides`), so gate C compares the
  // same engine.
  const depfitManifest = asRecord(
    JSON.parse(await readFile(join(import.meta.dirname, "../../package.json"), "utf8")),
  );
  const overrides = asRecord(depfitManifest.overrides);
  const manifest = JSON.stringify({
    name: "tools",
    private: true,
    dependencies: PINNED_TOOLS,
    overrides,
  });
  const current = await readFile(join(dir, "package.json"), "utf8").catch(() => "");
  const ready = await stat(join(dir, "node_modules", "webpack")).then(
    () => true,
    () => false,
  );
  if (current !== manifest || !ready) {
    console.log("installing reference bundlers...");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), manifest);
    await run("npm", ["install", ...NPM_FLAGS, "--save-exact"], { cwd: dir, timeout: 300_000 });
  }
  const versions: Record<string, string> = { node: process.versions.node };
  // minimizer-webpack-plugin and rolldown come in transitively (webpack's, Vite's).
  for (const name of [...Object.keys(PINNED_TOOLS), "minimizer-webpack-plugin", "rolldown"]) {
    const manifestPath = join(dir, "node_modules", name, "package.json");
    versions[name] =
      asString(asRecord(JSON.parse(await readFile(manifestPath, "utf8"))).version) ?? "?";
  }
  const acornManifest = webpackRequire(dir).resolve("acorn/package.json");
  versions.acorn =
    asString(asRecord(JSON.parse(await readFile(acornManifest, "utf8"))).version) ?? "?";
  return { dir, versions };
}

/** Resolves modules the way webpack does: from its own install, which holds its acorn. */
function webpackRequire(toolsDir: string) {
  return createRequire(createRequire(join(toolsDir, "package.json")).resolve("webpack"));
}

/**
 * The wild auditor's parser: webpack's acorn, so its `fetch` checks share no parser with depfit
 * (oxc). Parses a chunk as a module, as both bundlers emit them.
 */
async function auditParser(toolsDir: string): Promise<ParseModule> {
  const acorn = asRecord(
    await import(pathToFileURL(webpackRequire(toolsDir).resolve("acorn")).href),
  );
  const parse = acorn.parse ?? asRecord(acorn.default).parse;
  if (typeof parse !== "function") throw new Error("acorn: no parse export");
  return (code) => parse(code, { ecmaVersion: "latest", sourceType: "module" });
}

type Fn = (...args: unknown[]) => unknown;

/** The function a tool exports (`rollup` by name, plugins and webpack as default, CJS or ESM). */
async function loadFunction(toolsDir: string, name: string, exportName = "default"): Promise<Fn> {
  const file = createRequire(join(toolsDir, "package.json")).resolve(name);
  const mod = asRecord(await import(pathToFileURL(file).href));
  const found = mod[exportName] ?? asRecord(mod.default)[exportName];
  if (typeof found !== "function") throw new Error(`${name}: no function export ${exportName}`);
  return (...args) => found(...args);
}

// --- case projects -------------------------------------------------------------------------------

/**
 * The case's snippet plus an array that keeps every binding and member alive. A snippet that keeps
 * nothing (side-effect-only imports) gets no array, so the reference measures exactly what the
 * CLI measures: the imports as written.
 */
function entrySource(imports: ImportStatement[]): string {
  const { declarations, members, wholeBindings } = snippetParts(imports);
  const kept = [...wholeBindings, ...members];
  const keepAlive = kept.length ? `globalThis.__depfit = [${kept.join(", ")}];\n` : "";
  return `${declarations.join("\n")}\n${keepAlive}`;
}

/** Peer dependencies (optional ones too) declared by the installed candidate. */
async function peersOf(dir: string, pkg: string): Promise<string[]> {
  const manifest = asRecord(
    JSON.parse(await readFile(join(dir, "node_modules", pkg, "package.json"), "utf8")),
  );
  return [
    ...new Set([
      ...Object.keys(asRecord(manifest.peerDependencies)),
      ...Object.keys(asRecord(manifest.peerDependenciesMeta)),
    ]),
  ].sort();
}

function peerPattern(peers: string[]): RegExp | null {
  if (!peers.length) return null;
  const names = peers.map((peer) => peer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(`^(${names.join("|")})(/.*)?$`);
}

const lockFile = (id: string) => join(LOCKS_DIR, `${id}.json`);

/**
 * Installs name@version alone, without peers, so a missing external cannot be bundled by accident.
 * The resolved tree is frozen in locks/<id>.json (committed); later runs `npm ci` from it, so the
 * references do not drift when dependencies publish. Delete a lock to re-resolve it.
 */
async function installCandidate(group: Case[]): Promise<string> {
  const first = group[0];
  if (!first) throw new Error("empty group");
  // A fixed path per candidate: bundlers hash module paths, so a random dir adds jitter.
  const dir = join(
    tmpdir(),
    "depfit-ref",
    `${first.package}@${first.version}`.replaceAll("/", "_"),
  );
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const frozen = await readFile(lockFile(first.id), "utf8").catch(() => null);
  const dependencies = { [first.package]: first.version };
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "ref", private: true, dependencies }),
  );
  const options = { cwd: dir, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };
  if (frozen) {
    await writeFile(join(dir, "package-lock.json"), frozen);
    await run("npm", ["ci", "--legacy-peer-deps", ...NPM_FLAGS], options);
  } else {
    await run("npm", ["install", "--legacy-peer-deps", ...NPM_FLAGS], options);
    await mkdir(LOCKS_DIR, { recursive: true });
  }
  const lock = await readFile(join(dir, "package-lock.json"), "utf8");
  for (const c of group) await writeFile(lockFile(c.id), lock);
  return dir;
}

/** name@version of every package entry in an npm lockfile. */
function lockEntries(lockText: string): Set<string> {
  const packages = asRecord(asRecord(JSON.parse(lockText)).packages);
  const found = new Set<string>();
  for (const [path, value] of Object.entries(packages)) {
    const version = asString(asRecord(value).version);
    if (!path.includes("node_modules/") || !version) continue;
    found.add(`${path.slice(path.lastIndexOf("node_modules/") + 13)}@${version}`);
  }
  return found;
}

/**
 * Packages depfit installs only because it also installs the candidate's peers (the frozen lock
 * has none, and the bundles leave peers external): what npm adds to the frozen lock when peer
 * dependencies are honored. `score.ts` does not count them as drift.
 */
async function peerOnlyPackages(dir: string): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "depfit-ref-peers-"));
  try {
    const lock = await readFile(join(dir, "package-lock.json"), "utf8");
    await writeFile(join(scratch, "package.json"), await readFile(join(dir, "package.json")));
    await writeFile(join(scratch, "package-lock.json"), lock);
    await run("npm", ["install", "--package-lock-only", ...NPM_FLAGS], {
      cwd: scratch,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const before = lockEntries(lock);
    const after = lockEntries(await readFile(join(scratch, "package-lock.json"), "utf8"));
    return [...after].filter((entry) => !before.has(entry)).sort();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// --- measuring -----------------------------------------------------------------------------------

const bytesOf = (code: string) => Buffer.byteLength(code);
const gzipBytes = (code: string) => gzipSync(code, { level: 9 }).byteLength;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function measure(chunks: Chunk[], files: SideFile[]): Measured {
  const eager = chunks.filter((chunk) => chunk.eager).map((chunk) => chunk.code);
  const lazy = chunks.filter((chunk) => !chunk.eager).map((chunk) => chunk.code);
  const unique = [...new Map(files.map((file) => [file.name, file])).values()];
  const bytesWhere = (re: RegExp) =>
    sum(unique.filter((file) => re.test(file.name)).map((file) => file.bytes));
  const css = bytesWhere(CSS_FILE);
  const wasm = bytesWhere(WASM_FILE);
  return {
    min_bytes: sum(eager.map(bytesOf)),
    gzip_bytes: sum(eager.map(gzipBytes)),
    lazy_min_bytes: sum(lazy.map(bytesOf)),
    lazy_gzip_bytes: sum(lazy.map(gzipBytes)),
    css_bytes_unminified: css,
    asset_bytes_not_inlined: bytesWhere(ASSET_FILE),
    wasm_bytes: wasm,
  };
}

type BuildInput = {
  toolsDir: string;
  dir: string;
  entry: string;
  target: Target;
  external: RegExp | null;
  /** Node built-ins and cloudflare:* the runtime provides; filled in while building. */
  builtins: Set<string>;
  /** Receives the emitted JS chunks (name and code) of a successful build, for the wild auditor. */
  onChunks?: (chunks: { name: string; code: string }[]) => void;
  /** Receives the context modules of a webpack build (see `contextModules`). */
  onContextModules?: (names: string[]) => void;
};

/** workerd provides Node built-ins (nodejs_compat) and cloudflare:*; the browser provides none. */
function isRuntimeModule(id: string, target: Target): boolean {
  return target === "workerd" && (isBuiltin(id) || id.startsWith("cloudflare:"));
}

async function buildRollup(input: BuildInput): Promise<Measured> {
  const { toolsDir, dir, entry, target, external, builtins } = input;
  const rollup = await loadFunction(toolsDir, "rollup", "rollup");
  const nodeResolve = await loadFunction(toolsDir, "@rollup/plugin-node-resolve");
  const commonjs = await loadFunction(toolsDir, "@rollup/plugin-commonjs");
  const replace = await loadFunction(toolsDir, "@rollup/plugin-replace");
  const json = await loadFunction(toolsDir, "@rollup/plugin-json");
  const terser = await loadFunction(toolsDir, "@rollup/plugin-terser");

  const files: SideFile[] = [];
  const unresolved: string[] = [];
  // CSS, fonts, images and wasm are counted as files, never as JS.
  const sideFiles = {
    name: "depfit-side-files",
    async load(id: string) {
      if (!NON_JS_FILE.test(id)) return null;
      const path = id.replace(/\?.*$/, "");
      files.push({ name: id, bytes: (await stat(path)).size });
      return `export default ${JSON.stringify(basename(path))};`;
    },
  };
  const build = asRecord(
    await rollup({
      input: entry,
      preserveEntrySignatures: false,
      external: (id: string) => {
        if (external?.test(id)) return true;
        if (!isRuntimeModule(id, target)) return false;
        builtins.add(id);
        return true;
      },
      onwarn: (warning: unknown) => {
        const { code, exporter } = asRecord(warning);
        if (code === "UNRESOLVED_IMPORT") unresolved.push(String(exporter));
      },
      plugins: [
        replace({ preventAssignment: true, values: PRODUCTION_DEFINES }),
        nodeResolve({
          rootDir: dir,
          browser: true,
          exportConditions: CONDITIONS[target],
          preferBuiltins: false,
        }),
        sideFiles,
        commonjs(),
        json(),
      ],
    }),
  );
  try {
    if (unresolved.length)
      throw new Error(`UNRESOLVED_IMPORT ${[...new Set(unresolved)].sort().join(", ")}`);
    const generate = build.generate;
    if (typeof generate !== "function") throw new Error("rollup build has no generate()");
    const { output } = asRecord(
      await generate.call(build, {
        format: "es",
        plugins: [terser({ format: { comments: false } })],
      }),
    );
    const chunks = asArray(output)
      .map(asRecord)
      .filter((item) => item.type === "chunk");
    const byName = new Map(chunks.map((chunk) => [asString(chunk.fileName), chunk]));
    const eager = new Set<string>();
    const visit = (name: string) => {
      if (eager.has(name)) return;
      eager.add(name);
      for (const next of asStringArray(byName.get(name)?.imports)) visit(next);
    };
    for (const chunk of chunks) if (chunk.isEntry === true) visit(String(chunk.fileName));
    input.onChunks?.(
      chunks.map((chunk) => ({ name: String(chunk.fileName), code: asString(chunk.code) ?? "" })),
    );
    return measure(
      chunks.map((chunk) => ({
        code: asString(chunk.code) ?? "",
        eager: eager.has(String(chunk.fileName)),
      })),
      files,
    );
  } finally {
    const close = build.close;
    if (typeof close === "function") await close.call(build);
  }
}

/**
 * Context modules of a webpack compilation, by module identity (the class webpack gives a
 * `require(expression)`), not by size. webpack turns a computed require into a context module that
 * bundles every file the expression could match; Rollup-family bundlers (and so Vite and depfit)
 * leave the call. The two outputs then differ by design, not by error.
 */
function contextModules(compilation: Record<string, unknown>): string[] {
  const modules = compilation.modules;
  if (!(modules instanceof Set)) return [];
  return [...modules]
    .filter((item) => asRecord(item).constructor?.name === "ContextModule")
    .map((item) => {
      const identifier = asRecord(item).identifier;
      return typeof identifier === "function" ? String(identifier.call(item)) : "?";
    })
    .map((name) => name.replace(/[^\s'"]*depfit-ref\/[^/\s'"]+/g, "<install>"))
    .sort();
}

async function buildWebpack(input: BuildInput): Promise<Measured> {
  const { toolsDir, dir, entry, target, external, builtins } = input;
  const webpack = await loadFunction(toolsDir, "webpack");
  // webpack's module is a function with its plugins as properties.
  const webpackModule: unknown = createRequire(join(toolsDir, "package.json"))("webpack");
  const DefinePlugin: unknown =
    typeof webpackModule === "function" ? Reflect.get(webpackModule, "DefinePlugin") : undefined;
  if (typeof DefinePlugin !== "function") throw new Error("webpack: no DefinePlugin");
  const out = await mkdtemp(join(tmpdir(), "depfit-ref-out-"));
  try {
    const config = {
      mode: "production",
      entry,
      target: "web",
      devtool: false,
      context: dir,
      output: { path: out, filename: "[name].js", module: true, chunkFormat: "module" },
      experiments: { outputModule: true },
      externalsType: "module",
      externals: [
        ({ request }: { request?: string }, callback: (error?: Error, result?: string) => void) => {
          if (request && external?.test(request)) return callback(undefined, `module ${request}`);
          if (request && isRuntimeModule(request, target)) {
            builtins.add(request);
            return callback(undefined, `module ${request}`);
          }
          callback();
        },
      ],
      resolve: target === "workerd" ? { conditionNames: ["workerd", "worker", "..."] } : {},
      performance: { hints: false },
      module: {
        rules: [
          { test: /\.m?js$/, resolve: { fullySpecified: false } },
          { test: NON_JS_FILE, type: "asset/resource" },
        ],
      },
      // webpack's production mode defines process.env.NODE_ENV itself.
      plugins: [
        Reflect.construct(DefinePlugin, [
          Object.fromEntries(
            Object.entries(PRODUCTION_DEFINES).filter(([key]) => key !== "process.env.NODE_ENV"),
          ),
        ]),
      ],
      stats: "errors-only",
    };
    const compilation = await new Promise<Record<string, unknown>>((done, fail) => {
      webpack(config, (error: unknown, stats: unknown) => {
        if (error) return fail(error);
        done(asRecord(asRecord(stats).compilation));
      });
    });
    // A require() that cannot resolve is only a warning in webpack when it sits in try/catch.
    const errors = asArray(compilation.errors).map(asRecord);
    const unresolved = asArray(compilation.warnings)
      .map(asRecord)
      .filter((item) => item.name === "ModuleNotFoundError");
    const messages = [...errors, ...unresolved]
      .map((item) => errorMessage(asString(item.message) ?? "build failed"))
      .sort();
    if (messages.length) throw new Error(messages[0]);

    input.onContextModules?.(contextModules(compilation));
    const chunks: Chunk[] = [];
    const files: SideFile[] = [];
    const named: { name: string; code: string }[] = [];
    for (const name of await readdir(out)) {
      if (name.endsWith(".js")) {
        const code = await readFile(join(out, name), "utf8");
        named.push({ name, code });
        chunks.push({ code, eager: name === "main.js" });
      } else if (NON_JS_FILE.test(name)) {
        files.push({ name, bytes: (await stat(join(out, name))).size });
      }
    }
    input.onChunks?.(named);
    return measure(chunks, files);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/**
 * Gate C's conformance build: a stock `vite build` of the snippet with the configuration
 * SETTINGS.md documents for depfit, written here without depfit's code. A JS entry, no config,
 * `.env` or public dir, nothing written, peers external through Vite's `esmExternalRequirePlugin`.
 * The process runs with `NODE_ENV=production` and no `VITE_*` variables (set at startup).
 * Output chunks are measured like the other builders'.
 */
async function buildVite(input: BuildInput): Promise<Measured> {
  const { toolsDir, dir, entry, external } = input;
  const file = createRequire(join(toolsDir, "package.json")).resolve("vite");
  const vite = asRecord(await import(pathToFileURL(file).href));
  const { build, esmExternalRequirePlugin } = vite;
  if (typeof build !== "function" || typeof esmExternalRequirePlugin !== "function") {
    throw new Error("vite: no build or esmExternalRequirePlugin export");
  }
  const result = await build({
    root: dir,
    configFile: false,
    envDir: false,
    envPrefix: [],
    mode: "production",
    publicDir: false,
    base: "/",
    cacheDir: join(dir, ".vite-cache"),
    logLevel: "silent",
    plugins: external ? [esmExternalRequirePlugin({ external: [external] })] : [],
    build: { write: false, reportCompressedSize: false, rollupOptions: { input: entry } },
  });
  // One output per environment/format; an app build yields a single one.
  const items = (Array.isArray(result) ? result : [result])
    .flatMap((item) => asArray(asRecord(item).output))
    .map(asRecord);
  const chunks = items.filter((item) => item.type === "chunk");
  const byName = new Map(chunks.map((chunk) => [asString(chunk.fileName), chunk]));
  const eager = new Set<string>();
  const visit = (name: string) => {
    if (eager.has(name)) return;
    eager.add(name);
    for (const next of asStringArray(byName.get(name)?.imports)) visit(next);
  };
  for (const chunk of chunks) if (chunk.isEntry === true) visit(String(chunk.fileName));
  const files = items.flatMap((item) => {
    const name = asString(item.fileName);
    const source = item.source;
    if (item.type !== "asset" || !name || !NON_JS_FILE.test(name)) return [];
    const bytes = typeof source === "string" ? bytesOf(source) : sizeOf(source);
    return [{ name, bytes }];
  });
  return measure(
    chunks.map((chunk) => ({
      code: asString(chunk.code) ?? "",
      eager: eager.has(String(chunk.fileName)),
    })),
    files,
  );
}

function sizeOf(value: unknown): number {
  return value instanceof Uint8Array ? value.byteLength : 0;
}

async function attempt(build: () => Promise<Measured>): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, fail) => {
      timer = setTimeout(
        () => fail(new Error(`build timed out after ${BUILD_TIMEOUT_MS / 60_000} min`)),
        BUILD_TIMEOUT_MS,
      );
    });
    return await Promise.race([build(), timeout]);
  } catch (error) {
    // Strip the machine-specific install path from messages.
    const message = errorMessage(error).replace(/[^\s'"]*depfit-ref\/[^/\s'"]+/g, "<install>");
    return { error: message.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// --- main ----------------------------------------------------------------------------------------

const only = process.argv.slice(2).filter((arg) => arg !== "--wild");
const universe = WILD ? await loadWild() : await loadCases();
const unknown = only.filter((id) => !universe.some((c) => c.id === id));
if (unknown.length) throw new Error(`unknown case id: ${unknown.join(", ")}`);
const cases = only.length ? universe.filter((c) => only.includes(c.id)) : universe;
const tools = await installTools();
const results: Record<string, unknown> = {};
const parseChunk = WILD ? await auditParser(tools.dir) : undefined;

const groups = new Map<string, Case[]>();
for (const c of cases) {
  const spec = `${c.package}@${c.version}`;
  groups.set(spec, [...(groups.get(spec) ?? []), c]);
}

function caseHeader(c: Case, peers: string[]) {
  return { expect: c.expect, target: c.target, external_packages: peers };
}

function show(outcome: Outcome): string {
  return "error" in outcome ? `ERROR ${outcome.error}` : `gzip ${outcome.gzip_bytes}`;
}

async function referenceGroup(spec: string, group: Case[]): Promise<void> {
  const started = performance.now();
  const first = group[0];
  if (!first) return;
  let dir: string | null = null;
  try {
    dir = await installCandidate(group);
  } catch (error) {
    for (const c of group) {
      results[c.id] = {
        ...caseHeader(c, []),
        rollup: { error: `install: ${errorMessage(error)}`.slice(0, 300) },
        webpack: { error: `install: ${errorMessage(error)}`.slice(0, 300) },
      };
      console.log(`${c.id}: install failed`);
    }
    return;
  }
  try {
    const peers = await peersOf(dir, first.package).catch(() => []);
    const peerOnly = WILD ? [] : await peerOnlyPackages(dir);
    for (const c of group) {
      // .mjs like depfit's entry: ESM semantics as in a `"type": "module"` app.
      const entry = join(dir, "__depfit_entry.mjs");
      await writeFile(entry, entrySource(c.imports));
      const base = {
        toolsDir: tools.dir,
        dir,
        entry,
        target: c.target,
        external: peerPattern(peers),
      };
      const rollupBuiltins = new Set<string>();
      let rollupChunks: { name: string; code: string }[] | null = null;
      let webpackChunks: { name: string; code: string }[] | null = null;
      let webpackContexts: string[] = [];
      const rollup = await attempt(() =>
        buildRollup({
          ...base,
          builtins: rollupBuiltins,
          onChunks: (chunks) => {
            rollupChunks = chunks;
          },
        }),
      );
      const webpack = await attempt(() =>
        buildWebpack({
          ...base,
          builtins: new Set(),
          onChunks: (chunks) => {
            webpackChunks = chunks;
          },
          onContextModules: (names) => {
            webpackContexts = names;
          },
        }),
      );
      // Gate C's conformance build: mandatory browser measure cases of step 1.
      const anchored =
        !WILD && c.mandatory && c.expect === "measure" && c.target === "browser" && c.step === "1";
      const vite = anchored
        ? await attempt(() => buildVite({ ...base, builtins: new Set() }))
        : null;
      // Gate W: what the independent auditor finds in the outputs that built (null: no output).
      const audit: Record<string, Hit[] | null> = {
        rollup: rollupChunks ? auditBuild(rollupChunks, peers, parseChunk) : null,
        webpack: webpackChunks ? auditBuild(webpackChunks, peers, parseChunk) : null,
      };
      results[c.id] = {
        ...caseHeader(c, peers),
        ...(WILD ? { package: c.package, version: c.version } : { peer_only_packages: peerOnly }),
        node_builtins_external: [...rollupBuiltins].sort(),
        ...(webpackContexts.length
          ? {
              webpack_context_modules: webpackContexts,
              band_excluded: {
                webpack:
                  "webpack built context modules (a computed require bundled with every file it could match); the other bundlers leave the call, so webpack is not a reference for this case (SPEC settled questions)",
              },
            }
          : {}),
        rollup,
        webpack,
        ...(vite ? { vite } : {}),
        ...(WILD ? { audit } : {}),
      };
      const viteNote = vite ? ` | vite ${show(vite)}` : "";
      console.log(`${c.id}: rollup ${show(rollup)} | webpack ${show(webpack)}${viteNote}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`  (${spec} ${Math.round(performance.now() - started)}ms)`);
}

/** Wild packages run a few at a time, started a second apart so npm is not hit in a burst. */
const queue = [...groups];
const workers = Array.from({ length: WILD ? WILD_CONCURRENCY : 1 }, async (_, index) => {
  await new Promise((done) => setTimeout(done, index * 1000));
  for (let next = queue.shift(); next; next = queue.shift()) {
    await referenceGroup(next[0], next[1]);
    if (WILD) await new Promise((done) => setTimeout(done, 1000));
  }
});
await Promise.all(workers);

const previous = only.length
  ? asRecord(asRecord(JSON.parse(await readFile(REFERENCE_FILE, "utf8").catch(() => "{}"))).cases)
  : {};
const merged = Object.fromEntries(
  universe.flatMap((c) => {
    const entry = results[c.id] ?? previous[c.id];
    return entry ? [[c.id, entry]] : [];
  }),
);
await writeFile(
  REFERENCE_FILE,
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      tools: tools.versions,
      cases: merged,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${resolve(REFERENCE_FILE)} (${dirname(REFERENCE_FILE)})`);

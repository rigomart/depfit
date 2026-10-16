/**
 * Bundle size of a `--bundle-entry` snippet: a real `vite build` (Vite's production defaults) of
 * the snippet, run in its own Node process on the candidate's isolated install (`vite-build.mjs`).
 * Settings: eval/bundle/SETTINGS.md; contract: eval/bundle/SPEC.md. Nothing of Vite or rolldown is
 * loaded unless bundling is requested.
 *
 * Unmeasurable builds give null bytes and `bundle: <CODE> [names]` reasons, never a smaller
 * number. Vite turns several broken inputs into a quiet success (a Node built-in becomes an empty
 * stub, a missing optional peer a throw, a missing namespace member `undefined`, an asset a URL),
 * so each is checked from its own structural signal (`problemsFromBuild`). The bytes are what Vite
 * emits; they make no claim that the code runs in a browser.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { ESTree } from "rolldown/utils";
import { type BundleEntry, entryModuleSource, isCandidateSource } from "./bundle-entry.ts";
import { isRecord } from "./util.ts";

const ENTRY_FILE = "__depfit_entry.mjs";
const RUNNER = fileURLToPath(new URL("./vite-build.mjs", import.meta.url));
const BUILD_TIMEOUT_MS = 5 * 60_000;

/**
 * One reason a bundle is unmeasurable. `code` is UNRESOLVED_IMPORT, MISSING_EXPORT,
 * IMPORT_OUTSIDE_BUNDLE, NO_ENTRY, NON_JS_IMPORT or TOOLCHAIN_MISMATCH (SPEC.md), or Vite's own
 * code for any other build error (e.g. PARSE_ERROR).
 */
export type BundleProblem = { code: string; specifier: string | null };

export type BundleBytes = {
  eager_js_min_bytes: number;
  eager_js_gzip9_bytes: number;
  lazy_js_min_bytes: number;
  lazy_js_gzip9_bytes: number;
};

export type BundleOutcome =
  | { bytes: BundleBytes; problems: [] }
  | { bytes: null; problems: BundleProblem[] };

// --- what vite-build.mjs reads and prints -----------------------------------------------------

export type ViteBuildRequest = { root: string; entry: string; peers: string[] };

export type ViteResolution = {
  source: string;
  /** Relative to the root; null for the entry itself. */
  importer: string | null;
  /** Relative to the root, or Vite's id (`\0...`, `__vite-browser-external...`); null if unresolved. */
  id: string | null;
  external: boolean;
  /** Resolved to Vite's empty stub because the importing package maps it to false (`browser`). */
  browserFalse: boolean;
};

export type ViteLog = {
  level: string;
  code: string | null;
  /** The plugin that raised an error (`PLUGIN_ERROR`), e.g. `builtin:vite-json`. */
  plugin: string | null;
  exporter: string | null;
  id: string | null;
};

export type ViteChunk = {
  fileName: string;
  isEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
  code: string;
};

export type ViteBuildResult = {
  vite: string;
  rolldown: string;
  resolutions: ViteResolution[];
  logs: ViteLog[];
  chunks: ViteChunk[];
  assets: string[];
  /** Entry modules of worker sub-builds (a worker, inline or not, is not measured in step 1). */
  workers: string[];
  /** The build failed: Vite's (or rolldown's) errors, with their codes. */
  errors: ViteLog[] | null;
};

/**
 * Peer dependencies (optional ones too) as an external pattern: the name and its subpaths.
 * Types-only `@types/*` peers are left out, because they never ship.
 */
export function externalPackages(manifest: Record<string, unknown>): string[] {
  const keys = (value: unknown) => (isRecord(value) ? Object.keys(value) : []);
  const names = [...keys(manifest.peerDependencies), ...keys(manifest.peerDependenciesMeta)];
  return [...new Set(names)].filter((name) => !name.startsWith("@types/")).sort();
}

// --- chunk accounting ----------------------------------------------------------------------------

export type ChunkInfo = {
  fileName: string;
  isEntry: boolean;
  /** Static imports: chunk file names, or external specifiers (ignored). */
  imports: string[];
  dynamicImports: string[];
  code: string;
};

/**
 * Eager is the entry chunk plus the closure of its static imports. Lazy is every chunk reachable
 * from there through dynamic imports (and their own static imports) that is not eager. Each
 * chunk appears once.
 */
export function splitChunks<T extends ChunkInfo>(chunks: T[]): { eager: T[]; lazy: T[] } {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const closure = (start: T[], follow: (chunk: T) => string[], skip = new Set<string>()) => {
    const seen = new Set<string>();
    const queue = [...start];
    for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
      if (seen.has(chunk.fileName) || skip.has(chunk.fileName)) continue;
      seen.add(chunk.fileName);
      for (const name of follow(chunk)) {
        const next = byName.get(name);
        if (next) queue.push(next);
      }
    }
    return seen;
  };
  const eager = closure(
    chunks.filter((chunk) => chunk.isEntry),
    (chunk) => chunk.imports,
  );
  const reachable = closure(
    chunks.filter((chunk) => chunk.isEntry),
    (chunk) => [...chunk.imports, ...chunk.dynamicImports],
  );
  return {
    eager: chunks.filter((chunk) => eager.has(chunk.fileName)),
    lazy: chunks.filter((chunk) => reachable.has(chunk.fileName) && !eager.has(chunk.fileName)),
  };
}

const minBytes = (code: string) => Buffer.byteLength(code);
const gzip9Bytes = (code: string) => gzipSync(code, { level: 9 }).byteLength;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Minified and gzip -9 bytes per chunk, summed separately for eager and lazy chunks. */
export function chunkBytes(chunks: ChunkInfo[]): BundleBytes {
  const { eager, lazy } = splitChunks(chunks);
  return {
    eager_js_min_bytes: sum(eager.map((c) => minBytes(c.code))),
    eager_js_gzip9_bytes: sum(eager.map((c) => gzip9Bytes(c.code))),
    lazy_js_min_bytes: sum(lazy.map((c) => minBytes(c.code))),
    lazy_js_gzip9_bytes: sum(lazy.map((c) => gzip9Bytes(c.code))),
  };
}

// --- reasons --------------------------------------------------------------------------------------

/** How many names one `unavailable` entry lists before it only counts the rest. */
const NAMES_PER_REASON = 3;

/**
 * The `unavailable` entries for some problems: one `bundle: <CODE> [names]` per code, sorted. The
 * names are the distinct specifiers, the first few in order and then a count of the rest.
 */
export function bundleReasons(problems: BundleProblem[]): string[] {
  const byCode = new Map<string, Set<string>>();
  for (const { code, specifier } of problems) {
    const names = byCode.get(code) ?? new Set<string>();
    if (specifier) names.add(specifier);
    byCode.set(code, names);
  }
  return [...byCode]
    .map(([code, names]) => {
      const sorted = [...names].sort();
      const shown = sorted.slice(0, NAMES_PER_REASON).join(", ");
      const rest = sorted.length - NAMES_PER_REASON;
      return [`bundle: ${code}`, shown, rest > 0 ? `(+${rest} more)` : ""]
        .filter(Boolean)
        .join(" ");
    })
    .sort();
}

// --- imports outside the bundle -------------------------------------------------------------------

type Parse = (code: string) => ESTree.Program;

/** The value of a string literal or a template literal without expressions, else null. */
function stringValue(node: unknown): string | null {
  if (!isRecord(node)) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.quasis)) return null;
  if (!Array.isArray(node.expressions) || node.expressions.length > 0) return null;
  const quasi: unknown = node.quasis[0];
  const value = isRecord(quasi) && isRecord(quasi.value) ? quasi.value.cooked : null;
  return typeof value === "string" ? value : null;
}

/**
 * Every import specifier in a parsed chunk: static imports and re-exports, and `import()`
 * anywhere. A computed `import()` gives null.
 */
export function importSpecifiers(program: ESTree.Program): Array<string | null> {
  const found: Array<string | null> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isRecord(node)) return;
    if (
      node.type === "ImportExpression" ||
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      found.push(stringValue(node.source));
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "parent" && typeof child === "object" && child !== null) visit(child);
    }
  };
  visit(program);
  return found;
}

/**
 * Imports left in the output that the bundle does not contain (SPEC.md, IMPORT_OUTSIDE_BUNDLE):
 * neither another emitted chunk nor `externals` (or their subpaths). A computed `import()` is
 * reported as `import(…)`.
 */
export function importsOutsideBundle(
  chunks: Array<Pick<ChunkInfo, "fileName" | "code">>,
  parse: Parse,
  externals: string[],
): string[] {
  const fileNames = new Set(chunks.map((chunk) => chunk.fileName));
  const outside = chunks.flatMap((chunk) =>
    importSpecifiers(parse(chunk.code))
      .filter(
        (specifier) =>
          specifier === null ||
          !(
            externals.some((name) => isCandidateSource(specifier, name)) ||
            (/^\.\.?\//.test(specifier) &&
              fileNames.has(posix.join(posix.dirname(chunk.fileName), specifier)))
          ),
      )
      .map((specifier) => specifier ?? "import(…)"),
  );
  return [...new Set(outside)];
}

// --- labels ---------------------------------------------------------------------------------------

/** "pkg/lib/file.js" for a file in node_modules, the base name otherwise. */
export function moduleLabel(id: string): string {
  const path = id.split("?")[0] ?? id;
  const at = path.lastIndexOf("node_modules/");
  if (at >= 0) return path.slice(at + "node_modules/".length);
  return path.slice(path.lastIndexOf("/") + 1);
}

// --- what the build means -------------------------------------------------------------------------

/**
 * An import that does not resolve: NO_ENTRY when it is the snippet's own import of the candidate
 * (the package has no entry point for it), else UNRESOLVED_IMPORT.
 */
export function unresolvedProblem(
  source: string,
  fromEntry: boolean,
  candidate: string,
): BundleProblem {
  const noEntry = fromEntry && isCandidateSource(source, candidate);
  return { code: noEntry ? "NO_ENTRY" : "UNRESOLVED_IMPORT", specifier: source };
}

/** A log's subject: a module path as "pkg/file.js", a bare specifier as written. */
const logSubject = (log: ViteLog): string | null => {
  const subject = log.exporter ?? log.id ?? log.plugin;
  if (subject === null) return null;
  const isPath =
    subject.startsWith("/") || subject.startsWith(".") || subject.includes("node_modules/");
  return isPath ? moduleLabel(subject) : subject;
};

const logProblem = (log: ViteLog, code: string): BundleProblem => ({
  code,
  specifier: logSubject(log),
});

/**
 * Why a `vite build` result is unmeasurable, each from its own structural signal (SPEC.md); empty
 * when the bytes can be reported. `peers` are the externals; `candidate` the snippet's package.
 */
export function problemsFromBuild(
  result: ViteBuildResult,
  peers: string[],
  candidate: string,
  parse: Parse,
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const unresolved = new Set<string>();
  for (const { source, importer, id, browserFalse } of result.resolutions) {
    if (id === null) {
      unresolved.add(source);
      problems.push(unresolvedProblem(source, importer === ENTRY_FILE, candidate));
    } else if (id.includes("__vite-browser-external") && !browserFalse) {
      // Vite's empty stub. It means a Node built-in, reached by any route (`node:fs`, an import
      // alias like `#crypto`), unless the importing package itself maps the import to false in its
      // `browser` field (`"./x.js": false`, `"crypto": false`), which is measured.
      problems.push({ code: "UNRESOLVED_IMPORT", specifier: source });
    }
  }
  for (const log of result.logs) {
    if (log.code === "UNRESOLVED_IMPORT" && !unresolved.has(log.exporter ?? "")) {
      problems.push(logProblem(log, "UNRESOLVED_IMPORT"));
    } else if (log.code === "MISSING_EXPORT" || log.code === "IMPORT_IS_UNDEFINED") {
      problems.push(logProblem(log, "MISSING_EXPORT"));
    }
  }
  // A file Vite emitted besides JS chunks (CSS, an asset too large to inline, a worker, wasm): the
  // page needs it and the JS bytes do not hold it. What Vite inlines into JS is counted, and what
  // code loads by a path at runtime is not part of the claim (SPEC.md).
  for (const asset of result.assets) problems.push({ code: "NON_JS_IMPORT", specifier: asset });
  // A worker is a separate bundle that Vite builds outside this build's plugins (and, inline,
  // embeds as text): depfit's checks and peer exclusion do not reach it. Workers are step 4.
  for (const worker of result.workers) {
    problems.push({ code: "NON_JS_IMPORT", specifier: `worker ${moduleLabel(worker)}` });
  }
  for (const chunk of result.chunks) {
    for (const id of chunk.moduleIds) {
      // `__vite-optional-peer-dep:<peer>:<importer>`: Vite replaced a missing optional peer.
      const match = /__vite-optional-peer-dep:([^:]+)/.exec(id);
      if (match) problems.push({ code: "UNRESOLVED_IMPORT", specifier: match[1] ?? id });
    }
  }
  for (const error of result.errors ?? []) {
    problems.push(logProblem(error, error.code ?? "BUILD_ERROR"));
  }
  if (problems.length) return problems;
  return importsOutsideBundle(result.chunks, parse, peers).map((specifier) => ({
    code: "IMPORT_OUTSIDE_BUNDLE",
    specifier,
  }));
}

// --- running Vite ---------------------------------------------------------------------------------

/**
 * The child's environment: `NODE_ENV=production` and nothing from the shell that Vite reads
 * (`NODE_ENV`, `VITE_*`), only what a process needs to start.
 */
function childEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "SystemRoot", "USERPROFILE"];
  const env: Record<string, string> = { NODE_ENV: "production" };
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isBuildResult(value: unknown): value is ViteBuildResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.vite === "string" &&
    Array.isArray(value.resolutions) &&
    Array.isArray(value.logs) &&
    Array.isArray(value.chunks) &&
    value.chunks.every(isChunk) &&
    isStringArray(value.assets) &&
    isStringArray(value.workers) &&
    (value.errors === null || Array.isArray(value.errors))
  );
}

function isChunk(value: unknown): value is ViteChunk {
  return (
    isRecord(value) &&
    typeof value.fileName === "string" &&
    typeof value.isEntry === "boolean" &&
    typeof value.code === "string" &&
    isStringArray(value.imports) &&
    isStringArray(value.dynamicImports) &&
    isStringArray(value.moduleIds)
  );
}

/**
 * Runs `vite-build.mjs` with Node, in `request.root`. Node, not depfit's own runtime: Vite's output
 * depends on the runtime (its preload helper is built from function source text), and Vite users run
 * Node. Node is already required for npm.
 */
function runViteBuild(request: ViteBuildRequest): Promise<ViteBuildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [RUNNER], {
      cwd: request.root,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: BUILD_TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => {
      err += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
      } catch {
        // Reported below with the child's stderr.
      }
      if (isBuildResult(parsed)) resolve(parsed);
      else reject(new Error(`vite build exited ${code}: ${err.trim().split("\n")[0] ?? ""}`));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

let parser: Promise<Parse> | null = null;

/** rolldown's parser (the one Vite uses), loaded once on first use. */
function loadParser(): Promise<Parse> {
  parser ??= import("rolldown/parseAst").then(
    ({ parseAst }) =>
      (code: string) =>
        parseAst(code, { lang: "js", sourceType: "module" }),
  );
  return parser;
}

let toolchain: Promise<{ vite: string; rolldown: string }> | null = null;

/**
 * The Vite and rolldown versions the eval measured (eval/bundle/SPEC.md): depfit's own pins,
 * `dependencies.vite` and `overrides.rolldown` in its package.json.
 */
function evaluatedToolchain(): Promise<{ vite: string; rolldown: string }> {
  toolchain ??= readFile(new URL("../../package.json", import.meta.url), "utf8").then((text) => {
    const manifest: unknown = JSON.parse(text);
    const pin = (section: string, name: string) => {
      const value = isRecord(manifest) ? manifest[section] : null;
      const version = isRecord(value) ? value[name] : null;
      return typeof version === "string" ? version : "?";
    };
    return { vite: pin("dependencies", "vite"), rolldown: pin("overrides", "rolldown") };
  });
  return toolchain;
}

/** `vite@<version> (rolldown@<version>)` of the Vite that `vite-build.mjs` imports. */
export async function bundlerName(): Promise<string> {
  const require = createRequire(RUNNER);
  const versionOf = async (manifest: string) => {
    const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
    return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : "?";
  };
  const viteManifest = require.resolve("vite/package.json");
  const rolldownManifest = createRequire(viteManifest).resolve("rolldown/package.json");
  return `vite@${await versionOf(viteManifest)} (rolldown@${await versionOf(rolldownManifest)})`;
}

/**
 * Bundles `entry` from the install in `dir` (which has node_modules/<candidate>), with
 * `externals` and their subpaths left out. Writes the entry module into `dir`.
 */
export async function bundleEntry(
  dir: string,
  entry: BundleEntry,
  externals: string[],
): Promise<BundleOutcome> {
  const entryFile = join(dir, ENTRY_FILE);
  await writeFile(entryFile, entryModuleSource(entry));
  const [result, parse] = await Promise.all([
    runViteBuild({ root: dir, entry: entryFile, peers: externals }),
    loadParser(),
  ]);
  const expected = await evaluatedToolchain();
  if (result.vite !== expected.vite || result.rolldown !== expected.rolldown) {
    // npm applies depfit's `overrides` only when depfit is the install root; elsewhere Vite may
    // resolve another rolldown. Numbers from a toolchain the eval did not cover are not reported.
    const found = `vite@${result.vite} rolldown@${result.rolldown}`;
    return { bytes: null, problems: [{ code: "TOOLCHAIN_MISMATCH", specifier: found }] };
  }
  const problems = problemsFromBuild(result, externals, entry.candidate, parse);
  if (problems.length) return { bytes: null, problems };
  return { bytes: chunkBytes(result.chunks), problems: [] };
}

/**
 * Bundle size of a `--bundle-entry` snippet: rolldown configured like Vite 8's client build,
 * run on the candidate's isolated install. Settings: eval/bundle/SETTINGS.md; contract:
 * eval/bundle/SPEC.md. rolldown is loaded with a dynamic import, only when bundling is requested.
 *
 * Unmeasurable builds give null bytes and `bundle: <CODE> [names]` reasons, never a smaller
 * number: unresolved imports are errors, and output that still imports a module the bundle does
 * not contain is rejected after the fact. The bytes are what the bundler emits; they make no
 * claim that the code runs in a browser.
 */
import { realpath, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { gzipSync } from "node:zlib";
import type { OutputChunk, Plugin, RolldownLog } from "rolldown";
import type { ESTree } from "rolldown/utils";
import { type BundleEntry, entryModuleSource, isCandidateSource } from "./bundle-entry.ts";
import { isRecord } from "./util.ts";

/** Vite's client conditions; rolldown adds import/require/default per import kind. */
const CONDITIONS = ["module", "browser", "production"];
const MAIN_FIELDS = ["browser", "module", "main"];
/** Vite 8's default `build.target` (baseline widely available). */
const TARGET = ["chrome111", "edge111", "firefox114", "safari16.4", "ios16.4"];
const ENTRY_FILE = "__depfit_entry.mjs";

/** Module extensions that hold JS (or JSON, which bundles to JS); others are CSS, wasm, assets. */
const JS_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".json",
]);

/**
 * One reason a bundle is unmeasurable. `code` is UNRESOLVED_IMPORT, MISSING_EXPORT,
 * IMPORT_OUTSIDE_BUNDLE, NO_ENTRY, or NON_JS_IMPORT (SPEC.md), or rolldown's own code for any other
 * build error (e.g. PARSE_ERROR).
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

// --- imports outside the bundle -------------------------------------------------------------------

type Parse = (code: string) => ESTree.Program;

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

// --- running rolldown ----------------------------------------------------------------------------

type Rolldown = typeof import("rolldown");

let loaded: Promise<{
  rolldown: Rolldown;
  plugins: typeof import("rolldown/plugins");
  parse: Parse;
}> | null = null;

/** rolldown and its parser, loaded once per process on first use. */
function loadRolldown() {
  loaded ??= Promise.all([
    import("rolldown"),
    import("rolldown/plugins"),
    import("rolldown/parseAst"),
  ]).then(([rolldown, plugins, { parseAst }]) => ({
    rolldown,
    plugins,
    parse: (code: string) => parseAst(code, { lang: "js", sourceType: "module" }),
  }));
  return loaded;
}

/** `rolldown@<version>`; starts loading rolldown. */
export async function bundlerName(): Promise<string> {
  const { rolldown } = await loadRolldown();
  return `rolldown@${rolldown.VERSION}`;
}

/** "pkg/lib/file.js" for a file in node_modules, the base name otherwise. */
export function moduleLabel(id: string): string {
  const path = id.split("?")[0] ?? id;
  const at = path.lastIndexOf("node_modules/");
  if (at >= 0) return path.slice(at + "node_modules/".length);
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(id: string): string {
  const path = (id.split("?")[0] ?? id).replace(/^.*\//, "");
  const dot = path.lastIndexOf(".");
  return dot <= 0 ? "" : path.slice(dot).toLowerCase();
}

/** CSS, wasm, images, fonts and other files that are not JS modules (`.node` addons excluded). */
export function isNonJsModule(id: string): boolean {
  const extension = extensionOf(id);
  return extension !== "" && extension !== ".node" && !JS_EXTENSIONS.has(extension);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * An import that does not resolve: NO_ENTRY when it is the snippet's own import of the candidate
 * (the package has no entry point for it), else UNRESOLVED_IMPORT. `entryFiles` are the entry
 * module's paths as written and as resolved through symlinks.
 */
export function unresolvedProblem(
  source: string,
  importer: string | undefined,
  entryFiles: string[],
  candidate: string,
): BundleProblem {
  const fromEntry = importer !== undefined && entryFiles.includes(importer);
  const noEntry = fromEntry && isCandidateSource(source, candidate);
  return { code: noEntry ? "NO_ENTRY" : "UNRESOLVED_IMPORT", specifier: source };
}

/**
 * Records every import that does not resolve and every non-JS module, and loads non-JS modules
 * as empty JS so the build goes on and reports every problem at once.
 */
function probePlugin(
  unresolved: (source: string, importer: string | undefined) => BundleProblem,
  problems: BundleProblem[],
): Plugin {
  return {
    name: "depfit-probe",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) {
        problems.push(unresolved(source, importer));
      } else if (!resolved.external && isNonJsModule(resolved.id)) {
        problems.push({ code: "NON_JS_IMPORT", specifier: moduleLabel(resolved.id) });
      }
      // Let rolldown resolve again with its own defaults, so resolution is unchanged.
      return null;
    },
    load(id) {
      return isNonJsModule(id) ? { code: "", moduleType: "js" } : null;
    },
  };
}

function problemsFromError(error: unknown): BundleProblem[] {
  const errors = isRecord(error) && Array.isArray(error.errors) ? error.errors : [error];
  return errors.map((item): BundleProblem => {
    const log = isRecord(item) ? item : {};
    const code = typeof log.code === "string" ? log.code : "BUILD_ERROR";
    const at =
      typeof log.exporter === "string" ? log.exporter : typeof log.id === "string" ? log.id : null;
    return { code, specifier: at === null ? null : moduleLabel(at) };
  });
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
  const { rolldown, plugins, parse } = await loadRolldown();
  const entryFile = join(dir, ENTRY_FILE);
  await writeFile(entryFile, entryModuleSource(entry));
  const entryFiles = [entryFile, await realpath(entryFile)];
  const unresolved = (source: string, importer: string | undefined) =>
    unresolvedProblem(source, importer, entryFiles, entry.candidate);

  const problems: BundleProblem[] = [];
  const external = externals.flatMap((name) => [name, new RegExp(`^${escapeRegExp(name)}/`)]);
  let chunks: OutputChunk[];
  try {
    const build = await rolldown.rolldown({
      input: entryFile,
      cwd: dir,
      platform: "browser",
      resolve: { conditionNames: CONDITIONS, mainFields: MAIN_FIELDS },
      transform: { define: { "process.env.NODE_ENV": '"production"' }, target: TARGET },
      preserveEntrySignatures: false,
      plugins: [
        probePlugin(unresolved, problems),
        // Peers are external; a CommonJS require() of one becomes an import of it, as it would
        // be in an app that has the peer, instead of a runtime require() helper.
        ...(external.length ? [plugins.esmExternalRequirePlugin({ external })] : []),
      ],
      onLog(level, log: RolldownLog) {
        // rolldown only warns about an unresolved import and leaves it external.
        if (log.code === "UNRESOLVED_IMPORT") {
          problems.push(
            log.exporter
              ? unresolved(log.exporter, log.id)
              : { code: "UNRESOLVED_IMPORT", specifier: null },
          );
        } else if (level === "warn" && log.code === "MISSING_EXPORT") {
          problems.push({
            code: "MISSING_EXPORT",
            specifier: log.exporter ? moduleLabel(log.exporter) : null,
          });
        }
      },
    });
    try {
      const { output } = await build.generate({
        format: "esm",
        minify: true,
        topLevelVar: true,
        comments: { legal: false, annotation: false, jsdoc: false },
        sourcemap: false,
      });
      chunks = output.filter((item): item is OutputChunk => item.type === "chunk");
    } finally {
      await build.close();
    }
  } catch (error) {
    // Non-JS modules were loaded as empty JS, so the errors that follow from that are not news.
    const nonJs = problems.some((problem) => problem.code === "NON_JS_IMPORT");
    return { bytes: null, problems: nonJs ? problems : [...problems, ...problemsFromError(error)] };
  }
  if (problems.length) return { bytes: null, problems };

  const outside = importsOutsideBundle(chunks, parse, externals);
  if (outside.length) {
    return {
      bytes: null,
      problems: outside.map((specifier) => ({ code: "IMPORT_OUTSIDE_BUNDLE", specifier })),
    };
  }
  return { bytes: chunkBytes(chunks), problems: [] };
}

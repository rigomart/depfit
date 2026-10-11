/** esbuild bundle sizes of a package installed in an isolated dir. */
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Message, type Platform, type Plugin } from "esbuild";
import type { Bundle } from "../report.ts";
import { asArray, asRecord, asString, errorMessage, isRecord } from "./util.ts";

const NODE_BUILTINS = new Set(builtinModules);
/** Builds are retried with newly unresolved imports marked external, at most this often. */
const MAX_RETRIES = 3;
/** How many folder levels below the package root are searched for nested package.json entries. */
const SUBPATH_DEPTH = 3;

function buildErrors(error: unknown): Message[] {
  if (!isRecord(error)) return [];
  return asArray(error.errors).filter(
    (entry): entry is Message => isRecord(entry) && typeof entry.text === "string",
  );
}

const unresolvedTarget = (message: Message) =>
  message.text.match(/Could not resolve "([^"]+)"/)?.[1] ?? null;

export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0] ?? specifier);
}

/** Marks build.resolve calls made by the plugin itself, so it does not intercept them. */
const RESOLVING = Symbol("depfit-resolving");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Marks native addons and the given unresolvable specifiers external, recording each in `seen`
 * by a short name: the basename for .node files, else the specifier as written.
 */
function externalsPlugin(unresolved: string[], seen: Set<string>): Plugin {
  return {
    name: "depfit-externals",
    setup(build) {
      // Imports of .node files, whether or not the file exists (install scripts are skipped).
      build.onResolve({ filter: /\.node$/ }, (args) => {
        seen.add(basename(args.path));
        return { path: args.path, external: true };
      });
      // Bare imports that resolve to a .node file, e.g. a platform package's main.
      build.onLoad({ filter: /\.node$/ }, (args) => {
        seen.add(basename(args.path));
        return { contents: "", loader: "js" };
      });
      if (!unresolved.length) return;
      const filter = new RegExp(`^(?:${unresolved.map(escapeRegExp).join("|")})$`);
      build.onResolve({ filter }, async (args) => {
        if (args.pluginData === RESOLVING) return undefined;
        // The same specifier may resolve from another importer (e.g. "./util" in another dir).
        const { errors } = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: RESOLVING,
        });
        if (!errors.length) return undefined;
        seen.add(args.path);
        return { path: args.path, external: true };
      });
    },
  };
}

function describeBuildError(error: unknown): string {
  const first = buildErrors(error)[0];
  if (!first) return errorMessage(error);
  const note = first.notes[0]?.text.replace(/:\s*$/, "");
  return note ? `${first.text}: ${note}` : first.text;
}

type Outcome<T> =
  | { ok: true; value: T; unresolved: string[] }
  | { ok: false; error: unknown; unresolved: string[]; needsBuiltins: boolean };

/**
 * Runs a build; when it fails only on imports that cannot be resolved (optional dependencies,
 * generated code, missing native builds), retries with those marked external. A Node built-in
 * failure is not retried. `unresolved` lists what was marked external, .node files included.
 */
async function buildRetrying<T>(
  run: (plugins: Plugin[]) => Promise<T>,
  known: string[] = [],
): Promise<Outcome<T>> {
  const unresolved = [...known];
  const seen = new Set<string>();
  const listed = () => [...seen].sort();
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await run([externalsPlugin(unresolved, seen)]);
      return { ok: true, value, unresolved: listed() };
    } catch (error) {
      const targets = buildErrors(error).map(unresolvedTarget);
      const needsBuiltins = targets.some((target) => target !== null && isNodeBuiltin(target));
      const fresh = targets.filter(
        (target): target is string =>
          target !== null && !isNodeBuiltin(target) && !unresolved.includes(target),
      );
      if (needsBuiltins || !fresh.length || attempt >= MAX_RETRIES) {
        return { ok: false, error, unresolved: listed(), needsBuiltins };
      }
      unresolved.push(...new Set(fresh));
    }
  }
}

async function sizeOf(
  dir: string,
  name: string,
  platform: Platform,
  external: string[],
  plugins: Plugin[],
) {
  const result = await build({
    stdin: {
      contents: `import * as m from ${JSON.stringify(name)}; globalThis.__depfit = m;`,
      resolveDir: dir,
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform,
    external,
    plugins,
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.contents ?? new Uint8Array();
  return { min: code.byteLength, gzip: gzipSync(code, { level: 9 }).byteLength };
}

/**
 * Named exports (excluding `default`) of the browser entry, with the same settings as the browser
 * size build. null when the entry is CommonJS, whose exports are not static.
 */
async function browserNamedExports(
  dir: string,
  name: string,
  external: string[],
  plugins: Plugin[],
): Promise<number | null> {
  const result = await build({
    entryPoints: [name],
    absWorkingDir: dir,
    bundle: true,
    format: "esm",
    platform: "browser",
    external,
    plugins,
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const output = Object.values(result.metafile.outputs)[0];
  if (!output?.entryPoint) return null;
  if (result.metafile.inputs[output.entryPoint]?.format === "cjs") return null;
  return output.exports.filter((name) => name !== "default").length;
}

const isNativeFile = (name: string) => name.endsWith(".node");

/**
 * Collapses per-platform builds of one native module ("keyring.darwin-arm64.node",
 * "keyring.linux-x64-gnu.node", ...) into "keyring.*.node (N variants)". Single files stay as-is.
 */
export function collapseNativeVariants(names: string[]): string[] {
  const families = new Map<string, string[]>();
  const rest: string[] = [];
  for (const name of new Set(names)) {
    if (!isNativeFile(name)) {
      rest.push(name);
      continue;
    }
    const family = name.slice(0, name.indexOf("."));
    families.set(family, [...(families.get(family) ?? []), name]);
  }
  const native = [...families].map(([family, files]) =>
    files.length > 1 ? `${family}.*.node (${files.length} variants)` : (files[0] ?? family),
  );
  return [...rest, ...native].sort();
}

/**
 * Keys of the `exports` map other than "." and "./package.json", verbatim (patterns like "./*"
 * included). Empty when exports is absent, a single target, or only conditions.
 */
export function subpathExports(manifest: Record<string, unknown>): string[] {
  const { exports } = manifest;
  if (!isRecord(exports)) return [];
  return Object.keys(exports).filter(
    (key) => key.startsWith(".") && key !== "." && key !== "./package.json",
  );
}

async function hasEntryManifest(file: string): Promise<boolean> {
  try {
    const manifest = asRecord(JSON.parse(await readFile(file, "utf8")));
    return ["main", "module", "browser"].some((field) => asString(manifest[field]) !== null);
  } catch {
    return false;
  }
}

/**
 * Folders below `packageDir` (up to SUBPATH_DEPTH levels, node_modules and dot-folders skipped)
 * with their own package.json naming an entry point, as "./element/adapter". Sorted.
 */
export async function subpathFolders(
  packageDir: string,
  prefix = ".",
  depth = 1,
): Promise<string[]> {
  if (depth > SUBPATH_DEPTH) return [];
  const entries = await readdir(packageDir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."),
      )
      .map(async (entry) => {
        const dir = join(packageDir, entry.name);
        const subpath = `${prefix}/${entry.name}`;
        const own = (await hasEntryManifest(join(dir, "package.json"))) ? [subpath] : [];
        return [...own, ...(await subpathFolders(dir, subpath, depth + 1))];
      }),
  );
  return nested.flat().sort();
}

/** Peers are supplied by the app, so they are left out of the bundle. */
export async function bundleFacts(
  dir: string,
  name: string,
  peers: string[],
  manifest: Record<string, unknown>,
): Promise<Bundle> {
  const [browser, node] = await Promise.all([
    buildRetrying((plugins) => sizeOf(dir, name, "browser", peers, plugins)),
    buildRetrying((plugins) => sizeOf(dir, name, "node", peers, plugins)),
  ]);
  // A browser build that only finished by leaving out native addons cannot run in a browser.
  const needsNative = browser.unresolved.some(isNativeFile);
  const browserCompatible = browser.ok
    ? !needsNative
    : browser.needsBuiltins || needsNative
      ? false
      : null;
  // Only meaningful for a browser build that works; probing anyway fails on Node-only imports
  // (e.g. execa: unicorn-magic's "default" condition has no toPath).
  const exports = browserCompatible
    ? await buildRetrying(
        (plugins) => browserNamedExports(dir, name, peers, plugins),
        browser.unresolved,
      )
    : null;

  const errors: string[] = [];
  if (!browser.ok && browserCompatible === null) {
    errors.push(`browser: ${describeBuildError(browser.error)}`);
  }
  if (!node.ok) errors.push(`node: ${describeBuildError(node.error)}`);
  if (exports && !exports.ok) errors.push(`exports: ${describeBuildError(exports.error)}`);

  // Any `exports` value, even a single target, blocks importing folders that are not listed.
  const subpaths =
    manifest.exports === undefined
      ? await subpathFolders(join(dir, "node_modules", name))
      : subpathExports(manifest);

  return {
    gzip_bytes_browser_full_import: browser.ok ? browser.value.gzip : null,
    min_bytes_browser_full_import: browser.ok ? browser.value.min : null,
    gzip_bytes_node_full_import: node.ok ? node.value.gzip : null,
    browser_compatible: browserCompatible,
    browser_named_exports: exports?.ok ? exports.value : null,
    unresolved_imports: collapseNativeVariants([
      ...browser.unresolved,
      ...node.unresolved,
      ...(exports?.unresolved ?? []),
    ]),
    subpath_exports: subpaths,
    errors,
  };
}

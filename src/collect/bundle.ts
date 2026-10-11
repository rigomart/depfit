/** esbuild bundle sizes of a package installed in an isolated dir. */
import { builtinModules } from "node:module";
import { gzipSync } from "node:zlib";
import { build, type Message, type Platform } from "esbuild";
import type { Bundle } from "../report.ts";
import { asArray, errorMessage, isRecord } from "./util.ts";

const NODE_BUILTINS = new Set(builtinModules);
/** Builds are retried with newly unresolved bare imports marked external, at most this often. */
const MAX_RETRIES = 3;

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

const isBare = (specifier: string) => !/^[./#]/.test(specifier) && !specifier.includes(":");

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
 * Runs a build; when it fails only on bare imports that are not installed (usually optional
 * dependencies), retries with those marked external. A Node built-in failure is not retried.
 */
async function buildRetrying<T>(
  run: (external: string[]) => Promise<T>,
  external: string[],
): Promise<Outcome<T>> {
  const unresolved: string[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, value: await run([...external, ...unresolved]), unresolved };
    } catch (error) {
      const targets = buildErrors(error).map(unresolvedTarget);
      const needsBuiltins = targets.some((target) => target !== null && isNodeBuiltin(target));
      const fresh = targets.filter(
        (target): target is string =>
          target !== null &&
          isBare(target) &&
          !isNodeBuiltin(target) &&
          !unresolved.includes(target),
      );
      if (needsBuiltins || !fresh.length || attempt >= MAX_RETRIES) {
        return { ok: false, error, unresolved, needsBuiltins };
      }
      unresolved.push(...new Set(fresh));
    }
  }
}

async function sizeOf(dir: string, name: string, platform: Platform, external: string[]) {
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
): Promise<number | null> {
  const result = await build({
    entryPoints: [name],
    absWorkingDir: dir,
    bundle: true,
    format: "esm",
    platform: "browser",
    external,
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const output = Object.values(result.metafile.outputs)[0];
  if (!output?.entryPoint) return null;
  if (result.metafile.inputs[output.entryPoint]?.format === "cjs") return null;
  return output.exports.filter((name) => name !== "default").length;
}

/** Peers are supplied by the app, so they are left out of the bundle. */
export async function bundleFacts(dir: string, name: string, peers: string[]): Promise<Bundle> {
  const [browser, node] = await Promise.all([
    buildRetrying((external) => sizeOf(dir, name, "browser", external), peers),
    buildRetrying((external) => sizeOf(dir, name, "node", external), peers),
  ]);
  const browserCompatible = browser.ok ? true : browser.needsBuiltins ? false : null;
  // Only meaningful for a browser build that works; probing anyway fails on Node-only imports
  // (e.g. execa: unicorn-magic's "default" condition has no toPath).
  const exports = browser.ok
    ? await buildRetrying(
        (external) => browserNamedExports(dir, name, external),
        [...peers, ...browser.unresolved],
      )
    : null;

  const errors: string[] = [];
  if (!browser.ok && browserCompatible === null) {
    errors.push(`browser: ${describeBuildError(browser.error)}`);
  }
  if (!node.ok) errors.push(`node: ${describeBuildError(node.error)}`);
  if (exports && !exports.ok) errors.push(`exports: ${describeBuildError(exports.error)}`);

  return {
    gzip_bytes_browser_full_import: browser.ok ? browser.value.gzip : null,
    min_bytes_browser_full_import: browser.ok ? browser.value.min : null,
    gzip_bytes_node_full_import: node.ok ? node.value.gzip : null,
    browser_compatible: browserCompatible,
    browser_named_exports: exports?.ok ? exports.value : null,
    unresolved_imports: [
      ...new Set([...browser.unresolved, ...node.unresolved, ...(exports?.unresolved ?? [])]),
    ].sort(),
    errors,
  };
}

/**
 * Which subpaths of a package's `exports` map are measured (eval/bundle/SPEC.md, iteration 2):
 * the keys a production browser import resolves to one JS module, the way Vite 8.3.4 resolves them
 * (its bundled `resolve.exports` 2.0.3, `unsafe: true`, conditions `module`, `browser`,
 * `production`, `import`, plus `default`). Pure: reads the manifest only, never package source.
 */
import { isRecord } from "./util.ts";

/** More listed subpaths than this are not built: `bundle: SUBPATH_LIMIT <count>`. */
export const SUBPATH_LIMIT = 100;

/** The conditions Vite matches for a production browser `import` (with `unsafe: true`). */
const CONDITIONS = new Set(["default", "module", "browser", "production", "import"]);

const JS_FILE = /\.(?:m|c)?jsx?$/;

export type ListedSubpath = {
  /** The `exports` key, e.g. "./lib/core". */
  key: string;
  /** The file it resolves to, relative to the package, e.g. "./es/core.js". */
  target: string;
};

export type SubpathListing = {
  /** The manifest has an `exports` field Vite uses (`if (data.exports)`). */
  exportsMap: boolean;
  /** Keys that name one JS module for the browser, in map order. */
  subpaths: ListedSubpath[];
  /** Every key containing `*`, verbatim, in map order. Not expanded or measured. */
  patterns: string[];
};

/**
 * The first target `value` resolves to under CONDITIONS, as `resolve.exports` 2.0.3 does: a string
 * is itself; an array collects what each item resolves to; an object follows the first key in
 * CONDITIONS, in the object's order, and does not fall through to later keys when that fails.
 */
function resolveTarget(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = resolveTarget(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [condition, nested] of Object.entries(value)) {
    if (CONDITIONS.has(condition)) return resolveTarget(nested);
  }
  return undefined;
}

/**
 * The subpaths and pattern keys of `manifest.exports`. A string, an array, or an object of
 * conditions is the root alone (`resolve.exports` wraps them as `{ ".": ... }`), with no subpaths.
 */
export function listSubpaths(manifest: Record<string, unknown>): SubpathListing {
  const exportsField = manifest.exports;
  if (!exportsField) return { exportsMap: false, subpaths: [], patterns: [] };
  if (!isRecord(exportsField)) return { exportsMap: true, subpaths: [], patterns: [] };
  const keys = Object.keys(exportsField);
  if (!keys[0]?.startsWith(".")) return { exportsMap: true, subpaths: [], patterns: [] };
  const subpaths: ListedSubpath[] = [];
  const patterns: string[] = [];
  for (const key of keys) {
    if (key.includes("*")) {
      patterns.push(key);
      continue;
    }
    if (key === "." || key === "./package.json" || key.endsWith("/") || !key.startsWith("./")) {
      continue;
    }
    const target = resolveTarget(exportsField[key]);
    if (target !== undefined && JS_FILE.test(target)) subpaths.push({ key, target });
  }
  return { exportsMap: true, subpaths, patterns };
}

/** The import specifier of a subpath key: "highlight.js/lib/core" for "./lib/core". */
export function subpathSpecifier(name: string, key: string): string {
  return `${name}/${key.slice(2)}`;
}

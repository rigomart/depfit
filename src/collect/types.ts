/** Whether a package ships its own TypeScript declarations. */
import { access } from "node:fs/promises";
import { join, normalize } from "node:path";
import { asString, isRecord } from "./util.ts";

type Manifest = Record<string, unknown>;

/** True when any key in the exports tree is a types condition, e.g. "types" or "types@<5.4". */
function hasTypesCondition(exports: unknown): boolean {
  if (Array.isArray(exports)) return exports.some(hasTypesCondition);
  if (!isRecord(exports)) return false;
  return Object.entries(exports).some(
    ([key, value]) => key.startsWith("types") || hasTypesCondition(value),
  );
}

/** Declared in package.json alone: `types`/`typings`, or a types* condition in `exports`. */
export function manifestDeclaresTypes(manifest: Manifest): boolean {
  return (
    Boolean(asString(manifest.types) ?? asString(manifest.typings)) ||
    hasTypesCondition(manifest.exports)
  );
}

/** Every file target in an exports value (strings anywhere under conditions or fallback arrays). */
function targets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  if (isRecord(value)) return Object.values(value).flatMap(targets);
  return [];
}

/** The root entry's targets: exports["."], or the whole exports value when it has no subpaths. */
function rootExportTargets(exports: unknown): string[] {
  if (isRecord(exports) && Object.keys(exports).some((key) => key.startsWith("."))) {
    return targets(exports["."]);
  }
  return targets(exports);
}

/** Root entry files: main, module, and the "." export targets. */
function entryFiles(manifest: Manifest): string[] {
  const main = asString(manifest.main) ?? "index.js";
  const module = asString(manifest.module);
  return [main, ...(module ? [module] : []), ...rootExportTargets(manifest.exports)];
}

/** "dist/index.js" -> "dist/index.d.ts", ".d.mts", ".d.cts". */
function declarationSiblings(entry: string): string[] {
  const stem = entry.replace(/\.[cm]?js$/, "");
  return [".d.ts", ".d.mts", ".d.cts"].map((ext) => `${stem}${ext}`);
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Whether the installed package at `packageDir` ships declarations: declared in package.json, a
 * .d.ts/.d.mts/.d.cts next to a root entry file, or an index.d.ts at the package root.
 */
export async function shipsTypes(packageDir: string, manifest: Manifest): Promise<boolean> {
  if (manifestDeclaresTypes(manifest)) return true;
  const candidates = new Set(
    ["index.d.ts", ...entryFiles(manifest).flatMap(declarationSiblings)]
      .map((file) => normalize(file))
      // Ignore targets that point outside the package.
      .filter((file) => !file.startsWith("..")),
  );
  const found = await Promise.all([...candidates].map((file) => exists(join(packageDir, file))));
  return found.includes(true);
}

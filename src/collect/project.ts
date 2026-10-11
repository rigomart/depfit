/** Reads the repo depfit runs in: root, workspace, lockfile, package.json and source files. */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Lockfile, ProjectInfo } from "../report.ts";
import type { ProjectFacts } from "./facts.ts";
import { type LockIndex, parseLockfile } from "./lockfile.ts";
import { asRecord, asString, asStringRecord } from "./util.ts";

export type Project = ProjectFacts & { info: ProjectInfo };

const LOCKFILES: Lockfile[] = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];
const ROOT_MARKERS = [...LOCKFILES, "bun.lockb", "pnpm-workspace.yaml"];
const DECLARED_FIELDS = [
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
  "dependencies",
] as const;
const SOURCE_EXT = /\.(?:[mc]?[tj]sx?|vue|svelte|astro)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_BYTES = 1_000_000;

function ancestors(dir: string): string[] {
  const dirs: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    dirs.push(current);
    if (dirname(current) === current) return dirs;
  }
}

/**
 * root: nearest directory with a lockfile (or pnpm-workspace.yaml), else the nearest with a
 * package.json. workspace: nearest package.json from cwd up to root, else root.
 */
export function findProjectDirs(cwd: string): { root: string; workspace: string } | null {
  const dirs = ancestors(cwd);
  const hasPackageJson = (dir: string) => existsSync(join(dir, "package.json"));
  const root =
    dirs.find((dir) => ROOT_MARKERS.some((file) => existsSync(join(dir, file)))) ??
    dirs.find(hasPackageJson);
  if (!root) return null;
  const workspace = dirs.slice(0, dirs.indexOf(root) + 1).find(hasPackageJson) ?? root;
  return { root, workspace };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readManifest(dir: string): Promise<Record<string, unknown>> {
  const text = await readOptional(join(dir, "package.json"));
  return text ? asRecord(JSON.parse(text)) : {};
}

async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (acc.length >= MAX_SOURCE_FILES) break;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await sourceFiles(full, acc);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Source files under `dir`, keyed by path relative to `root`. */
async function readSources(root: string, dir: string): Promise<Map<string, string>> {
  const files = await sourceFiles(dir);
  const entries = await Promise.all(
    files.map(async (file) => {
      const size = (await stat(file)).size;
      if (size > MAX_SOURCE_BYTES) return null;
      return [relative(root, file).split(sep).join("/"), await readFile(file, "utf8")] as const;
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

const declaredIn = (manifest: Record<string, unknown>, name: string) =>
  DECLARED_FIELDS.some((field) => name in asStringRecord(manifest[field]));

/** First non-empty trimmed file among `files`, looked up in each dir in order. */
async function firstFile(dirs: string[], files: string[]): Promise<string | null> {
  for (const file of files) {
    for (const dir of dirs) {
      const text = (await readOptional(join(dir, file)))?.trim();
      if (text) return text;
    }
  }
  return null;
}

async function runtimeFacts(
  dirs: string[],
  manifests: Array<Record<string, unknown>>,
  lockfile: Lockfile | null,
): Promise<Pick<ProjectInfo, "runtime" | "runtime_range">> {
  const engine = (key: string) =>
    manifests.map((m) => asString(asRecord(m.engines)[key])).find((v) => v) ?? null;
  const isBun =
    lockfile === "bun.lock" ||
    dirs.some((dir) => existsSync(join(dir, "bun.lockb"))) ||
    manifests.some(
      (m) =>
        declaredIn(m, "@types/bun") ||
        declaredIn(m, "bun-types") ||
        engine("bun") !== null ||
        asString(m.packageManager)?.startsWith("bun@"),
    );
  if (isBun) {
    return {
      runtime: "bun",
      runtime_range: (await firstFile(dirs, [".bun-version"])) ?? engine("bun"),
    };
  }
  const signal = lockfile !== null || manifests.some((m) => Object.keys(m).length > 0);
  return {
    runtime: signal ? "node" : null,
    runtime_range: (await firstFile(dirs, [".nvmrc", ".node-version"])) ?? engine("node"),
  };
}

/** null when no lockfile or package.json is found from cwd upwards. */
export async function loadProject(cwd: string): Promise<Project | null> {
  const found = findProjectDirs(cwd);
  if (!found) return null;
  const { root, workspace } = found;
  const dirs = workspace === root ? [root] : [workspace, root];

  const manifests = await Promise.all(dirs.map(readManifest));
  const manifest = manifests[0] ?? {};
  const lockfile = LOCKFILES.find((file) => existsSync(join(root, file))) ?? null;
  const lock: LockIndex = lockfile
    ? parseLockfile(lockfile, await readFile(join(root, lockfile), "utf8"))
    : new Map();

  const declared = new Map<string, string>();
  for (const field of DECLARED_FIELDS) {
    for (const [name, range] of Object.entries(asStringRecord(manifest[field]))) {
      declared.set(name, range);
    }
  }

  return {
    info: {
      root,
      workspace,
      lockfile,
      packages_in_lockfile: lock.size,
      module_type: manifest.type === "module" ? "module" : "commonjs",
      ...(await runtimeFacts(dirs, manifests, lockfile)),
    },
    lock,
    declared,
    sources: await readSources(root, workspace),
  };
}

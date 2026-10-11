/** Reads the repo depfit runs in: root, workspace, lockfile, package.json and source files. */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Lockfile, ProjectInfo } from "../report.ts";
import type { ProjectFacts, Workspace } from "./facts.ts";
import { type LockIndex, parseLockfile } from "./lockfile.ts";
import { asRecord, asString, asStringArray, asStringRecord, unquote } from "./util.ts";

export type Project = ProjectFacts & { info: ProjectInfo };

const LOCKFILES: Lockfile[] = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];
const ROOT_MARKERS = [...LOCKFILES, "bun.lockb", "pnpm-workspace.yaml"];
const DECLARED_FIELDS = [
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
  "dependencies",
] as const;
const WRANGLER_CONFIGS = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
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

type RepoFiles = { sources: string[]; manifestDirs: string[] };

/** Source files and directories holding a package.json under `dir`, skipping SKIP_DIRS and dot-dirs. */
async function walkRepo(dir: string, acc: RepoFiles = { sources: [], manifestDirs: [] }) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (acc.sources.length >= MAX_SOURCE_FILES) break;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walkRepo(full, acc);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) acc.sources.push(full);
    else if (entry.isFile() && entry.name === "package.json") acc.manifestDirs.push(dir);
  }
  return acc;
}

/** Repo-relative path with "/" separators; "." for the root itself. */
function repoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

/** Contents of `files`, keyed by path relative to `root`. */
async function readSources(root: string, files: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const size = (await stat(file)).size;
      if (size > MAX_SOURCE_BYTES) return null;
      return [repoPath(root, file), await readFile(file, "utf8")] as const;
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

/**
 * Lines of a top-level YAML block (`key:` at column 0) until the next top-level key, without
 * comments and blank lines. Enough for pnpm-workspace.yaml `packages`, `catalog`, `catalogs`.
 */
function yamlBlock(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, "").trimEnd());
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line) block.push(line);
  }
  return block;
}

/** `  key: value` entries of a YAML block with their indentation. */
function yamlEntries(lines: string[]) {
  return lines.flatMap((line) => {
    const match = line.match(/^(\s+)("[^"]+"|'[^']+'|[^\s'"-][^:]*?):\s*(.*)$/);
    if (!match?.[1] || !match[2]) return [];
    return [{ indent: match[1].length, key: unquote(match[2]), value: unquote(match[3] ?? "") }];
  });
}

/** Workspace globs from package.json `workspaces` (array or { packages }) and pnpm-workspace.yaml. */
function workspacePatterns(rootManifest: Record<string, unknown>, pnpmYaml: string | null) {
  const { workspaces } = rootManifest;
  const fromManifest = Array.isArray(workspaces)
    ? asStringArray(workspaces)
    : asStringArray(asRecord(workspaces).packages);
  const fromPnpm = pnpmYaml
    ? yamlBlock(pnpmYaml, "packages").flatMap((line) => {
        const item = line.match(/^\s+-\s+(.+)$/)?.[1];
        return item ? [unquote(item)] : [];
      })
    : [];
  return [...fromManifest, ...fromPnpm];
}

/** "apps/*" -> /^apps\/[^/]*$/; "**" spans directories. */
export function globRegExp(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  const source = clean
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*|\?/g, (token) => {
      if (token === "**/") return "(?:.*/)?";
      if (token === "**") return ".*";
      return token === "*" ? "[^/]*" : "[^/]";
    });
  return new RegExp(`^${source}$`);
}

/** Repo-relative dirs of workspace package.jsons: the root, matches of `patterns`, and `current`. */
function workspaceDirs(manifestDirs: string[], patterns: string[], current: string): string[] {
  const include = patterns.filter((p) => !p.startsWith("!")).map(globRegExp);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => globRegExp(p.slice(1)));
  const matches = manifestDirs.filter(
    (dir) => include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir)),
  );
  const rest = [...new Set([current, ...matches])].filter((dir) => dir !== ".").sort();
  return [".", ...rest];
}

/** pnpm (pnpm-workspace.yaml) and bun (root package.json or its `workspaces`) catalogs. */
function readCatalogs(rootManifest: Record<string, unknown>, pnpmYaml: string | null) {
  const catalogs = new Map<string, Map<string, string>>();
  const add = (catalog: string, name: string, range: string) => {
    const entries = catalogs.get(catalog) ?? new Map<string, string>();
    entries.set(name, range);
    catalogs.set(catalog, entries);
  };
  for (const source of [rootManifest, asRecord(rootManifest.workspaces)]) {
    for (const [name, range] of Object.entries(asStringRecord(source.catalog))) {
      add("default", name, range);
    }
    for (const [catalog, entries] of Object.entries(asRecord(source.catalogs))) {
      for (const [name, range] of Object.entries(asStringRecord(entries)))
        add(catalog, name, range);
    }
  }
  if (pnpmYaml) {
    for (const { key, value } of yamlEntries(yamlBlock(pnpmYaml, "catalog"))) {
      if (value) add("default", key, value);
    }
    const named = yamlEntries(yamlBlock(pnpmYaml, "catalogs"));
    const base = Math.min(...named.map((entry) => entry.indent));
    let current: string | null = null;
    for (const { indent, key, value } of named) {
      if (indent === base) current = key;
      else if (current && value) add(current, key, value);
    }
  }
  return catalogs;
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
  // dirs and manifests start with the workspace.
  const isWorkers =
    WRANGLER_CONFIGS.some((file) => existsSync(join(dirs[0] ?? "", file))) ||
    declaredIn(manifests[0] ?? {}, "wrangler");
  if (isWorkers) return { runtime: "cloudflare-workers", runtime_range: null };
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

function declaredDependencies(manifest: Record<string, unknown>): Map<string, string> {
  const declared = new Map<string, string>();
  for (const field of DECLARED_FIELDS) {
    for (const [name, range] of Object.entries(asStringRecord(manifest[field]))) {
      declared.set(name, range);
    }
  }
  return declared;
}

/** null when no lockfile or package.json is found from cwd upwards. */
export async function loadProject(cwd: string): Promise<Project | null> {
  const found = findProjectDirs(cwd);
  if (!found) return null;
  const { root, workspace } = found;
  const dirs = workspace === root ? [root] : [workspace, root];

  const manifests = await Promise.all(dirs.map(readManifest));
  const manifest = manifests[0] ?? {};
  const rootManifest = manifests.at(-1) ?? {};
  const lockfile = LOCKFILES.find((file) => existsSync(join(root, file))) ?? null;
  const lock: LockIndex = lockfile
    ? parseLockfile(lockfile, await readFile(join(root, lockfile), "utf8"))
    : new Map();

  const pnpmYaml = await readOptional(join(root, "pnpm-workspace.yaml"));
  const files = await walkRepo(root);
  const current = repoPath(root, workspace);
  const workspaces: Workspace[] = await Promise.all(
    workspaceDirs(
      files.manifestDirs.map((dir) => repoPath(root, dir)),
      workspacePatterns(rootManifest, pnpmYaml),
      current,
    ).map(async (dir) => {
      // A broken package.json elsewhere in the repo should not hide the current workspace's facts.
      const own =
        dir === current ? manifest : await readManifest(join(root, dir)).catch(() => ({}));
      return { dir, declared: declaredDependencies(own) };
    }),
  );

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
    workspace: current,
    workspaces,
    catalogs: readCatalogs(rootManifest, pnpmYaml),
    sources: await readSources(root, files.sources),
  };
}

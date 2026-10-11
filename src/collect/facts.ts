/**
 * Pure computations over a project (lockfile index, declared deps, source contents) and an
 * isolated install tree. No I/O here, so all of it is unit-testable.
 */
import { builtinModules } from "node:module";
import semver from "semver";
import type { Compatibility, Cost, InRepo, PackageReport } from "../report.ts";
import { dependentsOf, type LockIndex, lockedVersions, sortVersions } from "./lockfile.ts";

/** A dependency as requested in a package's manifest; `key` is its node_modules folder name. */
export type TreeEdge = { key: string; name: string; range: string };

/** One entry of an isolated `npm install` of the candidate. */
export type TreePackage = {
  /** Path in the install, e.g. "node_modules/a/node_modules/b". */
  path: string;
  name: string;
  version: string;
  /** dependencies, optionalDependencies and non-optional peers. */
  edges: TreeEdge[];
  /** false for optional packages npm skipped because they target another OS/CPU. */
  installed: boolean;
  /** On-disk bytes on this platform; 0 when not installed. */
  diskBytes: number;
  hasInstallScript: boolean;
  nativeBinary: boolean;
  license: string | null;
};

/** A workspace package.json: repo-relative dir ("." for the root) and ranges by dependency name. */
export type Workspace = { dir: string; declared: Map<string, string> };

/** What depfit knows about the repo it runs in. */
export type ProjectFacts = {
  lock: LockIndex;
  /** Repo-relative dir of the workspace the comparison is for, "." for the root. */
  workspace: string;
  /** Every workspace package.json in the repo, the root and the current workspace included. */
  workspaces: Workspace[];
  /** pnpm/bun catalogs by name ("default" for `catalog:`): package name -> range. */
  catalogs: Map<string, Map<string, string>>;
  /** Repo-relative path -> contents, for source files anywhere in the repo. */
  sources: Map<string, string>;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Repo-relative files that import, re-export or require `name` or one of its subpaths. */
export function filesUsing(sources: Map<string, string>, name: string): string[] {
  const pattern = new RegExp(
    `(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)['"\`]${escapeRegExp(name)}(?:/[^'"\`]*)?['"\`]`,
  );
  return [...sources.entries()]
    .filter(([, contents]) => pattern.test(contents))
    .map(([path]) => path)
    .sort();
}

/** Highest semver version, else the last one; null for an empty list. */
function newest(versions: string[]): string | null {
  return versions.filter((v) => semver.valid(v)).at(-1) ?? versions.at(-1) ?? null;
}

export function versionChange(
  version: string,
  installed: string | null,
): InRepo["version_change_from_installed"] {
  if (!installed || !semver.valid(version) || !semver.valid(installed)) return null;
  if (semver.eq(version, installed)) return "same";
  if (semver.lt(version, installed)) return "older";
  switch (semver.diff(installed, version)) {
    case "major":
    case "premajor":
      return "major";
    case "minor":
    case "preminor":
      return "minor";
    default:
      return "patch";
  }
}

/** The range in the current workspace's package.json, verbatim. */
function declaredInWorkspace(project: ProjectFacts, name: string): string | null {
  return project.workspaces.find((w) => w.dir === project.workspace)?.declared.get(name) ?? null;
}

/**
 * The range the current workspace declares for `name`, with `catalog:` / `catalog:<name>`
 * references replaced by the catalog's range; null when not declared or the catalog lacks it.
 */
export function declaredRange(project: ProjectFacts, name: string): string | null {
  const range = declaredInWorkspace(project, name);
  if (!range?.startsWith("catalog:")) return range;
  const catalog = range.slice("catalog:".length).trim() || "default";
  return project.catalogs.get(catalog)?.get(name) ?? null;
}

export function inRepoFacts(project: ProjectFacts, name: string, version: string): InRepo {
  const installed = lockedVersions(project.lock, name);
  const newestInstalled = newest(installed);
  return {
    installed_versions: installed,
    newest_installed: newestInstalled,
    version_change_from_installed: versionChange(version, newestInstalled),
    pulled_in_by: dependentsOf(project.lock, name),
    in_package_json: declaredInWorkspace(project, name),
    declared_in_workspaces: project.workspaces.flatMap(({ dir, declared }) => {
      const range = declared.get(name);
      return range === undefined ? [] : [{ workspace: dir, range }];
    }),
    files_using: filesUsing(project.sources, name),
  };
}

/** Node built-ins that only exist with the `node:` prefix. */
const PREFIX_ONLY_BUILTINS = new Set(["quic", "sea", "sqlite", "test", "test/reporters"]);

/**
 * Files importing a runtime module: the exact specifier, plus the bare form for `node:` modules
 * that also exist without the prefix ("fs" for "node:fs", but nothing for "node:sqlite").
 */
export function builtinFilesUsing(sources: Map<string, string>, specifier: string): string[] {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : null;
  const hasBareForm =
    bare !== null && !PREFIX_ONLY_BUILTINS.has(bare) && builtinModules.includes(bare);
  const files = filesUsing(sources, specifier);
  if (hasBareForm) files.push(...filesUsing(sources, bare));
  return [...new Set(files)].sort();
}

/** The report for a runtime module candidate such as "node:sqlite": only in_repo is filled. */
export function builtinReport(
  spec: string,
  project: ProjectFacts | null,
  unavailable: string[],
): PackageReport {
  const name = spec.trim();
  return {
    requested: spec,
    kind: "builtin",
    name,
    version: null,
    version_source: null,
    latest_version: null,
    description: null,
    keywords: [],
    error: null,
    unavailable,
    in_repo: project && {
      installed_versions: [],
      newest_installed: null,
      version_change_from_installed: null,
      pulled_in_by: [],
      in_package_json: null,
      declared_in_workspaces: [],
      files_using: builtinFilesUsing(project.sources, name),
    },
    cost: {
      total_packages: 0,
      new_packages: [],
      reused_packages: [],
      new_install_bytes: 0,
      install_scripts: [],
      native_binaries: [],
      other_platform_packages: 0,
      bundle: {
        gzip_bytes_browser_full_import: null,
        min_bytes_browser_full_import: null,
        gzip_bytes_node_full_import: null,
        browser_compatible: null,
        browser_named_exports: null,
        unresolved_imports: [],
        subpath_exports: [],
        errors: [],
      },
    },
    compatibility: null,
    maintenance: null,
    security: null,
  };
}

/** The lockfile version that would be reused for `name` requested as `range`, if any. */
function lockedMatch(lock: LockIndex, name: string, version: string, range: string): string | null {
  const versions = lock.get(name);
  if (!versions) return null;
  if (versions.has(version)) return version;
  return (
    sortVersions([...versions.keys()])
      .reverse()
      .find((v) => semver.valid(v) && semver.satisfies(v, range, { loose: true })) ?? null
  );
}

/** Node's resolution: the nearest node_modules/<key> from `from` upwards. */
function resolveEdge(
  byPath: Map<string, TreePackage>,
  from: string,
  key: string,
): TreePackage | null {
  for (let base = from; ; ) {
    const candidate = byPath.get(base ? `${base}/node_modules/${key}` : `node_modules/${key}`);
    if (candidate) return candidate;
    if (!base) return null;
    const parent = base.lastIndexOf("/node_modules/");
    base = parent >= 0 ? base.slice(0, parent) : "";
  }
}

const ids = (packages: Iterable<TreePackage>) =>
  [...new Set([...packages].map((pkg) => `${pkg.name}@${pkg.version}`))].sort();

const namesWhere = (tree: TreePackage[], filter: (pkg: TreePackage) => boolean) =>
  [...new Set(tree.filter(filter).map((pkg) => pkg.name))].sort();

/**
 * Walks the install from the root package. A package the lockfile satisfies (same version, or a
 * locked version within the range its parent requests) is reused and its subtree is not visited:
 * the locked copy brings its own, already-locked dependencies. The root is requested as ^version,
 * as `npm install` would save it. Without a lockfile everything installed is new.
 */
export function treeCost(
  lock: LockIndex | null,
  root: { name: string; version: string },
  tree: TreePackage[],
): Omit<Cost, "bundle"> {
  const installed = tree.filter((pkg) => pkg.installed);
  const byPath = new Map(installed.map((pkg) => [pkg.path, pkg]));
  const fresh = new Map<string, TreePackage>();
  const reused = new Set<string>();

  const rootNode = byPath.get(`node_modules/${root.name}`);
  const stack: Array<{ node: TreePackage; range: string }> = rootNode
    ? [{ node: rootNode, range: `^${root.version}` }]
    : installed.map((node) => ({ node, range: node.version }));
  for (let item = stack.pop(); item; item = stack.pop()) {
    const { node, range } = item;
    const locked = lock ? lockedMatch(lock, node.name, node.version, range) : null;
    if (locked) {
      reused.add(`${node.name}@${locked}`);
      continue;
    }
    if (fresh.has(node.path)) continue;
    fresh.set(node.path, node);
    for (const edge of node.edges) {
      const target = resolveEdge(byPath, node.path, edge.key);
      if (target) stack.push({ node: target, range: edge.range });
    }
  }

  return {
    total_packages: installed.length,
    new_packages: ids(fresh.values()),
    reused_packages: [...reused].sort(),
    new_install_bytes: [...fresh.values()].reduce((sum, pkg) => sum + pkg.diskBytes, 0),
    install_scripts: namesWhere(installed, (pkg) => pkg.hasInstallScript),
    native_binaries: namesWhere(installed, (pkg) => pkg.nativeBinary),
    other_platform_packages: tree.length - installed.length,
  };
}

export function licensesInTree(tree: TreePackage[]): string[] {
  return [
    ...new Set(tree.filter((pkg) => pkg.installed).map((pkg) => pkg.license ?? "UNKNOWN")),
  ].sort();
}

/** Installed packages other than the root itself, for vulnerability lookups. */
export function dependenciesOf(root: string, tree: TreePackage[]): TreePackage[] {
  return tree.filter((pkg) => pkg.installed && pkg.path !== `node_modules/${root}`);
}

export function peerDependencyFacts(
  peers: Record<string, string>,
  optional: Set<string>,
  lock: LockIndex | null,
): Compatibility["peer_dependencies"] {
  return Object.entries(peers).map(([name, range]) => {
    const installed = lock ? newest(lockedVersions(lock, name)) : null;
    const satisfied = !lock
      ? null
      : installed !== null &&
        semver.satisfies(installed, range, { includePrerelease: true, loose: true });
    return {
      name,
      range,
      optional: optional.has(name),
      installed,
      satisfied_by_lockfile: satisfied,
    };
  });
}

/** Whether the lowest runtime version the project allows satisfies the package's engine range. */
export function engineSatisfied(
  projectRange: string | null,
  engine: string | null,
): boolean | null {
  if (!projectRange || !engine || !semver.validRange(engine)) return null;
  const range = semver.validRange(projectRange.trim().replace(/^v/, ""));
  const lowest = range ? semver.minVersion(range) : null;
  return lowest ? semver.satisfies(lowest, engine) : null;
}

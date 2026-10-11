/**
 * Pure computations over a project (lockfile index, declared deps, source contents) and an
 * isolated install tree. No I/O here, so all of it is unit-testable.
 */
import semver from "semver";
import type { Compatibility, Cost, InRepo } from "../report.ts";
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

/** What depfit knows about the repo it runs in. */
export type ProjectFacts = {
  lock: LockIndex;
  /** Workspace package.json ranges by name, across all dependency fields. */
  declared: Map<string, string>;
  /** Repo-relative path -> contents, for source files in the workspace. */
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

export function inRepoFacts(project: ProjectFacts, name: string, version: string): InRepo {
  const installed = lockedVersions(project.lock, name);
  const newestInstalled = newest(installed);
  return {
    installed_versions: installed,
    newest_installed: newestInstalled,
    version_change_from_installed: versionChange(version, newestInstalled),
    pulled_in_by: dependentsOf(project.lock, name),
    in_package_json: project.declared.get(name) ?? null,
    files_using: filesUsing(project.sources, name),
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

/**
 * The report depfit prints. JSON output is this type serialized as-is; the table is a view of it.
 * Field descriptions for JSON readers ship separately via `depfit --schema` (src/schema-docs.ts).
 *
 * Rules (see AGENTS.md):
 * - Facts only. No scores, verdicts, warnings, or prose notes.
 * - Every package has every field. Missing data is `null`, never an absent key, so no field
 *   appears only when something looks bad.
 * - Units and caveats live in field names (`_bytes`, `_full_import`), not in commentary.
 */

export const SCHEMA_VERSION = 3;

export type Lockfile = "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "bun.lock";

export type Report = {
  schema_version: typeof SCHEMA_VERSION;
  generated_at: string;
  /** Where install sizes and native binaries were measured, e.g. "darwin-arm64". */
  measured_on_platform: string;
  /** null when no package.json/lockfile was found from --cwd upwards. */
  project: ProjectInfo | null;
  packages: PackageReport[];
};

export type ProjectInfo = {
  root: string;
  /** Directory the comparison is for (the workspace containing --cwd); equals root in single-package repos. */
  workspace: string;
  lockfile: Lockfile | null;
  /** Distinct package names in the lockfile. */
  packages_in_lockfile: number;
  module_type: "module" | "commonjs";
  /**
   * Runtime the workspace targets: "cloudflare-workers" when it has a wrangler config
   * (wrangler.toml/.json/.jsonc) or depends on wrangler; else "bun" when bun.lock / @types/bun /
   * engines.bun indicate it; otherwise "node". null when there is no project signal at all.
   */
  runtime: "node" | "bun" | "cloudflare-workers" | null;
  /** Version range for `runtime` from .nvmrc, .node-version, .bun-version, or package.json engines. */
  runtime_range: string | null;
};

/**
 * A "builtin" is a runtime module given as a candidate, e.g. "node:sqlite" or "bun:sqlite".
 * For builtins only `in_repo` is filled (files_using lists importing files; installed_versions,
 * pulled_in_by and declared_in_workspaces stay empty), `cost`
 * has zero packages and null bundle sizes, and version/compatibility/maintenance/security are null.
 */
export type PackageReport = {
  /** The spec as typed, e.g. "zod", "zod@^3", or "node:sqlite". */
  requested: string;
  kind: "npm" | "builtin";
  name: string;
  /**
   * The version every `cost` field is for. Chosen by `version_source`: an explicit range in the
   * spec wins; else the highest version satisfying the workspace package.json range if declared
   * there; else npm latest. null when `error` is set or for builtins.
   */
  version: string | null;
  version_source: "requested" | "declared_range" | "latest" | null;
  /** npm `latest` dist-tag, for comparison with `version`. null for builtins or on error. */
  latest_version: string | null;
  /** npm `description`, verbatim. */
  description: string | null;
  /** npm `keywords`, verbatim. */
  keywords: string[];
  /** Set when the package could not be resolved at all; every section below is then null. */
  error: string | null;
  /** Data sources that failed or were skipped, e.g. "github: no token". Empty when complete. */
  unavailable: string[];

  in_repo: InRepo | null;
  cost: Cost | null;
  compatibility: Compatibility | null;
  maintenance: Maintenance | null;
  security: Security | null;
};

/** Facts derived from the current project. null when there is no project. */
export type InRepo = {
  /** Versions of this package already resolved in the lockfile. */
  installed_versions: string[];
  /**
   * Highest of installed_versions, or null. Depending on this version instead of `version`
   * adds no packages: it is already resolved.
   */
  newest_installed: string | null;
  /**
   * How `version` relates to newest_installed: "same", "patch", "minor", "major" (upgrades),
   * or "older". null when not installed.
   */
  version_change_from_installed: "same" | "patch" | "minor" | "major" | "older" | null;
  /** Registry packages in the lockfile that depend on this one (dependencies, optional, peer). */
  pulled_in_by: string[];
  /** Range in the current workspace's package.json (any dependency field), or null if not declared. */
  in_package_json: string | null;
  /** Every workspace package.json that declares it, root included: repo-relative dir ("." for root) and range. */
  declared_in_workspaces: Array<{ workspace: string; range: string }>;
  /** Source files anywhere in the repo that import or require it, repo-relative (prefix shows the workspace). */
  files_using: string[];
};

/**
 * What depending on `version` costs this project. Estimated against the lockfile with semver
 * ranges: a package counts as reused when the lockfile already has a version satisfying the range
 * its parent requests, and then its own dependencies are not counted at all.
 */
export type Cost = {
  /** Packages installed for `version` on this platform, itself included, with no dedupe. */
  total_packages: number;
  /** name@version not satisfied by the lockfile. Empty when version_change_from_installed is "same". */
  new_packages: string[];
  /** name@version already in the lockfile that would be reused (the lockfile's version). */
  reused_packages: string[];
  /** On-disk bytes of new_packages on measured_on_platform. */
  new_install_bytes: number;
  /** Packages in the tree with preinstall/install/postinstall scripts. */
  install_scripts: string[];
  /** Packages that installed a native binary on this platform (.node, .dylib, .so, .dll, binding.gyp). */
  native_binaries: string[];
  /** Optional per-OS/CPU packages that would not install on this platform; excluded from all counts above. */
  other_platform_packages: number;
  bundle: Bundle;
};

/** esbuild, minified, of `import * as m from "<name>"`: an upper bound for libraries that tree-shake. */
export type Bundle = {
  /** Browser build. null when the browser build failed. */
  gzip_bytes_browser_full_import: number | null;
  min_bytes_browser_full_import: number | null;
  /** Node build ("node" export conditions; Node built-ins external). */
  gzip_bytes_node_full_import: number | null;
  /** false when the browser build needs Node built-ins or native .node files. null when it failed for another reason. */
  browser_compatible: boolean | null;
  /** Named exports of the browser entry (excluding default). 0 = the browser entry exports nothing. null when not browser-compatible or not statically known (CommonJS). */
  browser_named_exports: number | null;
  /** Bare imports, native .node files, or generated paths that could not be bundled and were marked external to finish the build. */
  unresolved_imports: string[];
  /**
   * Importable subpaths other than the root, e.g. "./element/adapter": keys of the `exports` map
   * (excluding "." and "./package.json"), or, when there is no `exports` map, folders that carry
   * their own package.json with an entry point. Code that lives only in subpaths is not in the
   * full-import sizes.
   */
  subpath_exports: string[];
  /** Build failures, each prefixed with the build: "browser: ...", "node: ...". */
  errors: string[];
};

export type Compatibility = {
  module_format: "esm" | "cjs" | "dual";
  /** package.json declares `"sideEffects": false`. */
  side_effects_free: boolean;
  types_source: "bundled" | "definitely_typed" | "none";
  /** The @types package spec when types_source is "definitely_typed", else null. Not included in `cost`. */
  types_package: string | null;
  /** package.json `engines`, verbatim (e.g. { node: ">=18", bun: ">=1.1" }). */
  engines: Record<string, string>;
  /** engines[project.runtime] vs project.runtime_range. null when either side is unknown. */
  engine_satisfied: boolean | null;
  peer_dependencies: Array<{
    name: string;
    range: string;
    optional: boolean;
    /** Highest version in the lockfile, null if absent or no project. */
    installed: string | null;
    /** `installed` satisfies `range`. false when not installed; null when there is no project. */
    satisfied_by_lockfile: boolean | null;
  }>;
  license: string | null;
  licenses_in_tree: string[];
};

export type Maintenance = {
  // npm registry
  deprecated: string | null;
  published_at: string;
  days_since_release: number;
  first_published_at: string;
  stable_releases_last_year: number;
  /** A newer version is published under a non-latest dist-tag, e.g. "next=5.0.0-beta.1". */
  prerelease_tags_ahead: string[];
  npm_maintainers: number;
  /** npm users who published the last 10 stable releases. */
  publishers_recent: string[];
  provenance: boolean;
  /** Includes installs as a transitive dependency. */
  weekly_downloads: number | null;
  /** Downloads in the last 90 days divided by the 90 before, minus 1: 0.12 = 12% more. */
  downloads_change_ratio_90d: number | null;

  // GitHub; all null when the repo is unknown or GitHub is unavailable
  repository: string | null;
  archived: boolean | null;
  stars: number | null;
  last_commit_at: string | null;
  /** All commits on the default branch, bots included. */
  commits_last_90d: number | null;
  commits_last_year: number | null;
  /** The most recent ≤100 commits of the past year, which the fields below are computed from. */
  sampled_commits: number | null;
  /** Commits in the sample by bots (dependabot, renovate, *-bot, GitHub Bot accounts). */
  sampled_commits_by_bots: number | null;
  /** Distinct human authors in the sample. */
  human_committers: number | null;
  /** Human author with the most commits in the sample. */
  top_human_committer: string | null;
  /** That author's share of the sample's human commits, 0–1. */
  top_human_committer_share: number | null;
  /** Share of the last ≤50 merged human PRs authored by someone other than top_human_committer, 0–1. */
  merged_prs_by_others_share: number | null;
  open_issues: number | null;
  open_prs: number | null;
  /** Median days from open to close over the last 100 issues that were closed. */
  issues_median_days_to_close: number | null;
};

export type Advisory = {
  /** OSV id, e.g. "GHSA-xxxx-xxxx-xxxx". */
  id: string;
  summary: string | null;
  /** As published (e.g. "HIGH", "MODERATE"), or null. */
  severity: string | null;
  /** Affected ranges as published, e.g. ">=0 <4.0.10". */
  affected_ranges: string[];
  fixed_in: string[];
  affects_version: boolean;
  /** null when not installed. */
  affects_newest_installed: boolean | null;
};

export type Security = {
  /** Every published advisory for this package, any version. */
  advisories: Advisory[];
  /** Advisories affecting other packages in `version`'s tree, as "name@version:ID". */
  dependency_vulnerabilities: string[];
};

export type CollectOptions = { cwd: string };

/** Implemented in src/collect/index.ts. */
export type Collect = (specs: string[], options: CollectOptions) => Promise<Report>;

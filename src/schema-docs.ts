import { SCHEMA_VERSION } from "./report.ts";

/**
 * One sentence per JSON path of `Report`, for agents reading the JSON (`depfit --schema`).
 * Paths use "." for object keys and "[]" for array items. Containers that can be null are
 * documented too, so a null section is explained where it appears.
 * Keep in sync with src/report.ts; test/schema-docs.test.ts checks the paths.
 */

const GITHUB_NULL = "null when the repository is unknown or GitHub data is unavailable";
const NULL_SECTION = 'null when error is set or kind is "builtin"';

export const FIELD_DESCRIPTIONS: Record<string, string> = {
  schema_version:
    "Version of this report format; it changes when a field is renamed, removed, or changes meaning.",
  generated_at:
    "ISO 8601 UTC time the report was collected; every relative value (days, last week, last year) is measured back from it.",
  measured_on_platform:
    'OS and CPU (e.g. "darwin-arm64") where install sizes, native binaries, and other-platform packages were measured; other platforms install different optional packages.',
  project:
    "The repo found from --cwd upwards; null when no package.json or lockfile was found, in which case every packages[].in_repo is null.",
  "project.root": "Absolute path of the project root.",
  "project.workspace":
    "Absolute path of the workspace containing --cwd that the comparison is for; equals project.root in single-package repos.",
  "project.lockfile":
    "File name of the lockfile every in_repo and cost comparison is made against; null when the project has no lockfile, so nothing counts as already installed.",
  "project.packages_in_lockfile": "Number of distinct package names in the lockfile.",
  "project.module_type":
    'Module system of the workspace package.json: "module" or "commonjs" (its default when `type` is absent).',
  "project.runtime":
    'Runtime the workspace targets: "cloudflare-workers" when it has a wrangler config (wrangler.toml, wrangler.json, or wrangler.jsonc) or depends on wrangler, else "bun" when bun.lock, @types/bun, or engines.bun indicate it, otherwise "node"; null when there is no project signal at all.',
  "project.runtime_range":
    "Version range for project.runtime from .nvmrc, .node-version, .bun-version, or package.json engines; null when none of them sets one.",

  packages: "One entry per requested spec, in the order given on the command line.",
  "packages[].requested": 'The spec exactly as typed, e.g. "zod", "zod@^3", or "node:sqlite".',
  "packages[].kind":
    '"npm" for a registry package, or "builtin" for a runtime module such as "node:sqlite" or "bun:sqlite", for which only in_repo (files_using) is filled, cost has zero packages, version, version_source, and latest_version are null, and compatibility, maintenance, and security are null.',
  "packages[].name": 'npm package name, or the builtin module name as typed (e.g. "node:sqlite").',
  "packages[].version":
    'The version every cost field is for, chosen as described by version_source; it can differ from latest_version and from in_repo.newest_installed; null when error is set or kind is "builtin".',
  "packages[].version_source":
    'How `version` was chosen: "requested" when the spec has an explicit range, else "declared_range" for the highest version satisfying the current workspace package.json range (which may be a prerelease), else "latest" for the npm latest dist-tag; null when version is null.',
  "packages[].latest_version":
    'The npm latest dist-tag, for comparison with `version`, which may be higher (a declared prerelease) or lower (an older requested range); null when error is set or kind is "builtin".',
  "packages[].description": "The package's npm description, verbatim; null when it has none.",
  "packages[].keywords": "The package's npm keywords, verbatim; empty when it has none.",
  "packages[].error":
    "Why the spec could not be resolved at all, in which case in_repo, cost, compatibility, maintenance, and security are all null; null on success.",
  "packages[].unavailable":
    'Data sources that failed or were skipped, e.g. "github: no token"; fields fed by a listed source are null, not zero; empty when every source answered.',

  "packages[].in_repo":
    'How this package already appears in the project; null when there is no project or error is set; for kind "builtin" only files_using can be non-empty.',
  "packages[].in_repo.installed_versions":
    "Every version of this package already resolved in the lockfile, at any depth; empty when not installed.",
  "packages[].in_repo.newest_installed":
    "Highest of installed_versions, or null when not installed; depending on this version instead of `version` adds no packages because it is already resolved.",
  "packages[].in_repo.version_change_from_installed":
    'How `version` relates to newest_installed: "same", an upgrade ("patch", "minor", "major"), or "older" when `version` is lower; null when not installed.',
  "packages[].in_repo.pulled_in_by":
    "Names of registry packages in the lockfile that depend on this one (dependencies, optional, or peer), not workspace packages; empty when none do.",
  "packages[].in_repo.in_package_json":
    "The dependency spec exactly as written in the current workspace's package.json (any dependency field), which may be an exact pin or a range; null when not declared there, even if another workspace declares it (see declared_in_workspaces).",
  "packages[].in_repo.declared_in_workspaces":
    "Every workspace package.json in the repo that declares this package, the root included; empty when none does.",
  "packages[].in_repo.declared_in_workspaces[].workspace":
    'Repo-relative directory of the declaring workspace, "." for the root.',
  "packages[].in_repo.declared_in_workspaces[].range":
    "The dependency spec exactly as written in that workspace's package.json.",
  "packages[].in_repo.files_using":
    'Repo-relative paths of source files anywhere in the repo, not only the current workspace, that import or require this package, so the path prefix shows the workspace (e.g. "packages/ui/src/toast.tsx"); empty when none do.',

  "packages[].cost":
    'What depending on `version` would add to this project, estimated from the lockfile with semver ranges: a dependency counts as reused when the lockfile has a version satisfying the range its parent requests, and a reused package\'s own dependencies are not counted; for kind "builtin" every count is zero; null when error is set.',
  "packages[].cost.total_packages":
    "Packages in `version`'s dependency tree on measured_on_platform, itself included, counted without deduplicating against the lockfile; compare new_packages for what would actually be added.",
  "packages[].cost.new_packages":
    'name@version entries the lockfile cannot satisfy, i.e. what would be added; empty when in_repo.version_change_from_installed is "same".',
  "packages[].cost.reused_packages":
    "name@version entries already in the lockfile (at the lockfile's version) that would be reused instead of added.",
  "packages[].cost.new_install_bytes":
    "On-disk size in bytes of new_packages as installed on measured_on_platform; 0 when new_packages is empty.",
  "packages[].cost.install_scripts":
    "Names of packages in the tree with preinstall, install, or postinstall scripts; empty when none.",
  "packages[].cost.native_binaries":
    "Names of packages that installed a native binary (.node, .dylib, .so, .dll, or binding.gyp) on measured_on_platform; empty when none.",
  "packages[].cost.other_platform_packages":
    "Number of optional OS/CPU-specific packages that would not install on measured_on_platform; they are excluded from every other cost field.",
  "packages[].cost.at_newest_installed":
    "What depending on in_repo.newest_installed instead of `version` would add, which is always zero packages because that version and its dependencies are already resolved; null when there is no project, the package is not installed, or newest_installed equals `version`.",
  "packages[].cost.at_newest_installed.version":
    "The installed version this is for, equal to in_repo.newest_installed.",
  "packages[].cost.at_newest_installed.new_packages":
    "name@version entries the lockfile cannot satisfy for that version; always empty.",
  "packages[].cost.at_newest_installed.new_install_bytes":
    "On-disk size in bytes of those new_packages; always 0.",

  "packages[].compatibility": `Facts from \`version\`'s package.json, compared with the project where noted; ${NULL_SECTION}.`,
  "packages[].compatibility.module_format":
    'Module system `version` ships: "esm", "cjs", or "dual" (both).',
  "packages[].compatibility.types_source":
    'Where TypeScript types come from: "bundled" in the package, "definitely_typed" (a separate @types package, see types_package), or "none".',
  "packages[].compatibility.types_package":
    'The @types package spec (e.g. "@types/luxon@3.7.6") when types_source is "definitely_typed", else null; it is not counted in any cost field.',
  "packages[].compatibility.engines":
    'package.json engines of `version`, verbatim, as runtime name to range (e.g. {"node": ">=18", "bun": ">=1.1"}); empty when not declared.',
  "packages[].compatibility.engine_satisfied":
    "Whether project.runtime_range is within engines[project.runtime]; null when either side is unknown (no project, no runtime_range, or no engines entry for that runtime), so null does not mean incompatible.",
  "packages[].compatibility.peer_dependencies":
    "Peer dependencies `version` declares; empty when none.",
  "packages[].compatibility.peer_dependencies[].name": "Peer package name.",
  "packages[].compatibility.peer_dependencies[].range":
    "Range `version` requires for the peer, verbatim.",
  "packages[].compatibility.peer_dependencies[].optional":
    "true when peerDependenciesMeta marks the peer optional.",
  "packages[].compatibility.peer_dependencies[].installed":
    "Highest version of the peer in the lockfile; null when it is absent or there is no project.",
  "packages[].compatibility.peer_dependencies[].satisfied_by_lockfile":
    "true when installed satisfies range; false when it does not or the peer is not installed; null when there is no project.",
  "packages[].compatibility.license":
    "License of `version` as declared in package.json; null when not declared.",
  "packages[].compatibility.licenses_in_tree":
    "Distinct licenses across `version`'s dependency tree, its own included.",

  "packages[].maintenance": `Release and repository activity; npm fields are always set, GitHub fields are ${GITHUB_NULL}; ${NULL_SECTION}.`,
  "packages[].maintenance.deprecated":
    "npm deprecation message for `version`, verbatim; null when not deprecated.",
  "packages[].maintenance.published_at": "ISO 8601 time `version` was published to npm.",
  "packages[].maintenance.days_since_release": "Whole days from published_at to generated_at.",
  "packages[].maintenance.stable_releases_last_year":
    "Number of non-prerelease versions published in the year before generated_at.",
  "packages[].maintenance.prerelease_tags_ahead":
    'Non-latest dist-tags pointing to a version newer than `version`, as "tag=version" (e.g. "next=5.0.0-beta.1"); empty when none.',
  "packages[].maintenance.provenance":
    "Whether `version` was published with npm provenance (a signed link to its source commit and build).",
  "packages[].maintenance.weekly_downloads":
    "npm downloads in the last 7 days, including installs as a transitive dependency; null when the downloads API failed.",
  "packages[].maintenance.repository": `Source repository URL; ${GITHUB_NULL}.`,
  "packages[].maintenance.archived": `Whether the GitHub repository is archived (read-only); ${GITHUB_NULL}.`,
  "packages[].maintenance.last_commit_at": `ISO 8601 time of the latest commit on the default branch; ${GITHUB_NULL}.`,
  "packages[].maintenance.commits_last_year": `Commits on the default branch in the 365 days before generated_at, bots included; ${GITHUB_NULL}.`,

  "packages[].security": `Vulnerability advisories from OSV; ${NULL_SECTION}.`,
  "packages[].security.advisories":
    "Every published advisory for this package, affecting any version; use affects_version and affects_installed_versions to see which apply here; empty when none.",
  "packages[].security.advisories[].id": 'OSV id, e.g. "GHSA-xxxx-xxxx-xxxx".',
  "packages[].security.advisories[].summary": "One-line summary as published; null when none.",
  "packages[].security.advisories[].severity":
    'Severity as published (e.g. "HIGH", "MODERATE"); null when none was published.',
  "packages[].security.advisories[].affected_ranges":
    'Affected version ranges as published, e.g. ">=0 <4.0.10".',
  "packages[].security.advisories[].fixed_in":
    "Versions that fix the advisory, as published; empty when no fix is published.",
  "packages[].security.advisories[].affects_version": "Whether `version` is in affected_ranges.",
  "packages[].security.advisories[].affects_installed_versions":
    "Which of in_repo.installed_versions are in affected_ranges; empty when none are, the package is not installed, or there is no project.",
  "packages[].security.dependency_vulnerabilities":
    'Advisories affecting other packages in `version`\'s dependency tree, as "name@version:ID"; the package itself is covered by advisories; empty when none.',
};

export type SchemaDocument = {
  schema_version: typeof SCHEMA_VERSION;
  fields: Record<string, string>;
};

/** What `depfit --schema` prints. */
export function schemaDocument(): SchemaDocument {
  return { schema_version: SCHEMA_VERSION, fields: FIELD_DESCRIPTIONS };
}

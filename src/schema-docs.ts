import { SCHEMA_VERSION } from "./report.ts";

/**
 * One sentence per JSON path of `Report`, for agents reading the JSON (`depfit --schema`).
 * Paths use "." for object keys and "[]" for array items. Containers that can be null are
 * documented too, so a null section is explained where it appears.
 * Keep in sync with src/report.ts; test/schema-docs.test.ts checks the paths.
 */

const GITHUB_NULL = "null when repository is null or GitHub data is unavailable";
const NULL_SECTION = 'null when error is set or kind is "builtin"';

const BUNDLE_CODES =
  'UNRESOLVED_IMPORT (an import, often a Node built-in, does not resolve for the browser), MISSING_EXPORT (an imported name is not exported), IMPORT_OUTSIDE_BUNDLE (the output still imports a module that is neither one of its chunks nor an external peer, such as import("https://…") or a computed import(), so that code would load at runtime and is not in the bytes), NO_ENTRY (the package has no root entry point), NON_JS_IMPORT (Vite emitted a file besides JS, such as CSS, a large asset or wasm, or built a worker, inline or not; what Vite inlines into the JS is counted, and files loaded by a path at runtime are not), PEER_IN_BUNDLE (code from a peer dependency was bundled, imported through an alias), TOOLCHAIN_MISMATCH (the installed Vite or rolldown is not the version depfit was evaluated with), BUNDLER_ERROR (the build process failed), or another bundler error code';
const WHOLE_NULL = `null when the whole build is unmeasurable, with the reason in unavailable as one "bundle: <CODE> [names]" entry per code, listing the first three names and counting the rest: ${BUNDLE_CODES}`;

export const FIELD_DESCRIPTIONS: Record<string, string> = {
  schema_version:
    "Version of this report format; it changes when a field is renamed, removed, or changes meaning.",
  generated_at:
    "ISO 8601 UTC time the report was collected; every relative value (days, last week, last year) is measured back from it.",
  measured_on_platform:
    'OS and CPU (e.g. "darwin-arm64") where install sizes, native binaries, and other-platform packages were measured; other platforms install different optional packages.',
  project:
    "The repo found from --cwd upwards; null when no package.json or lockfile was found or reading the project failed (see packages[].unavailable), in which case every packages[].in_repo is null.",
  "project.root": "Absolute path of the project root.",
  "project.workspace":
    "Absolute path of the workspace containing --cwd that the comparison is for; equals project.root in single-package repos.",
  "project.lockfile":
    "File name of the lockfile every in_repo and cost comparison is made against; null when the project has no lockfile, so nothing counts as already installed.",
  "project.packages_in_lockfile": "Number of distinct package names in the lockfile.",
  "project.module_type":
    'Module system of the workspace package.json: "module" or "commonjs" (its default when `type` is absent).',
  "project.runtime":
    'Runtime the workspace targets: "cloudflare-workers" when it has a wrangler config (wrangler.toml, wrangler.json, or wrangler.jsonc) or depends on wrangler, else "bun" when a bun lockfile, @types/bun or bun-types, engines.bun, or a bun packageManager indicate it, otherwise "node"; null when there is no project signal at all.',
  "project.browser_signals":
    'What makes the workspace a browser workspace, from its own package.json and directory only: UI runtimes and web app frameworks in dependencies or devDependencies (react-dom, preact, vue, svelte, solid-js, @angular/core, lit, next, astro, nuxt, @sveltejs/kit, @remix-run/react, @tanstack/react-start, gatsby), "index.html" when the workspace directory has one, and "browser" when its package.json has a browser field; build tools such as vite or webpack do not count; packages[].bundle is measured only when this is non-empty.',
  "project.runtime_range":
    "Version range for project.runtime from .nvmrc, .node-version, .bun-version, or package.json engines; null when none of them sets one, and always null for cloudflare-workers.",

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
    'The npm latest dist-tag, for comparison with `version`, which may be higher (a declared prerelease) or lower (an older requested range); null when error is set, kind is "builtin", or the package has no latest tag.',
  "packages[].description": "The package's npm description, verbatim; null when it has none.",
  "packages[].keywords": "The package's npm keywords, verbatim; empty when it has none.",
  "packages[].error":
    "Why the spec could not be resolved at all, in which case in_repo, cost, compatibility, maintenance, security, and bundle are all null; null on success.",
  "packages[].unavailable":
    'Data sources that failed or were skipped, e.g. "github: no token", and why bundle facts are null or incomplete, as entries starting with "bundle: " (see packages[].bundle and its fields); fields fed by a listed source are null, not zero, except lists, which are empty; empty when every source answered.',

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
    'What depending on `version` would add to this project, estimated from the lockfile with semver ranges: a dependency counts as reused when the lockfile has a version satisfying the range its parent requests, and a reused package\'s own dependencies are not counted; for kind "builtin" every count is zero; null when error is set or the isolated install failed (see unavailable).',
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
    "Names of packages that installed a native binary (.node, .dylib, .so, .dll) or a binding.gyp build file on measured_on_platform, empty when none; browser JavaScript cannot directly load native addons or shared libraries, though a listed package may also provide a separate browser implementation.",
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
    'Where TypeScript types come from: "bundled" in the package, "definitely_typed" (a separate @types package, see types_package), or "none" (also when the @types lookup failed, see unavailable).',
  "packages[].compatibility.types_package":
    'The @types package spec (e.g. "@types/luxon@3.7.6") when types_source is "definitely_typed", else null; it is not counted in any cost field.',
  "packages[].compatibility.engines":
    'package.json engines of `version`, verbatim, as runtime name to range (e.g. {"node": ">=18", "bun": ">=1.1"}); empty when not declared.',
  "packages[].compatibility.engine_satisfied":
    "Whether the lowest version project.runtime_range allows satisfies engines[project.runtime]; null when either side is unknown (no project, no runtime_range, or no valid engines entry for that runtime), so null does not mean incompatible.",
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
    'Distinct licenses across `version`\'s installed dependency tree, its own included, with "UNKNOWN" for packages that declare none; empty when the isolated install failed.',

  "packages[].maintenance": `Release and repository activity; npm registry fields are always set, weekly_downloads is null when the downloads API failed, and GitHub fields are ${GITHUB_NULL}; ${NULL_SECTION}.`,
  "packages[].maintenance.deprecated":
    "npm deprecation message for `version`, verbatim; null when not deprecated.",
  "packages[].maintenance.published_at": "ISO 8601 time `version` was published to npm.",
  "packages[].maintenance.days_since_release": "Whole days from published_at to generated_at.",
  "packages[].maintenance.stable_releases_last_year":
    "Number of non-prerelease versions published in the year before generated_at.",
  "packages[].maintenance.prerelease_tags_ahead":
    'Non-latest dist-tags pointing to a version newer than latest_version, as "tag=version" (e.g. "next=5.0.0-beta.1"); empty when none.',
  "packages[].maintenance.provenance":
    "Whether `version` was published with npm provenance (a signed link to its source commit and build).",
  "packages[].maintenance.weekly_downloads":
    "npm downloads in the last 7 days, including installs as a transitive dependency; null when the downloads API failed.",
  "packages[].maintenance.repository":
    'GitHub "owner/repo" parsed from package.json repository; null when it names no GitHub repository.',
  "packages[].maintenance.archived": `Whether the GitHub repository is archived (read-only); ${GITHUB_NULL}.`,
  "packages[].maintenance.last_commit_at": `ISO 8601 time of the latest commit on the default branch; ${GITHUB_NULL}.`,
  "packages[].maintenance.commits_last_year": `All commits on the default branch in the 365 days before generated_at; ${GITHUB_NULL}.`,

  "packages[].security":
    'Vulnerability advisories from OSV; null when error is set, kind is "builtin", or the OSV query for the package failed.',
  "packages[].security.advisories":
    "Every non-withdrawn advisory for this package, affecting any version, newest first; use affects_version and affects_installed_versions to see which apply here; empty when none.",
  "packages[].security.advisories[].id": 'OSV id, e.g. "GHSA-xxxx-xxxx-xxxx".',
  "packages[].security.advisories[].summary": "One-line summary as published; null when none.",
  "packages[].security.advisories[].severity":
    'Severity as published (e.g. "HIGH", "MODERATE"); null when none was published.',
  "packages[].security.advisories[].affected_ranges":
    'Affected version ranges built from the published OSV events, e.g. ">=0 <4.0.10", or "=x.y.z" entries when only explicit versions are published.',
  "packages[].security.advisories[].fixed_in":
    "Versions that fix the advisory, as published; empty when no fix is published.",
  "packages[].security.advisories[].affects_version": "Whether `version` is in affected_ranges.",
  "packages[].security.advisories[].affects_installed_versions":
    "Which of in_repo.installed_versions are in affected_ranges; empty when none are, the package is not installed, or there is no project.",
  "packages[].security.dependency_vulnerabilities":
    'Advisories affecting other packages in `version`\'s dependency tree, as "name@version:ID"; the package itself is covered by advisories; empty when none, or when the install or this lookup failed (see unavailable).',

  "packages[].bundle":
    'Browser bundle facts for the root entry point (".") of `version`, measured two ways from its isolated install, each number a standalone `vite build` (Vite\'s production defaults, no project config) of one named import: the whole entry point, and each export alone; neither is this project\'s own usage or the marginal cost given what it already bundles, and real usage of a few exports usually lies between the single-export median and the whole; subpaths such as "pkg/core" and framework entry points such as "pkg/react" are not measured; an app\'s own plugins, aliases or settings can change the bytes, and other bundlers and minifiers can emit different sizes, by a factor of two or more, and on small bundles by about 1 KB of their own wrapper code; the bytes Vite emits, not a claim that the code runs in a browser; null when project.browser_signals is empty ("bundle: skipped, no browser signal in workspace" in unavailable), error is set, kind is "builtin", the isolated install failed, or the measuring process could not start ("bundle: BUNDLER_ERROR <message>").',
  "packages[].bundle.bundler":
    'The bundler that measured the bytes, with its engine, e.g. "vite@8.3.4 (rolldown@1.2.14)".',
  "packages[].bundle.target": 'Runtime the bundles are built for; always "browser".',
  "packages[].bundle.entry_point":
    'The entry point every number in this section measures; always ".", the package root (`import ... from "<name>"`).',
  "packages[].bundle.whole_eager_js_min_bytes": `Minified JS bytes loaded up front by \`import * as m from "<name>"\` with every export kept: the entry chunk plus every chunk it imports statically, with external_packages left out; this is the whole root entry point, the most an app importing only the root could ship from it; ${WHOLE_NULL}.`,
  "packages[].bundle.whole_eager_js_gzip9_bytes": `The same eager chunks of the whole build, each gzipped at level 9 and summed (each chunk is a separate transfer); ${WHOLE_NULL}.`,
  "packages[].bundle.whole_lazy_js_min_bytes": `Minified JS bytes of the whole build's chunks loaded only through dynamic import(), each counted once and never included in the eager fields; 0 when there are none; ${WHOLE_NULL}.`,
  "packages[].bundle.whole_lazy_js_gzip9_bytes": `The same lazy chunks, each gzipped at level 9 and summed; 0 when there are none; ${WHOLE_NULL}.`,
  "packages[].bundle.exports":
    'Number of exports of the root entry point: the names the bundler resolves for `export * from "<name>"`, plus "default" when it resolves; a CommonJS package usually resolves to "default" alone, and type-only exports are not counted; null when the names could not be listed (the reason is in unavailable).',
  "packages[].bundle.exports_measured":
    'How many of `exports` were built alone (`import { <export> as v } from "<name>"`, kept) and passed every check; for the rest, unavailable has one entry per cause: a code the whole build already reports covers them, and exports that fail for any other code are counted in one "bundle: <n> exports unmeasurable (<codes>)" entry listing only those other codes (codes as for the whole build); null when exports is null or exports is over 1000, in which case they were not built ("bundle: EXPORT_LIMIT <count>" in unavailable).',
  "packages[].bundle.single_export_median_eager_js_gzip9_bytes":
    "Median, over the measured exports, of one export's eager JS gzip -9 bytes when it is the only import, each in its own build, rounded to whole bytes; it describes a typical single export, not any app's usage: many exports are small helpers, and one export can pull in most of the package; null when exports_measured is 0 or null.",
  "packages[].bundle.external_packages":
    "Peer dependencies of `version` (optional ones too, types-only @types/* peers excluded), and their subpaths, left out of every bundle byte field; their own cost is in cost and compatibility.peer_dependencies; empty when it has none.",
};

export type SchemaDocument = {
  schema_version: typeof SCHEMA_VERSION;
  fields: Record<string, string>;
};

/** What `depfit --schema` prints. */
export function schemaDocument(): SchemaDocument {
  return { schema_version: SCHEMA_VERSION, fields: FIELD_DESCRIPTIONS };
}

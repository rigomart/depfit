/**
 * Hand-written schema v2 Report fixtures. Numbers come from real probe runs: zod/valibot/yup
 * compared in an npm project, sharp in a bun workspace that already has sharp@0.34.5 through next.
 */
import type { Maintenance, PackageReport, ProjectInfo, Report } from "../src/report.ts";

export const GENERATED_AT = "2026-10-10T23:00:00.000Z";
export const PLATFORM = "darwin-arm64";

export const npmProject: ProjectInfo = {
  root: "/home/dev/mcp-server",
  workspace: "/home/dev/mcp-server",
  lockfile: "package-lock.json",
  packages_in_lockfile: 92,
  module_type: "module",
  runtime: "node",
  runtime_range: ">=20",
};

export const bunProject: ProjectInfo = {
  root: "/home/dev/site",
  workspace: "/home/dev/site/apps/web",
  lockfile: "bun.lock",
  packages_in_lockfile: 412,
  module_type: "module",
  runtime: "bun",
  runtime_range: null,
};

export const zod: PackageReport = {
  requested: "zod",
  name: "zod",
  version: "4.6.5",
  description:
    "TypeScript-first schema declaration and validation library with static type inference",
  keywords: ["typescript", "schema", "validation", "type", "inference"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: ["4.6.5"],
    newest_installed: "4.6.5",
    version_change_from_installed: "same",
    pulled_in_by: ["@modelcontextprotocol/sdk", "zod-to-json-schema"],
    in_package_json: null,
    files_using: ["src/server.ts"],
  },
  cost: {
    total_packages: 1,
    new_packages: [],
    reused_packages: ["zod@4.6.5"],
    new_install_bytes: 0,
    install_scripts: [],
    native_binaries: [],
    other_platform_packages: 0,
    bundle: {
      gzip_bytes_browser_full_import: 92557,
      min_bytes_browser_full_import: 457239,
      gzip_bytes_node_full_import: 92557,
      browser_compatible: true,
      browser_named_exports: 168,
      unresolved_imports: [],
      errors: [],
    },
  },
  compatibility: {
    module_format: "dual",
    side_effects_free: false,
    types_source: "bundled",
    types_package: null,
    engines: {},
    engine_satisfied: null,
    peer_dependencies: [],
    license: "MIT",
    licenses_in_tree: ["MIT"],
  },
  maintenance: {
    deprecated: null,
    published_at: "2026-09-13T23:25:14.644Z",
    days_since_release: 27,
    first_published_at: "2020-03-07T21:19:15.387Z",
    stable_releases_last_year: 25,
    prerelease_tags_ahead: [],
    npm_maintainers: 1,
    publishers_recent: ["GitHub Actions"],
    provenance: true,
    weekly_downloads: 334432403,
    downloads_change_ratio_90d: 0.46,
    repository: "https://github.com/colinhacks/zod",
    archived: false,
    stars: 44084,
    last_commit_at: "2026-10-10T00:09:22Z",
    commits_last_90d: 323,
    commits_last_year: 598,
    sampled_commits: 100,
    sampled_commits_by_bots: 3,
    human_committers: 4,
    top_human_committer: "colinhacks",
    top_human_committer_share: 0.97,
    merged_prs_by_others_share: 0.2,
    open_issues: 67,
    open_prs: 18,
    issues_median_days_to_close: 1.9,
  },
  security: {
    advisories: [
      {
        id: "GHSA-m95q-7qp3-xv42",
        summary: "Zod denial of service vulnerability",
        severity: "MODERATE",
        affected_ranges: [">=0 <3.22.3"],
        fixed_in: ["3.22.3"],
        affects_version: false,
        affects_newest_installed: false,
      },
    ],
    dependency_vulnerabilities: [],
  },
};

export const valibot: PackageReport = {
  requested: "valibot",
  name: "valibot",
  version: "1.5.0",
  description: "The modular and type safe schema library for validating structural data",
  keywords: [
    "modular",
    "typescript",
    "schema",
    "validation",
    "parsing",
    "bundle-size",
    "type-safe",
  ],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: [],
    newest_installed: null,
    version_change_from_installed: null,
    pulled_in_by: [],
    in_package_json: null,
    files_using: [],
  },
  cost: {
    total_packages: 1,
    new_packages: ["valibot@1.5.0"],
    reused_packages: [],
    new_install_bytes: 1865457,
    install_scripts: [],
    native_binaries: [],
    other_platform_packages: 0,
    bundle: {
      gzip_bytes_browser_full_import: 15393,
      min_bytes_browser_full_import: 85130,
      gzip_bytes_node_full_import: 15393,
      browser_compatible: true,
      browser_named_exports: 712,
      unresolved_imports: [],
      errors: [],
    },
  },
  compatibility: {
    module_format: "dual",
    side_effects_free: true,
    types_source: "bundled",
    types_package: null,
    engines: {},
    engine_satisfied: null,
    peer_dependencies: [
      {
        name: "typescript",
        range: ">=5",
        optional: true,
        installed: "5.9.3",
        satisfied_by_lockfile: true,
      },
    ],
    license: "MIT",
    licenses_in_tree: ["MIT"],
  },
  maintenance: {
    deprecated: null,
    published_at: "2026-09-09T12:58:23.503Z",
    days_since_release: 31,
    first_published_at: "2023-07-12T15:15:55.457Z",
    stable_releases_last_year: 7,
    prerelease_tags_ahead: [],
    npm_maintainers: 1,
    publishers_recent: ["fabian-hiller", "GitHub Actions"],
    provenance: true,
    weekly_downloads: 22193314,
    downloads_change_ratio_90d: 0.595,
    repository: "https://github.com/open-circle/valibot",
    archived: false,
    stars: 9032,
    last_commit_at: "2026-10-09T11:26:05Z",
    commits_last_90d: 61,
    commits_last_year: 458,
    sampled_commits: 100,
    sampled_commits_by_bots: 14,
    human_committers: 23,
    top_human_committer: "fabian-hiller",
    top_human_committer_share: 0.43,
    merged_prs_by_others_share: 0.6,
    open_issues: 94,
    open_prs: 121,
    issues_median_days_to_close: 25.6,
  },
  security: {
    advisories: [
      {
        id: "GHSA-vqpr-j7v3-hqw9",
        summary: "Valibot has a ReDoS vulnerability in `EMOJI_REGEX`",
        severity: "HIGH",
        affected_ranges: [">=0.31.0 <1.2.0"],
        fixed_in: ["1.2.0"],
        affects_version: false,
        affects_newest_installed: null,
      },
    ],
    dependency_vulnerabilities: [],
  },
};

export const yup: PackageReport = {
  requested: "yup",
  name: "yup",
  version: "1.7.1",
  description: "Dead simple Object schema validation",
  keywords: ["validation", "schema", "object"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: [],
    newest_installed: null,
    version_change_from_installed: null,
    pulled_in_by: [],
    in_package_json: null,
    files_using: [],
  },
  cost: {
    total_packages: 5,
    new_packages: [
      "property-expr@2.0.6",
      "tiny-case@1.0.3",
      "toposort@2.0.2",
      "type-fest@2.19.0",
      "yup@1.7.1",
    ],
    reused_packages: [],
    new_install_bytes: 504652,
    install_scripts: [],
    native_binaries: [],
    other_platform_packages: 0,
    bundle: {
      gzip_bytes_browser_full_import: 14142,
      min_bytes_browser_full_import: 44751,
      gzip_bytes_node_full_import: 14186,
      browser_compatible: true,
      browser_named_exports: 31,
      unresolved_imports: [],
      errors: [],
    },
  },
  compatibility: {
    module_format: "dual",
    side_effects_free: false,
    types_source: "bundled",
    types_package: null,
    engines: {},
    engine_satisfied: null,
    peer_dependencies: [],
    license: "MIT",
    licenses_in_tree: ["MIT", "(MIT OR CC0-1.0)"],
  },
  maintenance: {
    deprecated: null,
    published_at: "2025-09-21T13:59:55.107Z",
    days_since_release: 384,
    first_published_at: "2014-10-18T15:33:17.295Z",
    stable_releases_last_year: 0,
    prerelease_tags_ahead: [],
    npm_maintainers: 1,
    publishers_recent: ["monastic.panic"],
    provenance: false,
    weekly_downloads: 12468182,
    downloads_change_ratio_90d: 0.065,
    repository: "https://github.com/jquense/yup",
    archived: false,
    stars: 23657,
    last_commit_at: "2025-09-22T13:43:22Z",
    commits_last_90d: 0,
    commits_last_year: 0,
    sampled_commits: 0,
    sampled_commits_by_bots: 0,
    human_committers: 0,
    top_human_committer: null,
    top_human_committer_share: null,
    merged_prs_by_others_share: null,
    open_issues: 165,
    open_prs: 91,
    issues_median_days_to_close: 5.9,
  },
  security: { advisories: [], dependency_vulnerabilities: [] },
};

/**
 * Bun workspace with sharp@0.34.5 already installed via next; latest is 0.35.5. The browser
 * build needs Node built-ins, so only the Node size is known.
 */
export const sharp: PackageReport = {
  requested: "sharp",
  name: "sharp",
  version: "0.35.5",
  description:
    "High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images",
  keywords: ["jpeg", "png", "webp", "avif", "tiff", "gif", "svg", "dzi", "image", "resize"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: ["0.34.5"],
    newest_installed: "0.34.5",
    version_change_from_installed: "minor",
    pulled_in_by: ["next"],
    in_package_json: null,
    files_using: [],
  },
  cost: {
    total_packages: 6,
    new_packages: [
      "@img/sharp-darwin-arm64@0.35.5",
      "@img/sharp-libvips-darwin-arm64@1.3.0",
      "sharp@0.35.5",
    ],
    reused_packages: ["@img/colour@1.0.0", "detect-libc@2.1.2", "semver@7.7.3"],
    new_install_bytes: 16912345,
    install_scripts: ["sharp"],
    native_binaries: ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"],
    other_platform_packages: 25,
    bundle: {
      gzip_bytes_browser_full_import: null,
      min_bytes_browser_full_import: null,
      gzip_bytes_node_full_import: 39335,
      browser_compatible: false,
      browser_named_exports: null,
      unresolved_imports: [],
      errors: ['browser: Could not resolve "child_process" (Node built-in)'],
    },
  },
  compatibility: {
    module_format: "dual",
    side_effects_free: false,
    types_source: "bundled",
    types_package: null,
    engines: { node: ">=20.9.0" },
    engine_satisfied: null,
    peer_dependencies: [],
    license: "Apache-2.0",
    licenses_in_tree: ["Apache-2.0", "LGPL-3.0-or-later", "MIT"],
  },
  maintenance: {
    deprecated: null,
    published_at: "2026-09-27T13:46:24.509Z",
    days_since_release: 13,
    first_published_at: "2013-08-19T09:01:15.000Z",
    stable_releases_last_year: 7,
    prerelease_tags_ahead: [],
    npm_maintainers: 1,
    publishers_recent: ["GitHub Actions"],
    provenance: true,
    weekly_downloads: 115326409,
    downloads_change_ratio_90d: 0.447,
    repository: "https://github.com/lovell/sharp",
    archived: false,
    stars: 32746,
    last_commit_at: "2026-10-09T11:07:42Z",
    commits_last_90d: 61,
    commits_last_year: 238,
    sampled_commits: 100,
    sampled_commits_by_bots: 25,
    human_committers: 11,
    top_human_committer: "lovell",
    top_human_committer_share: 0.72,
    merged_prs_by_others_share: 1,
    open_issues: 113,
    open_prs: 5,
    issues_median_days_to_close: 8.6,
  },
  security: {
    advisories: [
      {
        id: "GHSA-54xq-cgqr-rpm3",
        summary: "sharp vulnerability in libwebp dependency CVE-2023-4863",
        severity: "HIGH",
        affected_ranges: [">=0 <0.32.6"],
        fixed_in: ["0.32.6"],
        affects_version: false,
        affects_newest_installed: false,
      },
    ],
    dependency_vulnerabilities: [],
  },
};

const noGithub: Pick<
  Maintenance,
  | "repository"
  | "archived"
  | "stars"
  | "last_commit_at"
  | "commits_last_90d"
  | "commits_last_year"
  | "sampled_commits"
  | "sampled_commits_by_bots"
  | "human_committers"
  | "top_human_committer"
  | "top_human_committer_share"
  | "merged_prs_by_others_share"
  | "open_issues"
  | "open_prs"
  | "issues_median_days_to_close"
> = {
  repository: null,
  archived: null,
  stars: null,
  last_commit_at: null,
  commits_last_90d: null,
  commits_last_year: null,
  sampled_commits: null,
  sampled_commits_by_bots: null,
  human_committers: null,
  top_human_committer: null,
  top_human_committer_share: null,
  merged_prs_by_others_share: null,
  open_issues: null,
  open_prs: null,
  issues_median_days_to_close: null,
};

/** yup as collected without a GitHub token: every GitHub fact is null. */
export const yupWithoutGithub: PackageReport = {
  ...yup,
  unavailable: ["github: no token"],
  maintenance: yup.maintenance === null ? null : { ...yup.maintenance, ...noGithub },
};

/** A spec that did not resolve on npm: every section is null. */
export const missing: PackageReport = {
  requested: "zodd@^3",
  name: "zodd",
  version: null,
  description: null,
  keywords: [],
  error: "npm: package not found (404)",
  unavailable: [],
  in_repo: null,
  cost: null,
  compatibility: null,
  maintenance: null,
  security: null,
};

export function report(
  packages: PackageReport[],
  project: ProjectInfo | null = npmProject,
): Report {
  return {
    schema_version: 2,
    generated_at: GENERATED_AT,
    measured_on_platform: PLATFORM,
    project,
    packages,
  };
}

/** A package as collected outside any project: no in-repo facts, nothing compared to a lockfile. */
export function withoutProject(pkg: PackageReport): PackageReport {
  return {
    ...pkg,
    in_repo: null,
    compatibility: pkg.compatibility && {
      ...pkg.compatibility,
      engine_satisfied: null,
      peer_dependencies: pkg.compatibility.peer_dependencies.map((peer) => ({
        ...peer,
        installed: null,
        satisfied_by_lockfile: null,
      })),
    },
    security: pkg.security && {
      ...pkg.security,
      advisories: pkg.security.advisories.map((a) => ({ ...a, affects_newest_installed: null })),
    },
  };
}

/** zod and valibot collected with no package.json or lockfile above --cwd. */
export const noProjectReport: Report = report([zod, valibot].map(withoutProject), null);

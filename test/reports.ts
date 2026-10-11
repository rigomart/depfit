/**
 * Hand-written schema v4 Report fixtures. Numbers come from real probe runs: zod/valibot/yup
 * compared in an npm project, sharp and sonner in a bun monorepo workspace, node-pty in a node
 * project with a pnpm lockfile, and node:sqlite, better-sqlite3, and @libsql/client from the
 * root of a bun monorepo (desktop app plus server).
 */
import {
  type Maintenance,
  type PackageReport,
  type ProjectInfo,
  type Report,
  SCHEMA_VERSION,
} from "../src/report.ts";

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

/** A single-package node app with a pnpm lockfile that targets Node 22.13+. */
export const nodeProject: ProjectInfo = {
  root: "/home/dev/termhub",
  workspace: "/home/dev/termhub",
  lockfile: "pnpm-lock.yaml",
  packages_in_lockfile: 248,
  module_type: "module",
  runtime: "node",
  runtime_range: ">=22.13",
};

/** Root of a bun monorepo with apps/desktop, apps/server, and apps/web; compared from the root. */
export const monorepoProject: ProjectInfo = {
  root: "/home/dev/monorepo",
  workspace: "/home/dev/monorepo",
  lockfile: "bun.lock",
  packages_in_lockfile: 1184,
  module_type: "module",
  runtime: "bun",
  runtime_range: "1.3.0",
};

/** A worker workspace with a wrangler config, inside the bun monorepo. */
export const workersProject: ProjectInfo = {
  root: "/home/dev/site",
  workspace: "/home/dev/site/apps/worker",
  lockfile: "bun.lock",
  packages_in_lockfile: 412,
  module_type: "module",
  runtime: "cloudflare-workers",
  runtime_range: null,
};

export const zod: PackageReport = {
  requested: "zod",
  kind: "npm",
  name: "zod",
  version: "4.6.5",
  version_source: "latest",
  latest_version: "4.6.5",
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
    declared_in_workspaces: [],
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
    at_newest_installed: null,
  },
  compatibility: {
    module_format: "dual",
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
    stable_releases_last_year: 25,
    prerelease_tags_ahead: [],
    provenance: true,
    weekly_downloads: 334432403,
    repository: "https://github.com/colinhacks/zod",
    archived: false,
    last_commit_at: "2026-10-10T00:09:22Z",
    commits_last_year: 598,
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
        affects_installed_versions: [],
      },
    ],
    dependency_vulnerabilities: [],
  },
};

export const valibot: PackageReport = {
  requested: "valibot",
  kind: "npm",
  name: "valibot",
  version: "1.5.0",
  version_source: "latest",
  latest_version: "1.5.0",
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
    declared_in_workspaces: [],
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
    at_newest_installed: null,
  },
  compatibility: {
    module_format: "dual",
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
    stable_releases_last_year: 7,
    prerelease_tags_ahead: [],
    provenance: true,
    weekly_downloads: 22193314,
    repository: "https://github.com/open-circle/valibot",
    archived: false,
    last_commit_at: "2026-10-09T11:26:05Z",
    commits_last_year: 458,
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
        affects_installed_versions: [],
      },
    ],
    dependency_vulnerabilities: [],
  },
};

export const yup: PackageReport = {
  requested: "yup",
  kind: "npm",
  name: "yup",
  version: "1.7.1",
  version_source: "latest",
  latest_version: "1.7.1",
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
    declared_in_workspaces: [],
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
    at_newest_installed: null,
  },
  compatibility: {
    module_format: "dual",
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
    stable_releases_last_year: 0,
    prerelease_tags_ahead: [],
    provenance: false,
    weekly_downloads: 12468182,
    repository: "https://github.com/jquense/yup",
    archived: false,
    last_commit_at: "2025-09-22T13:43:22Z",
    commits_last_year: 0,
  },
  security: { advisories: [], dependency_vulnerabilities: [] },
};

/**
 * Bun workspace with sharp@0.34.5 already installed via next; latest is 0.35.5. The native build
 * ships one package per platform.
 */
export const sharp: PackageReport = {
  requested: "sharp",
  kind: "npm",
  name: "sharp",
  version: "0.35.5",
  version_source: "latest",
  latest_version: "0.35.5",
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
    declared_in_workspaces: [],
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
    at_newest_installed: { version: "0.34.5", new_packages: [], new_install_bytes: 0 },
  },
  compatibility: {
    module_format: "dual",
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
    stable_releases_last_year: 7,
    prerelease_tags_ahead: [],
    provenance: true,
    weekly_downloads: 115326409,
    repository: "https://github.com/lovell/sharp",
    archived: false,
    last_commit_at: "2026-10-09T11:07:42Z",
    commits_last_year: 238,
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
        affects_installed_versions: [],
      },
    ],
    dependency_vulnerabilities: [],
  },
};

const noGithub: Pick<
  Maintenance,
  "repository" | "archived" | "last_commit_at" | "commits_last_year"
> = { repository: null, archived: null, last_commit_at: null, commits_last_year: null };

/** yup as collected without a GitHub token: every GitHub fact is null. */
export const yupWithoutGithub: PackageReport = {
  ...yup,
  unavailable: ["github: no token"],
  maintenance: yup.maintenance === null ? null : { ...yup.maintenance, ...noGithub },
};

/** A spec that did not resolve on npm: every section is null. */
export const missing: PackageReport = {
  requested: "zodd@^3",
  kind: "npm",
  name: "zodd",
  version: null,
  version_source: null,
  latest_version: null,
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

/** The node:sqlite builtin, imported by the desktop app and the server of the bun monorepo. */
export const nodeSqlite: PackageReport = {
  requested: "node:sqlite",
  kind: "builtin",
  name: "node:sqlite",
  version: null,
  version_source: null,
  latest_version: null,
  description: null,
  keywords: [],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: [],
    newest_installed: null,
    version_change_from_installed: null,
    pulled_in_by: [],
    in_package_json: null,
    declared_in_workspaces: [],
    files_using: [
      "apps/server/src/persistence/sqlite.ts",
      "apps/server/src/persistence/migrations.ts",
      "apps/server/src/persistence/threads.ts",
      "apps/server/src/persistence/messages.ts",
      "apps/server/src/persistence/projects.ts",
      "apps/server/src/persistence/checkpoints.ts",
      "apps/server/src/persistence/sqlite.test.ts",
      "apps/desktop/src/state/store.ts",
      "apps/desktop/src/state/migrate.ts",
      "apps/desktop/src/state/store.test.ts",
    ],
  },
  cost: {
    total_packages: 0,
    new_packages: [],
    reused_packages: [],
    new_install_bytes: 0,
    install_scripts: [],
    native_binaries: [],
    other_platform_packages: 0,
    at_newest_installed: null,
  },
  compatibility: null,
  maintenance: null,
  security: null,
};

/**
 * better-sqlite3 next to node:sqlite: not installed, but prebuild-install is already in the
 * lockfile, so only the package and bindings are new. The size is mostly the vendored SQLite.
 */
export const betterSqlite3: PackageReport = {
  requested: "better-sqlite3",
  kind: "npm",
  name: "better-sqlite3",
  version: "12.4.1",
  version_source: "latest",
  latest_version: "12.4.1",
  description: "The fastest and simplest library for SQLite in Node.js.",
  keywords: ["sql", "sqlite", "sqlite3", "transactions", "user-defined functions", "database"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: [],
    newest_installed: null,
    version_change_from_installed: null,
    pulled_in_by: [],
    in_package_json: null,
    declared_in_workspaces: [],
    files_using: [],
  },
  cost: {
    total_packages: 38,
    new_packages: ["better-sqlite3@12.4.1", "bindings@1.5.0"],
    reused_packages: ["file-uri-to-path@1.0.0", "prebuild-install@7.1.3"],
    new_install_bytes: 27712408,
    install_scripts: ["better-sqlite3"],
    native_binaries: ["better-sqlite3"],
    other_platform_packages: 0,
    at_newest_installed: null,
  },
  compatibility: {
    module_format: "cjs",
    types_source: "definitely_typed",
    types_package: "@types/better-sqlite3@7.6.13",
    engines: { node: "20.x || 22.x || 23.x || 24.x" },
    engine_satisfied: null,
    peer_dependencies: [],
    license: "MIT",
    licenses_in_tree: ["MIT", "ISC", "(BSD-2-Clause OR MIT OR Apache-2.0)"],
  },
  maintenance: {
    deprecated: null,
    published_at: "2026-08-21T16:02:44.118Z",
    days_since_release: 50,
    stable_releases_last_year: 9,
    prerelease_tags_ahead: [],
    provenance: false,
    weekly_downloads: 4318226,
    repository: "git+https://github.com/WiseLibs/better-sqlite3.git",
    archived: false,
    last_commit_at: "2026-09-30T18:14:09Z",
    commits_last_year: 71,
  },
  security: { advisories: [], dependency_vulnerabilities: [] },
};

/**
 * @libsql/client is already resolved at 0.17.3 through alchemy and drizzle-orm, but nothing
 * declares it; latest is 0.18.0. The native libsql build ships one package per platform.
 */
export const libsqlClient: PackageReport = {
  requested: "@libsql/client",
  kind: "npm",
  name: "@libsql/client",
  version: "0.18.0",
  version_source: "latest",
  latest_version: "0.18.0",
  description: "libSQL driver for TypeScript and JavaScript",
  keywords: ["libsql", "database", "sqlite", "serverless", "vercel", "netlify", "lambda"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: ["0.17.3"],
    newest_installed: "0.17.3",
    version_change_from_installed: "minor",
    pulled_in_by: ["alchemy", "drizzle-orm"],
    in_package_json: null,
    declared_in_workspaces: [],
    files_using: [],
  },
  cost: {
    total_packages: 12,
    new_packages: [
      "@libsql/client@0.18.0",
      "@libsql/core@0.18.0",
      "@libsql/darwin-arm64@0.6.2",
      "@libsql/hrana-client@0.9.0",
      "libsql@0.6.2",
    ],
    reused_packages: [
      "@libsql/isomorphic-ws@0.1.5",
      "@neon-rs/load@0.0.4",
      "detect-libc@2.1.2",
      "js-base64@3.7.8",
      "promise-limit@2.7.0",
      "ws@8.18.3",
    ],
    new_install_bytes: 10234561,
    install_scripts: [],
    native_binaries: ["@libsql/darwin-arm64"],
    other_platform_packages: 8,
    at_newest_installed: { version: "0.17.3", new_packages: [], new_install_bytes: 0 },
  },
  compatibility: {
    module_format: "dual",
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
    published_at: "2026-09-24T09:12:37.401Z",
    days_since_release: 16,
    stable_releases_last_year: 11,
    prerelease_tags_ahead: [],
    provenance: false,
    weekly_downloads: 1412336,
    repository: "git+https://github.com/tursodatabase/libsql-client-ts.git",
    archived: false,
    last_commit_at: "2026-10-06T14:20:11Z",
    commits_last_year: 87,
  },
  security: { advisories: [], dependency_vulnerabilities: [] },
};

/**
 * node-pty declared as ^1.2.0-beta.15 in the root package.json: the declared range picks the
 * installed prerelease, which is newer than npm latest (1.1.0).
 */
export const nodePty: PackageReport = {
  requested: "node-pty",
  kind: "npm",
  name: "node-pty",
  version: "1.2.0-beta.15",
  version_source: "declared_range",
  latest_version: "1.1.0",
  description: "Fork pseudoterminals in Node.JS",
  keywords: ["pty", "tty", "terminal", "pseudoterminal", "forkpty", "openpty"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: ["1.2.0-beta.15"],
    newest_installed: "1.2.0-beta.15",
    version_change_from_installed: "same",
    pulled_in_by: [],
    in_package_json: "^1.2.0-beta.15",
    declared_in_workspaces: [{ workspace: ".", range: "^1.2.0-beta.15" }],
    files_using: ["src/pty/session.ts", "src/pty/spawn.ts", "test/pty.test.ts"],
  },
  cost: {
    total_packages: 2,
    new_packages: [],
    reused_packages: ["node-addon-api@7.1.1", "node-pty@1.2.0-beta.15"],
    new_install_bytes: 0,
    install_scripts: ["node-pty"],
    native_binaries: ["node-pty"],
    other_platform_packages: 0,
    at_newest_installed: null,
  },
  compatibility: {
    module_format: "cjs",
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
    published_at: "2026-07-02T09:41:57.302Z",
    days_since_release: 100,
    stable_releases_last_year: 1,
    prerelease_tags_ahead: [],
    provenance: true,
    weekly_downloads: 1873455,
    repository: "git+https://github.com/microsoft/node-pty.git",
    archived: false,
    last_commit_at: "2026-10-03T07:55:12Z",
    commits_last_year: 96,
  },
  security: {
    advisories: [
      {
        id: "GHSA-h3fx-xjm2-mqcr",
        summary: "node-pty is vulnerable to a race condition when spawning processes on Windows",
        severity: "LOW",
        affected_ranges: [">=0 <1.0.0"],
        fixed_in: ["1.0.0"],
        affects_version: false,
        affects_installed_versions: [],
      },
    ],
    dependency_vulnerabilities: [],
  },
};

/**
 * sonner compared from apps/web: only packages/ui declares it, yet apps/web imports it too.
 * Not declared in the current workspace, so the version is npm latest.
 */
export const sonner: PackageReport = {
  requested: "sonner",
  kind: "npm",
  name: "sonner",
  version: "2.0.7",
  version_source: "latest",
  latest_version: "2.0.7",
  description: "An opinionated toast component for React.",
  keywords: ["react", "notifications", "toast", "snackbar", "message"],
  error: null,
  unavailable: [],
  in_repo: {
    installed_versions: ["2.0.7"],
    newest_installed: "2.0.7",
    version_change_from_installed: "same",
    pulled_in_by: [],
    in_package_json: null,
    declared_in_workspaces: [{ workspace: "packages/ui", range: "^2.0.7" }],
    files_using: [
      "packages/ui/src/toaster.tsx",
      "apps/web/src/app/layout.tsx",
      "packages/ui/src/toast.ts",
      "packages/ui/src/index.ts",
    ],
  },
  cost: {
    total_packages: 1,
    new_packages: [],
    reused_packages: ["sonner@2.0.7"],
    new_install_bytes: 0,
    install_scripts: [],
    native_binaries: [],
    other_platform_packages: 0,
    at_newest_installed: null,
  },
  compatibility: {
    module_format: "dual",
    types_source: "bundled",
    types_package: null,
    engines: {},
    engine_satisfied: null,
    peer_dependencies: [
      {
        name: "react",
        range: "^18.0.0 || ^19.0.0 || ^19.0.0-rc",
        optional: false,
        installed: "19.2.3",
        satisfied_by_lockfile: true,
      },
      {
        name: "react-dom",
        range: "^18.0.0 || ^19.0.0 || ^19.0.0-rc",
        optional: false,
        installed: "19.2.3",
        satisfied_by_lockfile: true,
      },
    ],
    license: "MIT",
    licenses_in_tree: ["MIT"],
  },
  maintenance: {
    deprecated: null,
    published_at: "2025-08-02T13:22:41.716Z",
    days_since_release: 434,
    stable_releases_last_year: 0,
    prerelease_tags_ahead: [],
    provenance: false,
    weekly_downloads: 14012557,
    repository: "git+https://github.com/emilkowalski/sonner.git",
    archived: false,
    last_commit_at: "2026-06-18T10:03:27Z",
    commits_last_year: 17,
  },
  security: { advisories: [], dependency_vulnerabilities: [] },
};

export function report(
  packages: PackageReport[],
  project: ProjectInfo | null = npmProject,
): Report {
  return {
    schema_version: SCHEMA_VERSION,
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
    cost: pkg.cost && { ...pkg.cost, at_newest_installed: null },
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
      advisories: pkg.security.advisories.map((a) => ({ ...a, affects_installed_versions: [] })),
    },
  };
}

/** zod and valibot collected with no package.json or lockfile above --cwd. */
export const noProjectReport: Report = report([zod, valibot].map(withoutProject), null);

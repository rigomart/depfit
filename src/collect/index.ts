import { join, resolve } from "node:path";
import {
  type Bundle,
  type Collect,
  type Compatibility,
  type Cost,
  type InRepo,
  type Maintenance,
  type PackageReport,
  SCHEMA_VERSION,
  type Security,
} from "../report.ts";
import type { Cache } from "./cache.ts";
import { cachedInstallFacts, withCacheFallback } from "./cached-install.ts";
import {
  atNewestInstalled,
  builtinReport,
  declaredRange,
  dependenciesOf,
  engineSatisfied,
  inRepoFacts,
  licensesInTree,
  peerDependencyFacts,
  type TreePackage,
  treeCost,
} from "./facts.ts";
import { type GithubFacts, githubFacts, githubToken, NO_GITHUB } from "./github.ts";
import { withIsolatedInstall } from "./install.ts";
import { advisories, dependencyVulnerabilities } from "./osv.ts";
import { loadProject, type Project } from "./project.ts";
import {
  githubRepo,
  keywordsOf,
  licenseOf,
  moduleFormat,
  npmMaintenance,
  parseSpec,
  type Resolved,
  resolvePackage,
  typesPackage,
  weeklyDownloads,
} from "./registry.ts";
import type { ReportMeasurement } from "./root-entry.ts";
import { manifestDeclaresTypes, shipsTypes } from "./types.ts";
import { asRecord, asString, asStringRecord, errorMessage, reasonText } from "./util.ts";
import type { VitePool } from "./vite-pool.ts";

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

type Context = {
  project: Project | null;
  projectError: string | null;
  /** Why bundle facts are not measured, as its `unavailable` entry; null when they are. */
  bundleSkipped: string | null;
  /** Resolved once, on first use. */
  token: () => Promise<string | null>;
  /**
   * The run's pool of Vite workers, created on first use; null when bundle facts are skipped, so
   * the module that runs Vite is never imported then.
   */
  bundlePool: (() => Promise<VitePool>) | null;
  /** depfit's cache, opened once per call; null with `--no-cache` or when it cannot be used. */
  cache: Promise<Cache | null>;
};

function failedReport(spec: string, name: string, error: string, unavailable: string[]) {
  return {
    requested: spec,
    kind: parseSpec(spec).kind,
    name,
    version: null,
    version_source: null,
    latest_version: null,
    description: null,
    keywords: [],
    error,
    unavailable,
    in_repo: null,
    cost: null,
    compatibility: null,
    maintenance: null,
    security: null,
    bundle: null,
  } satisfies PackageReport;
}

async function githubSection(
  manifest: Record<string, unknown>,
  token: () => Promise<string | null>,
): Promise<Settled<GithubFacts> & { repository: string | null }> {
  const repo = githubRepo(manifest);
  if (!repo) return { ok: false, error: "no GitHub repository in package.json", repository: null };
  const repository = `${repo.owner}/${repo.repo}`;
  const auth = await token();
  if (!auth) return { ok: false, error: "no token", repository };
  return { ...(await settle(githubFacts(repo.owner, repo.repo, auth))), repository };
}

type BundleFacts = { bundle: Bundle | null; reasons: string[] };

const bundlerError = (error: unknown): BundleFacts => ({
  bundle: null,
  reasons: [`bundle: BUNDLER_ERROR ${reasonText(errorMessage(error))}`],
});

/**
 * The module that runs Vite is imported only here, so a workspace with no browser signal never
 * loads Vite or rolldown.
 */
const rootEntry = () => import("./root-entry.ts");

/** Starts one worker as an install starts, so Vite's start-up overlaps the install. */
function warmDuringInstall(pool: () => Promise<VitePool>): void {
  void pool().then(
    (started) => started.warm(),
    () => {},
  );
}

type TreeFacts = {
  tree: TreePackage[];
  vulnerabilities: Settled<string[]>;
  bundledTypes: boolean;
  bundle: BundleFacts | null;
};

/**
 * Everything that needs the isolated install of the candidate itself, or its cached facts. A cache
 * that fails once open gives way to the uncached path (`withCacheFallback`); an npm failure is the
 * install's own.
 */
async function treeFacts(resolved: Resolved, context: Context): Promise<TreeFacts> {
  const cache = await context.cache;
  if (!cache) return isolatedTreeFacts(resolved, context.bundlePool);
  return withCacheFallback(
    () => cachedTreeFacts(resolved, context.bundlePool, cache),
    () => isolatedTreeFacts(resolved, context.bundlePool),
  );
}

async function cachedTreeFacts(
  resolved: Resolved,
  pool: (() => Promise<VitePool>) | null,
  cache: Cache,
): Promise<TreeFacts> {
  const vulnerabilitiesOf = (tree: TreePackage[]) =>
    settle(dependencyVulnerabilities(dependenciesOf(resolved.name, tree)));
  let vulnerabilities: Promise<Settled<string[]>> | null = null;
  let measureError: unknown = null;
  const module = pool ? await rootEntry() : null;
  const facts = await cachedInstallFacts(cache, resolved, {
    measure:
      module && pool
        ? async (dir) => {
            try {
              return await module.measureForReport(dir, resolved.name, resolved.manifest, {
                pool: await pool(),
              });
            } catch (error) {
              // Never fails the install: cost and the other install facts stay as they are.
              measureError = error;
              return null;
            }
          }
        : null,
    cacheable: (measurement) => module?.cacheableMeasurement(measurement) ?? false,
    onInstall: pool ? () => warmDuringInstall(pool) : undefined,
    onTree: (tree) => {
      vulnerabilities = vulnerabilitiesOf(tree);
    },
  });
  const bundle = module ? await bundleOf(module, facts.measurement, measureError) : null;
  return {
    tree: facts.tree,
    vulnerabilities: await (vulnerabilities ?? vulnerabilitiesOf(facts.tree)),
    bundledTypes: facts.bundledTypes,
    bundle,
  };
}

async function bundleOf(
  module: Awaited<ReturnType<typeof rootEntry>>,
  measurement: ReportMeasurement | null,
  error: unknown,
): Promise<BundleFacts> {
  if (!measurement) return bundlerError(error ?? new Error("not measured"));
  try {
    const { bundlerName } = await import("./bundle.ts");
    return module.reportFacts(measurement, await bundlerName());
  } catch (failure) {
    return bundlerError(failure);
  }
}

/** `--no-cache`, or a cache that cannot be used: today's isolated install, deleted afterwards. */
async function isolatedTreeFacts(
  resolved: Resolved,
  pool: (() => Promise<VitePool>) | null,
): Promise<TreeFacts> {
  if (pool) warmDuringInstall(pool);
  return withIsolatedInstall(resolved.name, resolved.version, async ({ dir, tree }) => {
    const [vulnerabilities, bundledTypes, bundle] = await Promise.all([
      settle(dependencyVulnerabilities(dependenciesOf(resolved.name, tree))),
      shipsTypes(join(dir, "node_modules", resolved.name), resolved.manifest),
      pool
        ? (async (): Promise<BundleFacts> => {
            try {
              const module = await rootEntry();
              return await module.rootEntryBundle(dir, resolved.name, resolved.manifest, {
                pool: await pool(),
              });
            } catch (error) {
              return bundlerError(error);
            }
          })()
        : null,
    ]);
    return { tree, vulnerabilities, bundledTypes, bundle };
  });
}

function typesFacts(
  types: Settled<string | null> | null,
): Pick<Compatibility, "types_source" | "types_package"> {
  if (types === null) return { types_source: "bundled", types_package: null };
  if (types.ok && types.value)
    return { types_source: "definitely_typed", types_package: types.value };
  return { types_source: "none", types_package: null };
}

async function collectPackage(spec: string, context: Context): Promise<PackageReport> {
  const { project } = context;
  const candidate = parseSpec(spec);
  const unavailable: string[] = [];
  if (context.projectError) unavailable.push(`project: ${context.projectError}`);
  if (candidate.kind === "builtin") return builtinReport(spec, project, unavailable);

  const { name, range } = candidate;
  const declared = project ? declaredRange(project, name) : null;
  const resolution = await settle(resolvePackage(name, range, declared));
  if (!resolution.ok) return failedReport(spec, name, resolution.error, unavailable);
  const resolved = resolution.value;
  const { version, manifest } = resolved;

  const peers = asStringRecord(manifest.peerDependencies);
  const optionalPeers = new Set(
    Object.entries(asRecord(manifest.peerDependenciesMeta))
      .filter(([, meta]) => asRecord(meta).optional === true)
      .map(([peer]) => peer),
  );
  const inRepo: InRepo | null = project ? inRepoFacts(project, name, version) : null;

  // DefinitelyTyped is looked up alongside the install, and ignored if the install ships types.
  const declaresTypes = manifestDeclaresTypes(manifest);
  const [install, ownAdvisories, github, downloadStats, typesLookup] = await Promise.all([
    settle(treeFacts(resolved, context)),
    settle(advisories(name, version, inRepo?.installed_versions ?? [])),
    githubSection(manifest, context.token),
    settle(weeklyDownloads(name)),
    declaresTypes ? null : settle(typesPackage(name)),
  ]);
  const types = declaresTypes || (install.ok && install.value.bundledTypes) ? null : typesLookup;

  if (!install.ok) unavailable.push(`install: ${install.error}`);
  if (!ownAdvisories.ok) unavailable.push(`osv: ${ownAdvisories.error}`);
  if (install.ok && !install.value.vulnerabilities.ok) {
    unavailable.push(`osv dependencies: ${install.value.vulnerabilities.error}`);
  }
  if (!github.ok) unavailable.push(`github: ${github.error}`);
  if (!downloadStats.ok) unavailable.push(`downloads: ${downloadStats.error}`);
  if (types && !types.ok) unavailable.push(`types: ${types.error}`);
  const bundle = install.ok ? install.value.bundle : null;
  if (context.bundleSkipped) unavailable.push(context.bundleSkipped);
  if (bundle) unavailable.push(...bundle.reasons);

  const tree: TreePackage[] | null = install.ok ? install.value.tree : null;
  const runtime = project?.info.runtime ?? null;
  const engines = asStringRecord(manifest.engines);

  const compatibility: Compatibility = {
    module_format: moduleFormat(manifest),
    ...typesFacts(types),
    engines,
    engine_satisfied: runtime
      ? engineSatisfied(project?.info.runtime_range ?? null, engines[runtime] ?? null)
      : null,
    peer_dependencies: peerDependencyFacts(peers, optionalPeers, project?.lock ?? null),
    license: licenseOf(manifest),
    licenses_in_tree: tree ? licensesInTree(tree) : [],
  };

  const maintenance: Maintenance = {
    ...npmMaintenance(resolved),
    weekly_downloads: downloadStats.ok ? downloadStats.value : null,
    repository: github.repository,
    ...(github.ok ? github.value : NO_GITHUB),
  };

  const security: Security | null = ownAdvisories.ok
    ? {
        advisories: ownAdvisories.value,
        dependency_vulnerabilities:
          install.ok && install.value.vulnerabilities.ok ? install.value.vulnerabilities.value : [],
      }
    : null;

  const cost: Cost | null = install.ok
    ? {
        ...treeCost(project?.lock ?? null, resolved, install.value.tree),
        at_newest_installed: atNewestInstalled(version, inRepo?.newest_installed ?? null),
      }
    : null;

  return {
    requested: spec,
    kind: "npm",
    name,
    version,
    version_source: resolved.version_source,
    latest_version: resolved.latest_version,
    description: asString(manifest.description),
    keywords: keywordsOf(manifest),
    error: null,
    unavailable,
    in_repo: inRepo,
    cost,
    compatibility,
    maintenance,
    security,
    bundle: bundle?.bundle ?? null,
  };
}

/**
 * Bundle facts are measured only in a workspace with a browser signal. `DEPFIT_BUNDLE=0` turns
 * them off everywhere: an eval-only switch (eval/bundle/SPEC.md gate E).
 */
export function bundleSkipped(
  project: Pick<Project, "info"> | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.DEPFIT_BUNDLE === "0") return "bundle: skipped, DEPFIT_BUNDLE=0";
  if (!project?.info.browser_signals.length)
    return "bundle: skipped, no browser signal in workspace";
  return null;
}

export const collect: Collect = async (specs, { cwd, cache: useCache = true }) => {
  const generatedAt = new Date().toISOString();
  const loaded = await settle(loadProject(resolve(cwd)));
  const project = loaded.ok ? loaded.value : null;

  let token: Promise<string | null> | undefined;
  const skipped = bundleSkipped(project);
  const npmCandidates = specs.filter((spec) => parseSpec(spec).kind === "npm").length;
  let pool: Promise<VitePool> | undefined;
  const cache: Promise<Cache | null> =
    useCache && npmCandidates > 0
      ? import("./cache.ts").then(({ openCache }) => openCache())
      : Promise.resolve(null);
  const context: Context = {
    project,
    projectError: loaded.ok ? null : loaded.error,
    bundleSkipped: skipped,
    token: () => {
      token ??= githubToken();
      return token;
    },
    bundlePool:
      skipped === null
        ? () => {
            pool ??= import("./vite-pool.ts").then(({ bundleWorkers, createVitePool }) =>
              createVitePool({ size: bundleWorkers(npmCandidates) }),
            );
            return pool;
          }
        : null,
    cache,
  };

  let packages: PackageReport[];
  try {
    packages = await Promise.all(
      specs.map(async (spec) => {
        try {
          return await collectPackage(spec, context);
        } catch (error) {
          return failedReport(spec, parseSpec(spec).name, errorMessage(error), []);
        }
      }),
    );
  } finally {
    if (pool)
      await pool.then(
        (started) => started.close(),
        () => {},
      );
    await cache.then((opened) => opened?.evict()).catch(() => {});
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    measured_on_platform: `${process.platform}-${process.arch}`,
    project: project?.info ?? null,
    packages,
  };
};

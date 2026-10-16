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
import {
  type BundleOutcome,
  bundleEntry,
  bundleReasons,
  bundlerName,
  externalPackages,
} from "./bundle.ts";
import { type BundleEntry, normalizedSnippet } from "./bundle-entry.ts";
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
import { manifestDeclaresTypes, shipsTypes } from "./types.ts";
import { asRecord, asString, asStringRecord, errorMessage } from "./util.ts";

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
  /** Resolved once, on first use. */
  token: () => Promise<string | null>;
  bundleEntries: ReadonlyMap<string, BundleEntry>;
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

/**
 * Everything that needs the isolated install of the candidate itself. The bundle is built from
 * the same install, so peers stay installed (and in `cost`); they are external only in the bundler.
 */
async function treeFacts(resolved: Resolved, entry: BundleEntry | null, externals: string[]) {
  return withIsolatedInstall(resolved.name, resolved.version, async ({ dir, tree }) => {
    const [vulnerabilities, bundledTypes, bundle] = await Promise.all([
      settle(dependencyVulnerabilities(dependenciesOf(resolved.name, tree))),
      shipsTypes(join(dir, "node_modules", resolved.name), resolved.manifest),
      entry ? settle(bundleEntry(dir, entry, externals)) : null,
    ]);
    return { tree, vulnerabilities, bundledTypes, bundle };
  });
}

/** `bundle` for a package bundling was requested for, and its `unavailable` entries. */
async function bundleSection(
  entry: BundleEntry,
  externals: string[],
  outcome: Settled<BundleOutcome> | null,
): Promise<{ bundle: Bundle; reasons: string[] }> {
  const bytes = outcome?.ok ? outcome.value.bytes : null;
  let reasons: string[] = [];
  if (outcome && !outcome.ok) reasons = [`bundle: BUNDLER_ERROR ${outcome.error}`];
  else if (outcome) reasons = bundleReasons(outcome.value.problems);
  const bundler = await settle(bundlerName());
  return {
    bundle: {
      bundler: bundler.ok ? bundler.value : "rolldown",
      target: "browser",
      entry: normalizedSnippet(entry),
      entry_source: "requested",
      eager_js_min_bytes: bytes?.eager_js_min_bytes ?? null,
      eager_js_gzip9_bytes: bytes?.eager_js_gzip9_bytes ?? null,
      lazy_js_min_bytes: bytes?.lazy_js_min_bytes ?? null,
      lazy_js_gzip9_bytes: bytes?.lazy_js_gzip9_bytes ?? null,
      external_packages: externals,
    },
    reasons,
  };
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
  const entry = context.bundleEntries.get(name) ?? null;
  const externals = externalPackages(manifest);
  const [install, ownAdvisories, github, downloadStats, typesLookup] = await Promise.all([
    settle(treeFacts(resolved, entry, externals)),
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
  const bundled = entry
    ? await bundleSection(entry, externals, install.ok ? install.value.bundle : null)
    : null;
  if (bundled) unavailable.push(...bundled.reasons);

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
    bundle: bundled?.bundle ?? null,
  };
}

export const collect: Collect = async (specs, { cwd, bundleEntries = new Map() }) => {
  const generatedAt = new Date().toISOString();
  const loaded = await settle(loadProject(resolve(cwd)));
  const project = loaded.ok ? loaded.value : null;

  let token: Promise<string | null> | undefined;
  const context: Context = {
    project,
    projectError: loaded.ok ? null : loaded.error,
    token: () => {
      token ??= githubToken();
      return token;
    },
    bundleEntries,
  };

  const packages = await Promise.all(
    specs.map(async (spec) => {
      try {
        return await collectPackage(spec, context);
      } catch (error) {
        return failedReport(spec, parseSpec(spec).name, errorMessage(error), []);
      }
    }),
  );

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    measured_on_platform: `${process.platform}-${process.arch}`,
    project: project?.info ?? null,
    packages,
  };
};

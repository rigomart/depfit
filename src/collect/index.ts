import { resolve } from "node:path";
import {
  type Collect,
  type Compatibility,
  type Cost,
  type InRepo,
  type Maintenance,
  type PackageReport,
  SCHEMA_VERSION,
  type Security,
} from "../report.ts";
import { bundleFacts } from "./bundle.ts";
import {
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
  downloads,
  githubRepo,
  hasBundledTypes,
  keywordsOf,
  licenseOf,
  moduleFormat,
  npmMaintenance,
  parseSpec,
  type Resolved,
  resolvePackage,
  typesPackage,
} from "./registry.ts";
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
};

function failedReport(spec: string, name: string, error: string, unavailable: string[]) {
  return {
    requested: spec,
    name,
    version: null,
    description: null,
    keywords: [],
    error,
    unavailable,
    in_repo: null,
    cost: null,
    compatibility: null,
    maintenance: null,
    security: null,
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

/** Everything that needs the isolated install of the candidate itself. */
async function treeFacts(resolved: Resolved, peers: string[]) {
  return withIsolatedInstall(resolved.name, resolved.version, async ({ dir, tree }) => {
    const [bundle, vulnerabilities] = await Promise.all([
      bundleFacts(dir, resolved.name, peers),
      settle(dependencyVulnerabilities(dependenciesOf(resolved.name, tree))),
    ]);
    return { tree, bundle, vulnerabilities };
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
  const { name, range } = parseSpec(spec);
  const unavailable: string[] = [];
  if (context.projectError) unavailable.push(`project: ${context.projectError}`);

  const resolution = await settle(resolvePackage(name, range));
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

  const [install, ownAdvisories, github, downloadStats, types] = await Promise.all([
    settle(treeFacts(resolved, Object.keys(peers))),
    settle(advisories(name, version, inRepo?.newest_installed ?? null)),
    githubSection(manifest, context.token),
    settle(downloads(name)),
    hasBundledTypes(manifest) ? null : settle(typesPackage(name)),
  ]);

  if (!install.ok) unavailable.push(`install: ${install.error}`);
  if (!ownAdvisories.ok) unavailable.push(`osv: ${ownAdvisories.error}`);
  if (install.ok && !install.value.vulnerabilities.ok) {
    unavailable.push(`osv dependencies: ${install.value.vulnerabilities.error}`);
  }
  if (!github.ok) unavailable.push(`github: ${github.error}`);
  if (!downloadStats.ok) unavailable.push(`downloads: ${downloadStats.error}`);
  if (types && !types.ok) unavailable.push(`types: ${types.error}`);

  const tree: TreePackage[] | null = install.ok ? install.value.tree : null;
  const runtime = project?.info.runtime ?? null;
  const engines = asStringRecord(manifest.engines);

  const compatibility: Compatibility = {
    module_format: moduleFormat(manifest),
    side_effects_free: manifest.sideEffects === false,
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
    weekly_downloads: downloadStats.ok ? downloadStats.value.weekly_downloads : null,
    downloads_change_ratio_90d: downloadStats.ok
      ? downloadStats.value.downloads_change_ratio_90d
      : null,
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
        bundle: install.value.bundle,
      }
    : null;

  return {
    requested: spec,
    name,
    version,
    description: asString(manifest.description),
    keywords: keywordsOf(manifest),
    error: null,
    unavailable,
    in_repo: inRepo,
    cost,
    compatibility,
    maintenance,
    security,
  };
}

export const collect: Collect = async (specs, { cwd }) => {
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

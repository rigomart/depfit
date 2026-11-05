import {
  type BundleEntry,
  normalizedSnippet,
  prepareBundleEntries,
} from "../src/collect/bundle-entry.ts";
/**
 * Eval-only: measures import snippets (a probe's `bundle_entries`) with depfit's bundle engine, as
 * schema v5's removed `--bundle-entry` did, so real usage stays measurable as ground truth
 * (eval/bundle/SPEC.md, iteration 0). The CLI never calls this.
 */
import {
  bundleEntry,
  bundleReasons,
  bundlerName,
  externalPackages,
} from "../src/collect/bundle.ts";
import { withIsolatedInstall } from "../src/collect/install.ts";
import { resolvePackage } from "../src/collect/registry.ts";
import { errorMessage } from "../src/collect/util.ts";

/** One snippet's measurement, in schema v5's `packages[].bundle` shape plus its reasons. */
export type SnippetBundle = {
  name: string;
  version: string;
  bundler: string;
  target: "browser";
  /** The snippet that was measured, normalized. */
  entry: string;
  eager_js_min_bytes: number | null;
  eager_js_gzip9_bytes: number | null;
  lazy_js_min_bytes: number | null;
  lazy_js_gzip9_bytes: number | null;
  external_packages: string[];
  /** Why the bytes are null, as v5's `unavailable` entries ("bundle: <CODE> [names]"). */
  reasons: string[];
};

/** Validates snippets against the candidates' npm names; throws on an invalid snippet. */
export async function parseSnippets(
  snippets: string[],
  candidates: string[],
): Promise<Map<string, BundleEntry>> {
  const prepared = await prepareBundleEntries(snippets, candidates);
  if (!prepared.ok) throw new Error(prepared.message);
  return prepared.entries;
}

/**
 * Builds `entry` from an isolated install of name@version, with the package's peers external, the
 * same install and build the v5 CLI made.
 */
export async function measureSnippet(
  name: string,
  version: string,
  entry: BundleEntry,
): Promise<SnippetBundle> {
  const { manifest } = await resolvePackage(name, version, null);
  if (manifest.version !== version) throw new Error(`${name}@${version} not found on npm`);
  const externals = externalPackages(manifest);
  // An install failure throws; a build failure is a reason, as in v5.
  const { bytes, reasons } = await withIsolatedInstall(name, version, ({ dir }) =>
    bundleEntry(dir, entry, externals).then(
      (outcome) => ({ bytes: outcome.bytes, reasons: bundleReasons(outcome.problems) }),
      (error: unknown) => ({
        bytes: null,
        reasons: [`bundle: BUNDLER_ERROR ${errorMessage(error)}`],
      }),
    ),
  );
  return {
    name,
    version,
    bundler: await bundlerName(),
    target: "browser",
    entry: normalizedSnippet(entry),
    eager_js_min_bytes: bytes?.eager_js_min_bytes ?? null,
    eager_js_gzip9_bytes: bytes?.eager_js_gzip9_bytes ?? null,
    lazy_js_min_bytes: bytes?.lazy_js_min_bytes ?? null,
    lazy_js_gzip9_bytes: bytes?.lazy_js_gzip9_bytes ?? null,
    external_packages: externals,
    reasons,
  };
}

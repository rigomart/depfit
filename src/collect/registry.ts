/** npm registry and downloads API. */
import semver from "semver";
import type { Compatibility, Maintenance } from "../report.ts";
import { resolveAlias } from "./lockfile.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asStringRecord,
  DAY_MS,
  fetchJson,
  round,
  unique,
} from "./util.ts";

const REGISTRY = "https://registry.npmjs.org";

export type Manifest = Record<string, unknown>;

export type Resolved = {
  name: string;
  version: string;
  manifest: Manifest;
  packument: Record<string, unknown>;
} & VersionChoice;

export type VersionChoice = {
  version: string;
  version_source: "requested" | "declared_range" | "latest";
  /** The `latest` dist-tag, null when the packument has none. */
  latest_version: string | null;
};

export type NpmMaintenance = Pick<
  Maintenance,
  | "deprecated"
  | "published_at"
  | "days_since_release"
  | "first_published_at"
  | "stable_releases_last_year"
  | "prerelease_tags_ahead"
  | "npm_maintainers"
  | "publishers_recent"
  | "provenance"
>;

function encodeName(name: string) {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

export type Spec =
  | { kind: "builtin"; name: string }
  /** `range` is a semver range or dist-tag, null when the spec has none. */
  | { kind: "npm"; name: string; range: string | null };

/** "zod" -> no range, "zod@^3" -> range, "@a/b@next" -> dist-tag, "node:sqlite" -> builtin. */
export function parseSpec(spec: string): Spec {
  const trimmed = spec.trim();
  if (/^(?:node|bun):./.test(trimmed)) return { kind: "builtin", name: trimmed };
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    return { kind: "npm", name: trimmed.slice(0, at), range: trimmed.slice(at + 1) || null };
  }
  return { kind: "npm", name: trimmed, range: null };
}

/**
 * The version a dist-tag or range selects: the tagged version, else the highest published one
 * satisfying the range with npm's semantics (a prerelease matches only when the range has a
 * prerelease on the same major.minor.patch, e.g. ^1.2.0-beta.15 matches 1.2.0-beta.16).
 */
function matchVersion(published: string[], tags: Record<string, string>, range: string) {
  const tagged = tags[range];
  if (tagged && published.includes(tagged)) return tagged;
  return semver.maxSatisfying(published, range, { loose: true });
}

/**
 * An explicit range in the spec wins; else the range declared in the workspace package.json
 * (an `npm:` alias of the same package counts), when some published version satisfies it;
 * else the `latest` dist-tag. Throws when the package has no versions or `requested` matches none.
 */
export function chooseVersion(
  packument: Record<string, unknown>,
  name: string,
  requested: string | null,
  declared: string | null,
): VersionChoice {
  const published = Object.keys(asRecord(packument.versions));
  if (!published.length) throw new Error(`${name} not found on npm`);
  const tags = asStringRecord(packument["dist-tags"]);
  const latest = tags.latest && published.includes(tags.latest) ? tags.latest : null;

  if (requested !== null) {
    const version = matchVersion(published, tags, requested);
    if (!version) throw new Error(`no version of ${name} matches ${requested}`);
    return { version, version_source: "requested", latest_version: latest };
  }
  const alias = declared === null ? null : resolveAlias(name, declared);
  const fromDeclared =
    alias && alias.name === name ? matchVersion(published, tags, alias.range) : null;
  if (fromDeclared) {
    return { version: fromDeclared, version_source: "declared_range", latest_version: latest };
  }
  const version = latest ?? semver.maxSatisfying(published, "*");
  if (!version) throw new Error(`${name} has no latest version on npm`);
  return { version, version_source: "latest", latest_version: latest };
}

/** Fetches the packument and picks the version with chooseVersion. */
export async function resolvePackage(
  name: string,
  requested: string | null,
  declared: string | null,
): Promise<Resolved> {
  const packument = asRecord(await fetchJson(`${REGISTRY}/${encodeName(name)}`));
  const choice = chooseVersion(packument, name, requested, declared);
  const manifest = asRecord(asRecord(packument.versions)[choice.version]);
  return { name, ...choice, manifest, packument };
}

export function moduleFormat(manifest: Manifest): Compatibility["module_format"] {
  const exportsJson = JSON.stringify(manifest.exports ?? {});
  const isModule = manifest.type === "module";
  const hasImport = exportsJson.includes('"import"') || isModule || Boolean(manifest.module);
  const hasRequire =
    exportsJson.includes('"require"') ||
    (!isModule && Boolean(manifest.main ?? manifest.exports === undefined));
  if (hasImport && hasRequire) return "dual";
  return hasImport ? "esm" : "cjs";
}

/** "@types/x@1.2.3" when a DefinitelyTyped package exists, else null. */
export async function typesPackage(name: string): Promise<string | null> {
  const typesName = name.startsWith("@")
    ? `@types/${name.slice(1).replace("/", "__")}`
    : `@types/${name}`;
  const doc = asRecord(await fetchJson(`${REGISTRY}/${encodeName(typesName)}`));
  const latest = asStringRecord(doc["dist-tags"]).latest;
  return latest ? `${typesName}@${latest}` : null;
}

/** npm `keywords`; a few old packages publish a comma-separated string instead of an array. */
export function keywordsOf(manifest: Manifest): string[] {
  const { keywords } = manifest;
  if (typeof keywords === "string") return keywords ? [keywords] : [];
  return asStringArray(keywords);
}

export function licenseOf(manifest: Manifest): string | null {
  const license = manifest.license;
  if (typeof license === "string") return license;
  const type = asString(asRecord(license).type);
  if (type) return type;
  const legacy = asArray(manifest.licenses)
    .map((entry) => asString(asRecord(entry).type))
    .filter((entry) => entry !== null);
  return legacy.length ? legacy.join(" OR ") : null;
}

export function githubRepo(manifest: Manifest): { owner: string; repo: string } | null {
  const repository = manifest.repository;
  const raw = typeof repository === "string" ? repository : asString(asRecord(repository).url);
  if (!raw) return null;
  const match =
    raw.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/) ??
    raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

export function npmMaintenance(
  { version, manifest, packument }: Resolved,
  now = Date.now(),
): NpmMaintenance {
  const time = asStringRecord(packument.time);
  const versions = asRecord(packument.versions);
  const tags = asStringRecord(packument["dist-tags"]);

  const releases = Object.entries(time)
    .filter(([v]) => v in versions && semver.valid(v) && !semver.prerelease(v))
    .map(([v, at]) => ({ version: v, at: Date.parse(at) }))
    .sort((a, b) => a.at - b.at);

  const publishers = releases
    .slice(-10)
    .map((r) => asString(asRecord(asRecord(versions[r.version])._npmUser).name))
    .filter((name) => name !== null);

  const latest = tags.latest;
  const ahead = Object.entries(tags)
    .filter(
      ([tag, v]) =>
        tag !== "latest" &&
        latest &&
        semver.valid(v) &&
        semver.valid(latest) &&
        semver.gt(v, latest),
    )
    .map(([tag, v]) => `${tag}=${v}`);

  const publishedAt = time[version] ?? "";
  return {
    deprecated: asString(manifest.deprecated),
    published_at: publishedAt,
    days_since_release: publishedAt ? Math.floor((now - Date.parse(publishedAt)) / DAY_MS) : 0,
    first_published_at: time.created ?? "",
    stable_releases_last_year: releases.filter((r) => now - r.at < 365 * DAY_MS).length,
    prerelease_tags_ahead: ahead,
    npm_maintainers: asArray(packument.maintainers).length,
    publishers_recent: unique(publishers),
    provenance: Boolean(asRecord(asRecord(manifest.dist).attestations).provenance),
  };
}

export async function downloads(
  name: string,
): Promise<Pick<Maintenance, "weekly_downloads" | "downloads_change_ratio_90d">> {
  const data = asRecord(
    await fetchJson(`https://api.npmjs.org/downloads/range/last-year/${encodeName(name)}`),
  );
  const days = asArray(data.downloads).map((d) => asNumber(asRecord(d).downloads) ?? 0);
  if (!days.length) throw new Error("no download data");
  const sum = (from: number, to: number) =>
    days.slice(Math.max(0, from), Math.max(0, to)).reduce((acc, n) => acc + n, 0);
  const n = days.length;
  const last90 = sum(n - 90, n);
  const prior90 = sum(n - 180, n - 90);
  return {
    weekly_downloads: sum(n - 7, n),
    downloads_change_ratio_90d: prior90 ? round(last90 / prior90 - 1, 3) : null,
  };
}

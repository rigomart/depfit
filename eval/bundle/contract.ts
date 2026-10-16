/**
 * Gate E's contract comparison: a report without `--bundle-entry` against one with it, minus what
 * bundling may change and what is live, and minus only the fields of a network source that failed
 * in transit in either run.
 */
import { asArray, asRecord, asStringArray, isRecord } from "../../src/collect/util.ts";
import { packageOf } from "./harness.ts";

/** Live registry and GitHub counts that move between two runs of the same CLI. */
export const LIVE_MAINTENANCE = [
  "weekly_downloads",
  "days_since_release",
  "last_commit_at",
  "commits_last_year",
];

/**
 * An `unavailable` entry from a network source that failed in transit (rate limit, server error,
 * timeout). Such an entry, and the fields that source feeds, differ between two runs by chance.
 */
export const NETWORK_ENTRY =
  /^(osv|osv dependencies|github|downloads|types): .*(\b429\b|\b5\d\d\b|timed? ?out|timeout|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN)/i;

/**
 * The fields under `packages[]` each network source feeds (src/collect/index.ts). When a source
 * failed in transit in either run, these fields, and nothing else, may differ between the runs.
 */
const SOURCE_FIELDS: Record<string, string[][]> = {
  osv: [
    ["security", "advisories"],
    ["security", "dependency_vulnerabilities"],
  ],
  "osv dependencies": [["security", "dependency_vulnerabilities"]],
  github: [
    ["maintenance", "archived"],
    ["maintenance", "last_commit_at"],
    ["maintenance", "commits_last_year"],
  ],
  downloads: [["maintenance", "weekly_downloads"]],
  types: [
    ["compatibility", "types_source"],
    ["compatibility", "types_package"],
  ],
};

/** What an ignored value compares as. */
const IGNORED = "<ignored>";

/**
 * `record` with the value at `path` replaced by IGNORED, only where the key exists: a failed source
 * may change a value, never remove a key (round 4: missing keys were excused).
 */
function ignoredAt(record: Record<string, unknown>, path: string[]): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined || !(key in record)) return record;
  const value = record[key];
  if (!rest.length) return { ...record, [key]: IGNORED };
  return isRecord(value) ? { ...record, [key]: ignoredAt(value, rest) } : record;
}

/** The network source an `unavailable` entry says failed in transit, or null. */
const sourceOf = (entry: string) => NETWORK_ENTRY.exec(entry)?.[1]?.toLowerCase() ?? null;

/** Names of the network sources that failed in transit in a report. */
export const failedSources = (report: Record<string, unknown> | null) =>
  asStringArray(packageOf(report)?.unavailable).flatMap((entry) => sourceOf(entry) ?? []);

/**
 * The report minus everything a `--bundle-entry` run may legitimately change, or that is live.
 * With `failed` sources, also minus their `unavailable` entries and the fields they feed. A failed
 * osv lookup nulls the whole `security` section, so `security` is kept as a key either way.
 */
export function withoutBundle(
  report: Record<string, unknown> | null,
  failed: Set<string> = new Set(),
): Record<string, unknown> {
  const { generated_at, schema_version, packages, ...rest } = asRecord(report);
  const fed = [...failed].flatMap((source) => SOURCE_FIELDS[source] ?? []);
  return {
    ...rest,
    packages: asArray(packages).map((item) => {
      const { bundle, unavailable, maintenance, ...pkg } = asRecord(item);
      const others = asStringArray(unavailable).filter(
        (entry) => !entry.startsWith("bundle:") && !failed.has(sourceOf(entry) ?? ""),
      );
      // Live counts keep their key, so a missing key still differs; only the value is ignored.
      const stable = isRecord(maintenance)
        ? Object.fromEntries(
            Object.entries(maintenance).map(([key, value]) => [
              key,
              LIVE_MAINTENANCE.includes(key) ? IGNORED : value,
            ]),
          )
        : maintenance;
      let sections: Record<string, unknown> = { ...pkg, unavailable: others, maintenance: stable };
      // A failed osv lookup nulls the whole `security` section: compare it as a section with its
      // documented keys ignored, so a surviving section must still have every key (round 5).
      if (failed.has("osv") && "security" in sections && sections.security === null) {
        sections.security = { advisories: IGNORED, dependency_vulnerabilities: IGNORED };
      }
      for (const path of fed) sections = ignoredAt(sections, path);
      return sections;
    }),
  };
}

/** Where two JSON values first differ, and what each held there; null when equal. */
export type Diff = { path: string; without_bundle: unknown; with_bundle: unknown };

export function firstDiff(a: unknown, b: unknown, path = ""): Diff | null {
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const diff = firstDiff(a[key], b[key], path ? `${path}.${key}` : key);
      if (diff) return diff;
    }
    return null;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (const [i, item] of a.entries()) {
      const diff = firstDiff(item, b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? null
    : { path, without_bundle: a ?? null, with_bundle: b ?? null };
}

/**
 * Gate E's comparison of the run without `--bundle-entry` and one with it. `network` is true when
 * the difference disappears once the network sources that failed in either run (their
 * `unavailable` entries and only the fields they feed, SOURCE_FIELDS) are ignored: a flake, not a
 * contract leak. Any other difference, including a missing key or an unrelated null, still fails.
 */
export function compareContract(
  without: Record<string, unknown> | null,
  withBundle: Record<string, unknown> | null,
): { diff: Diff | null; network: boolean } {
  const diff = firstDiff(withoutBundle(without), withoutBundle(withBundle));
  if (!diff) return { diff, network: false };
  const failed = new Set([...failedSources(without), ...failedSources(withBundle)]);
  if (!failed.size) return { diff, network: false };
  const rest = firstDiff(withoutBundle(without, failed), withoutBundle(withBundle, failed));
  return { diff, network: !rest };
}

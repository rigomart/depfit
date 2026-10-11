/** OSV advisories for a package and its resolved tree. */
import semver from "semver";
import type { Advisory } from "../report.ts";
import { asArray, asRecord, asString, asStringArray, fetchWithRetry } from "./util.ts";

const OSV = "https://api.osv.dev/v1";
const BATCH_LIMIT = 1000;
const MAX_PAGES = 10;

type Query = { package: { name: string; ecosystem: "npm" }; version?: string; page_token?: string };

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(`${OSV}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OSV ${path} responded ${response.status}`);
  return asRecord(await response.json());
}

/** One affected interval from OSV events, e.g. { range: ">=0 <4.0.10", fixed: "4.0.10" }. */
type Interval = { range: string; fixed: string | null };

function intervals(events: unknown[]): Interval[] {
  const out: Interval[] = [];
  let start: string | null = null;
  for (const event of events.map(asRecord)) {
    const introduced = asString(event.introduced);
    const fixed = asString(event.fixed);
    const lastAffected = asString(event.last_affected);
    const limit = asString(event.limit);
    if (introduced !== null) {
      if (start !== null) out.push({ range: `>=${start}`, fixed: null });
      start = introduced;
    } else if (start !== null && (fixed ?? lastAffected ?? limit) !== null) {
      const end = fixed ? `<${fixed}` : lastAffected ? `<=${lastAffected}` : `<${limit}`;
      out.push({ range: `>=${start} ${end}`, fixed });
      start = null;
    }
  }
  if (start !== null) out.push({ range: `>=${start}`, fixed: null });
  return out;
}

function affects(version: string, ranges: string[], versions: string[]): boolean {
  if (versions.includes(version)) return true;
  return ranges.some((range) => semver.satisfies(version, range, { includePrerelease: true }));
}

/** Maps one OSV record to an Advisory for `name`, evaluated against `version` and every installed one. */
export function toAdvisory(
  record: Record<string, unknown>,
  name: string,
  version: string,
  installed: string[],
): Advisory {
  const affected = asArray(record.affected)
    .map(asRecord)
    .filter((entry) => {
      const pkg = asRecord(entry.package);
      return asString(pkg.ecosystem) === "npm" && asString(pkg.name) === name;
    });
  const spans = affected.flatMap((entry) =>
    asArray(entry.ranges)
      .map(asRecord)
      .filter((range) => range.type === "SEMVER" || range.type === "ECOSYSTEM")
      .flatMap((range) => intervals(asArray(range.events))),
  );
  const versions = affected.flatMap((entry) => asStringArray(entry.versions));
  const ranges = [...new Set(spans.map((span) => span.range))];
  // Ranges are what OSV publishes; a record with only an explicit version list shows those.
  const affectedRanges = ranges.length ? ranges : versions.map((v) => `=${v}`);

  return {
    id: asString(record.id) ?? "",
    summary: asString(record.summary),
    severity: asString(asRecord(record.database_specific).severity),
    affected_ranges: affectedRanges,
    fixed_in: [...new Set(spans.flatMap((span) => (span.fixed ? [span.fixed] : [])))],
    affects_version: affects(version, ranges, versions),
    affects_installed_versions: installed.filter((v) => affects(v, ranges, versions)),
  };
}

/** Every non-withdrawn OSV advisory for `name`, newest first. */
export async function advisories(
  name: string,
  version: string,
  installed: string[],
): Promise<Advisory[]> {
  const records: Array<Record<string, unknown>> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Query = { package: { name, ecosystem: "npm" } };
    if (pageToken) query.page_token = pageToken;
    const body = await post("query", query);
    records.push(...asArray(body.vulns).map(asRecord));
    pageToken = asString(body.next_page_token);
    if (!pageToken) break;
  }
  return records
    .filter((record) => !record.withdrawn)
    .sort(
      (a, b) =>
        (asString(b.published) ?? "").localeCompare(asString(a.published) ?? "") ||
        (asString(a.id) ?? "").localeCompare(asString(b.id) ?? ""),
    )
    .map((record) => toAdvisory(record, name, version, installed));
}

/** "name@version:ID" for every OSV hit among `packages`. */
export async function dependencyVulnerabilities(
  packages: Array<{ name: string; version: string }>,
): Promise<string[]> {
  const ids = [...new Map(packages.map((p) => [`${p.name}@${p.version}`, p])).values()];
  const hits: string[] = [];
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const chunk = ids.slice(i, i + BATCH_LIMIT);
    const body = await post("querybatch", {
      queries: chunk.map((p) => ({
        package: { name: p.name, ecosystem: "npm" },
        version: p.version,
      })),
    });
    asArray(body.results).forEach((result, j) => {
      const pkg = chunk[j];
      if (!pkg) return;
      for (const vuln of asArray(asRecord(result).vulns)) {
        const id = asString(asRecord(vuln).id);
        if (id) hits.push(`${pkg.name}@${pkg.version}:${id}`);
      }
    });
  }
  return [...new Set(hits)].sort();
}

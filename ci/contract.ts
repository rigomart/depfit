/**
 * The output contract of AGENTS.md ("Output rules"), checked on a live `--json` report: every field
 * is documented in `--schema`, every documented field is present (null when unknown, never a
 * missing key), each value has the JSON kind the typed fixtures in test/reports.ts give it, and
 * failed sources are listed in `unavailable`. Values themselves are not checked: they are live.
 */
import { asArray, asRecord, asString, asStringArray, isRecord } from "../src/collect/util.ts";

export type Kind = "null" | "string" | "number" | "boolean" | "array" | "object";

export function kindOf(value: unknown): Kind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

/** JSON paths as `--schema` writes them: "." between keys, "[]" for array items. */
const childPath = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** Each documented container path to the keys documented directly under it. */
function documentedKeys(fields: Record<string, string>): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  for (const path of Object.keys(fields)) {
    const dot = path.lastIndexOf(".");
    const parent = dot === -1 ? "" : path.slice(0, dot);
    const key = dot === -1 ? path : path.slice(dot + 1);
    keys.set(parent, (keys.get(parent) ?? new Set()).add(key));
  }
  return keys;
}

/**
 * The JSON kinds each path takes in a set of sample values (array items under "<path>[]").
 * A documented object with no documented keys (a map such as compatibility.engines) is a leaf.
 */
export function kindsOf(
  samples: unknown[],
  fields: Record<string, string>,
): Map<string, Set<Kind>> {
  const keys = documentedKeys(fields);
  const kinds = new Map<string, Set<Kind>>();
  const visit = (value: unknown, path: string) => {
    kinds.set(path, (kinds.get(path) ?? new Set()).add(kindOf(value)));
    if (Array.isArray(value)) for (const item of value) visit(item, `${path}[]`);
    else if (isRecord(value) && keys.has(path)) {
      for (const [key, child] of Object.entries(value)) visit(child, childPath(path, key));
    }
  };
  for (const sample of samples) visit(sample, "");
  return kinds;
}

/** Problems with the report's structure, each naming the field and where it was found. */
export function structureProblems(
  report: unknown,
  fields: Record<string, string>,
  kinds: Map<string, Set<Kind>>,
): string[] {
  const keys = documentedKeys(fields);
  const problems: string[] = [];
  const visit = (value: unknown, path: string, where: string) => {
    const kind = kindOf(value);
    const expected = [...(kinds.get(path) ?? [])].filter((k) => k !== "null");
    if (path && kind !== "null" && expected.length && !expected.includes(kind)) {
      problems.push(`${where} is ${kind}, expected ${expected.join(" or ")}`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[]`, `${where}[${index}]`));
      return;
    }
    const documented = keys.get(path);
    if (!isRecord(value) || !documented) return;
    for (const key of documented) {
      if (!(key in value)) problems.push(`${where}: missing ${childPath(path, key)}`);
    }
    for (const [key, child] of Object.entries(value)) {
      const next = childPath(path, key);
      if (!(next in fields)) problems.push(`${where}: ${next} is not documented in --schema`);
      else visit(child, next, where === "report" ? key : `${where}.${key}`);
    }
  };
  visit(report, "", "report");
  return problems;
}

/** The maintenance fields GitHub feeds, as `--schema` describes them. */
const githubFields = (fields: Record<string, string>) =>
  Object.entries(fields)
    .filter(
      ([path, text]) => path.startsWith("packages[].maintenance.") && /GitHub data/.test(text),
    )
    .map(([path]) => path.slice("packages[].maintenance.".length));

const SECTIONS = ["in_repo", "cost", "compatibility", "maintenance", "security", "bundle"];
export const BUNDLE_SKIPPED = "bundle: skipped, no browser signal in workspace";

/**
 * Problems with how nulls are explained, per package: a failed source is listed in `unavailable`,
 * and a listed source left its fields null (the rules in `--schema`'s descriptions).
 */
export function unavailableProblems(report: unknown, fields: Record<string, string>): string[] {
  const root = asRecord(report);
  const browser = asStringArray(asRecord(root.project).browser_signals).length > 0;
  const github = githubFields(fields);
  const problems: string[] = [];
  for (const [index, raw] of asArray(root.packages).entries()) {
    const pkg = asRecord(raw);
    const where = `packages[${index}] (${asString(pkg.requested) ?? "?"})`;
    const unavailable = asStringArray(pkg.unavailable);
    const listed = (source: string) => unavailable.some((entry) => entry.startsWith(`${source}: `));
    const problem = (text: string) => problems.push(`${where}: ${text}`);
    if (pkg.error !== null || pkg.kind === "builtin") {
      const sections = pkg.error !== null ? SECTIONS : ["compatibility", "maintenance", "security"];
      for (const section of sections.filter((s) => pkg[s] !== null)) {
        problem(
          `${section} is set although ${pkg.error !== null ? "error is set" : "kind is builtin"}`,
        );
      }
      continue;
    }
    const maintenance = asRecord(pkg.maintenance);
    if (pkg.cost === null && !listed("install")) problem("cost is null and no install entry");
    if (pkg.security === null && !listed("osv")) problem("security is null and no osv entry");
    if (maintenance.weekly_downloads === null && !listed("downloads")) {
      problem("weekly_downloads is null and no downloads entry");
    }
    const githubNull = github.filter((field) => maintenance[field] === null);
    if (maintenance.repository !== null && githubNull.length && !listed("github")) {
      problem(`${githubNull.join(", ")} null with a repository and no github entry`);
    }
    if (listed("github") && githubNull.length !== github.length) {
      problem(
        `github entry listed but ${github.filter((f) => !githubNull.includes(f)).join(", ")} set`,
      );
    }
    if (!browser) {
      if (pkg.bundle !== null) problem("bundle is set in a workspace with no browser signal");
      if (!unavailable.includes(BUNDLE_SKIPPED)) problem(`no "${BUNDLE_SKIPPED}" entry`);
    } else if (pkg.bundle === null && !listed("bundle") && !listed("install")) {
      problem("bundle is null in a browser workspace and no bundle or install entry");
    } else if (unavailable.includes(BUNDLE_SKIPPED)) {
      problem(`"${BUNDLE_SKIPPED}" in a browser workspace`);
    }
    const bundle = asRecord(pkg.bundle);
    const nullBytes = Object.keys(bundle).filter(
      (k) => /^whole_.*_bytes$/.test(k) && bundle[k] === null,
    );
    if (nullBytes.length && !listed("bundle")) {
      problem(`${nullBytes.join(", ")} null and no bundle entry`);
    }
  }
  return problems;
}

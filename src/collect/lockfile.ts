/**
 * Pure lockfile parsing. Every format is reduced to the same index so the rest of depfit does
 * not care which package manager the project uses.
 *
 * Dependents are recorded from dependencies, optionalDependencies and peerDependencies in every
 * format. yarn v1 lockfiles do not record peerDependencies, so peer edges are missing there.
 */
import semver from "semver";
import type { Lockfile } from "../report.ts";
import { asArray, asRecord, asString, asStringRecord, isRecord } from "./util.ts";

/** name -> version -> names of lockfile packages that depend on that version. */
export type LockIndex = Map<string, Map<string, Set<string>>>;

type Edge = { from: string; to: string; range: string };

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

export function parseLockfile(kind: Lockfile, text: string): LockIndex {
  switch (kind) {
    case "package-lock.json":
      return parseNpm(text);
    case "pnpm-lock.yaml":
      return parsePnpm(text);
    case "yarn.lock":
      return parseYarn(text);
    case "bun.lock":
      return parseBun(text);
  }
}

/** Number of distinct name@version entries. */
export function countPackages(index: LockIndex): number {
  let count = 0;
  for (const versions of index.values()) count += versions.size;
  return count;
}

/** Installed versions of `name`, ascending. */
export function lockedVersions(index: LockIndex, name: string): string[] {
  return sortVersions([...(index.get(name)?.keys() ?? [])]);
}

/** Lockfile packages depending on any version of `name`, sorted. */
export function dependentsOf(index: LockIndex, name: string): string[] {
  const all = new Set<string>();
  for (const dependents of index.get(name)?.values() ?? []) {
    for (const dependent of dependents) all.add(dependent);
  }
  return [...all].sort();
}

export function sortVersions(versions: string[]): string[] {
  const valid = versions.filter((v) => semver.valid(v)).sort(semver.compare);
  const other = versions.filter((v) => !semver.valid(v)).sort();
  return [...valid, ...other];
}

function addPackage(index: LockIndex, name: string, version: string) {
  if (!name || !version || isNonRegistryVersion(version)) return;
  const versions = index.get(name) ?? new Map<string, Set<string>>();
  if (!versions.has(version)) versions.set(version, new Set());
  index.set(name, versions);
}

/** workspace:, link:, file:, git URLs and the like are not registry packages. */
function isNonRegistryVersion(version: string) {
  return version.includes(":");
}

/** "npm:string-width@^4" under the key "string-width-cjs" really depends on string-width. */
export function resolveAlias(name: string, range: string): { name: string; range: string } {
  if (!range.startsWith("npm:")) return { name, range };
  const spec = range.slice(4);
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), range: spec.slice(at + 1) } : { name, range: spec };
}

function edgesFrom(from: string, manifest: Record<string, unknown>): Edge[] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(asStringRecord(manifest[field])).map(([to, range]) => ({
      from,
      ...toEdgeTarget(to, range),
    })),
  );
}

function toEdgeTarget(to: string, range: string): { to: string; range: string } {
  const alias = resolveAlias(to, range);
  return { to: alias.name, range: alias.range };
}

/** Attaches each edge to the installed version that satisfies its range. */
function linkEdges(index: LockIndex, edges: Edge[]) {
  for (const { from, to, range } of edges) {
    const versions = index.get(to);
    if (!versions || from === to) continue;
    const candidates = [...versions.keys()];
    const match =
      candidates.find((v) => v === range) ??
      sortVersions(candidates)
        .reverse()
        .find((v) => semver.satisfies(v, range, { includePrerelease: true })) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (match) versions.get(match)?.add(from);
  }
}

function nameFromNodeModulesPath(path: string) {
  const marker = "node_modules/";
  return path.slice(path.lastIndexOf(marker) + marker.length);
}

function parseNpm(text: string): LockIndex {
  const lock = asRecord(JSON.parse(text));
  const index: LockIndex = new Map();
  const edges: Edge[] = [];

  if (isRecord(lock.packages)) {
    for (const [path, value] of Object.entries(lock.packages)) {
      const entry = asRecord(value);
      const version = asString(entry.version);
      if (!path.includes("node_modules/") || entry.link === true || !version) continue;
      const name = asString(entry.name) ?? nameFromNodeModulesPath(path);
      addPackage(index, name, version);
      edges.push(...edgesFrom(name, entry));
    }
  } else {
    // lockfileVersion 1: a nested `dependencies` tree with `requires`.
    const walk = (deps: unknown) => {
      for (const [key, value] of Object.entries(asRecord(deps))) {
        const entry = asRecord(value);
        const raw = asString(entry.version);
        if (!raw) continue;
        const { name, range: version } = resolveAlias(key, raw);
        addPackage(index, name, version);
        edges.push(...edgesFrom(name, { dependencies: entry.requires }));
        walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  }

  linkEdges(index, edges);
  return index;
}

function splitNameVersion(id: string): { name: string; version: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), version: id.slice(at + 1) } : { name: id, version: "" };
}

function parseBun(text: string): LockIndex {
  // bun.lock is JSONC with trailing commas.
  const lock = asRecord(JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")));
  const index: LockIndex = new Map();
  const edges: Edge[] = [];
  for (const value of Object.values(asRecord(lock.packages))) {
    const entry = asArray(value);
    const id = asString(entry[0]);
    if (!id) continue;
    const { name, version } = splitNameVersion(id);
    addPackage(index, name, version);
    const meta = entry.find(isRecord);
    if (meta) edges.push(...edgesFrom(name, meta));
  }
  linkEdges(index, edges);
  return index;
}

function unquote(value: string) {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/** pnpm keys: "zod@4.6.5", "/zod@4.6.5", "@a/b@1.0.0(peer@2.0.0)", or v5 "/zod/4.6.5". */
function parsePnpmKey(key: string): { name: string; version: string } {
  const clean = unquote(key).replace(/^\//, "").replace(/\(.*$/, "");
  const parsed = splitNameVersion(clean);
  if (parsed.version) return parsed;
  const slash = clean.lastIndexOf("/");
  return { name: clean.slice(0, slash), version: clean.slice(slash + 1).replace(/_.*$/, "") };
}

function parsePnpm(text: string): LockIndex {
  const index: LockIndex = new Map();
  const edges: Edge[] = [];
  let section = "";
  let current: string | null = null;
  let field: (typeof DEPENDENCY_FIELDS)[number] | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      current = null;
      continue;
    }
    if (section !== "packages" && section !== "snapshots") continue;

    const key = line.match(/^ {2}(\S.*?):(?:\s*\{\})?\s*$/);
    if (key?.[1]) {
      const { name, version } = parsePnpmKey(key[1]);
      addPackage(index, name, version);
      current = name;
      field = null;
      continue;
    }
    const fieldLine = line.match(/^ {4}(\w+):\s*$/);
    if (fieldLine) {
      field = DEPENDENCY_FIELDS.find((f) => f === fieldLine[1]) ?? null;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      field = null;
      continue;
    }
    const dep = line.match(/^ {6}('[^']+'|"[^"]+"|[^\s:]+):\s*(.+)$/);
    if (!dep?.[1] || !dep[2] || !field || !current) continue;
    const to = unquote(dep[1]);
    const value = unquote(dep[2]);
    if (field === "peerDependencies" && section === "packages") {
      // A range, not a resolved version.
      edges.push({ from: current, ...toEdgeTarget(to, value) });
      continue;
    }
    // A resolved reference: "4.6.5", "2.1.4(hono@4.13.13)", or an alias "string-width@4.2.3".
    const ref = value.replace(/^\//, "").replace(/\(.*$/, "");
    if (isNonRegistryVersion(ref)) continue;
    const alias = splitNameVersion(ref);
    edges.push(
      alias.version
        ? { from: current, to: alias.name, range: alias.version }
        : { from: current, to, range: ref.replace(/_.*$/, "") },
    );
  }

  linkEdges(index, edges);
  return index;
}

function parseYarn(text: string): LockIndex {
  const index: LockIndex = new Map();
  const edges: Edge[] = [];

  for (const block of text.split(/\r?\n(?=\S)/)) {
    const lines = block.split(/\r?\n/);
    const header = lines[0] ?? "";
    if (!header.endsWith(":") || header.startsWith("#") || header.startsWith("__metadata"))
      continue;

    let version: string | null = null;
    let resolution: string | null = null;
    let field: (typeof DEPENDENCY_FIELDS)[number] | null = null;
    const deps: Array<{ to: string; range: string }> = [];

    for (const line of lines.slice(1)) {
      const prop = line.match(/^ {2}(\w+):?\s*(.*)$/);
      if (prop?.[1]) {
        const value = unquote(prop[2] ?? "");
        if (prop[1] === "version") version = value;
        if (prop[1] === "resolution") resolution = value;
        field = DEPENDENCY_FIELDS.find((f) => f === prop[1]) ?? null;
        continue;
      }
      const dep = line.match(/^ {4}("[^"]+"|[^\s:"]+):?\s+(.+)$/);
      if (field && dep?.[1] && dep[2]) deps.push({ to: unquote(dep[1]), range: unquote(dep[2]) });
    }
    if (!version) continue;

    const name = resolution ? yarnBerryName(resolution) : yarnV1Name(header);
    if (!name) continue;
    addPackage(index, name, version);
    for (const { to, range } of deps) edges.push({ from: name, ...toEdgeTarget(to, range) });
  }

  linkEdges(index, edges);
  return index;
}

/** "zod@npm:4.6.5" -> "zod"; workspace/link/portal resolutions are not registry packages. */
function yarnBerryName(resolution: string): string | null {
  const at = resolution.indexOf("@", 1);
  if (at < 0) return null;
  const protocol = resolution.slice(at + 1);
  if (/^(workspace|link|portal|file):/.test(protocol)) return null;
  return resolution.slice(0, at);
}

/** '"@a/b@^1", "@a/b@^1.2":' -> "@a/b"; aliases "x@npm:real@^1" -> "real". */
function yarnV1Name(header: string): string | null {
  const first = unquote(header.replace(/:$/, "").split(/,\s*/)[0] ?? "");
  const at = first.indexOf("@", 1);
  if (at < 0) return null;
  const alias = resolveAlias(first.slice(0, at), first.slice(at + 1));
  return alias.name;
}

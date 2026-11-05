import { relative, sep } from "node:path";
import type {
  Compatibility,
  Cost,
  InRepo,
  Maintenance,
  PackageReport,
  ProjectInfo,
  Report,
  Security,
} from "../report.ts";
import {
  formatAgo,
  formatBool,
  formatBytes,
  formatCompact,
  formatCount,
  formatDaysAgo,
  headOfList,
  inlineList,
  NONE,
  plural,
} from "./format.ts";

export type TableOptions = { width: number; color: boolean };

/** Free text that is word-wrapped to the column width at render time, optionally capped. */
type Wrap = { wrap: string; maxLines?: number };
/** A string is one line; an array is one entry per line. */
type Cell = string | string[] | Wrap;

type Row = { label: string; value: (pkg: PackageReport) => Cell };
/** A group without a title sits directly under the package names. */
type Group = { title: string | null; rows: Row[] };

/**
 * `showLatest`: some package resolved to a version other than npm latest.
 * `workspaces`: see knownWorkspaces.
 */
type Context = {
  project: ProjectInfo | null;
  now: string;
  showLatest: boolean;
  workspaces: string[];
};

const GAP = "  ";
const INDENT = "  ";
/** Columns are at most this wide; longer lines are truncated unless the cell wraps. */
const MAX_COLUMN = 40;
/** Free text asks for at most this width; it wraps to whatever the other cells need. */
const WRAP_COLUMN = 24;
const MIN_COLUMN = 8;
const DESCRIPTION_LINES = 3;
/** Directories that conventionally hold workspaces, e.g. "apps/web". */
const WORKSPACE_PARENTS = new Set(["apps", "packages", "libs", "services", "examples", "tools"]);

function section<T>(value: T | null, render: (value: T) => Cell): Cell {
  return value === null ? NONE : render(value);
}

function listOrNone(items: string[]): string[] | string {
  return items.length === 0 ? "none" : headOfList(items);
}

/** Workspace dir of the current workspace relative to the root, or null at the root. */
function currentWorkspace(project: ProjectInfo | null): string | null {
  if (project === null || project.workspace === project.root) return null;
  return relative(project.root, project.workspace).split(sep).join("/");
}

/** Non-root workspaces declaring any package in the report, plus the current one, longest first. */
function knownWorkspaces(report: Report): string[] {
  const current = currentWorkspace(report.project);
  const declared = report.packages.flatMap(
    (p) => p.in_repo?.declared_in_workspaces.map((d) => d.workspace) ?? [],
  );
  return [...new Set([...declared, ...(current ? [current] : [])])]
    .filter((w) => w !== ".")
    .sort((a, b) => b.length - a.length);
}

/**
 * The workspace a file belongs to: the longest known workspace it sits in, else the first two
 * segments when the first is a directory that holds workspaces (conventional, or the parent of a
 * known one), e.g. "apps/server/src/db.ts" → "apps/server"; otherwise "." (the root).
 */
function workspaceOf(file: string, known: string[]): string {
  const found = known.find((w) => file.startsWith(`${w}/`));
  if (found) return found;
  const segments = file.split("/");
  const parent = segments[0] ?? "";
  const isParent = WORKSPACE_PARENTS.has(parent) || known.some((w) => w.startsWith(`${parent}/`));
  return segments.length >= 3 && isParent ? segments.slice(0, 2).join("/") : ".";
}

/** "10 (apps/server, apps/desktop)", workspaces with the most files first; just the count when all are in the root. */
function filesUsing(r: InRepo, known: string[]): string {
  const count = String(r.files_using.length);
  const counts = new Map<string, number>();
  for (const file of r.files_using) {
    const workspace = workspaceOf(file, known);
    counts.set(workspace, (counts.get(workspace) ?? 0) + 1);
  }
  const workspaces = [...counts].sort((a, b) => b[1] - a[1]).map(([workspace]) => workspace);
  if (workspaces.every((w) => w === ".")) return count;
  return `${count} (${inlineList(workspaces)})`;
}

function installed(r: InRepo, pkg: PackageReport): string {
  if (pkg.kind === "builtin") return "builtin";
  return r.installed_versions.length === 0 ? "no" : inlineList(r.installed_versions);
}

function inRepoRows(ctx: Context): Row[] {
  const row = (label: string, render: (r: InRepo, pkg: PackageReport) => Cell): Row => ({
    label,
    value: (p) => section(p.in_repo, (r) => render(r, p)),
  });
  return [
    row("Installed", installed),
    row("Pulled in by", (r) => listOrNone(r.pulled_in_by)),
    row("Declared in", (r) =>
      listOrNone(r.declared_in_workspaces.map((d) => `${d.workspace} ${d.range}`)),
    ),
    row("Files using", (r) => filesUsing(r, ctx.workspaces)),
  ];
}

const VERSION_SOURCES: Record<NonNullable<PackageReport["version_source"]>, string> = {
  requested: "requested",
  declared_range: "declared range",
  latest: "latest",
};

/** "1.2.0-beta.15 (declared range)", or "builtin" for runtime modules. */
function costFor(p: PackageReport): string {
  if (p.kind === "builtin") return "builtin";
  if (p.cost === null || p.version === null) return NONE;
  if (p.version_source === null) return p.version;
  return `${p.version} (${VERSION_SOURCES[p.version_source]})`;
}

function latest(p: PackageReport): string {
  if (p.latest_version === null) return NONE;
  return p.latest_version === p.version ? "same" : p.latest_version;
}

/** "0.17.3: +0 packages". */
function atNewestInstalled(c: Cost): string {
  const at = c.at_newest_installed;
  return at === null ? NONE : `${at.version}: +${plural(at.new_packages.length, "package")}`;
}

function costRows(ctx: Context): Row[] {
  const row = (label: string, render: (c: Cost) => Cell): Row => ({
    label,
    value: (p) => section(p.cost, render),
  });
  return [
    { label: "Cost for", value: costFor },
    ...(ctx.showLatest ? [{ label: "Latest", value: latest }] : []),
    row("New packages", (c) => String(c.new_packages.length)),
    row("Reused packages", (c) => String(c.reused_packages.length)),
    row("New install size", (c) => formatBytes(c.new_install_bytes)),
    row("Using installed version", atNewestInstalled),
    row("Install scripts", (c) => listOrNone(c.install_scripts)),
    row("Native binaries", (c) => listOrNone(c.native_binaries)),
    row("Other-platform packages", (c) => String(c.other_platform_packages)),
  ];
}

function peerDependency(peer: Compatibility["peer_dependencies"][number]): string {
  const optional = peer.optional ? " optional" : "";
  let have = "";
  if (peer.satisfied_by_lockfile !== null) {
    if (peer.installed === null) have = " (not installed)";
    else if (peer.satisfied_by_lockfile) have = ` (have ${peer.installed})`;
    else have = ` (have ${peer.installed}, not satisfied)`;
  }
  return `${peer.name} ${peer.range}${optional}${have}`;
}

function typesSource(c: Compatibility): Cell {
  return c.types_package === null ? c.types_source : [c.types_source, c.types_package];
}

/**
 * "node >=18 (ok), bun >=1.1": engine_satisfied is shown on the project runtime's entry.
 * Wrapped, not truncated, so long ranges keep their status.
 */
function engines(c: Compatibility, project: ProjectInfo | null): Cell {
  const entries = Object.entries(c.engines);
  if (entries.length === 0) return "none";
  const status =
    c.engine_satisfied === null ? "" : c.engine_satisfied ? " (ok)" : " (not satisfied)";
  const text = entries
    .map(([runtime, range]) => `${runtime} ${range}${runtime === project?.runtime ? status : ""}`)
    .join(", ");
  return { wrap: text };
}

function compatibilityRows(ctx: Context): Row[] {
  const row = (label: string, render: (c: Compatibility) => Cell): Row => ({
    label,
    value: (p) => section(p.compatibility, render),
  });
  return [
    row("Module format", (c) => c.module_format),
    row("Types", typesSource),
    row("Engines", (c) => engines(c, ctx.project)),
    row("Peer deps", (c) => listOrNone(c.peer_dependencies.map(peerDependency))),
    row("License", (c) => c.license ?? NONE),
  ];
}

/** "no / no", or the deprecation message verbatim, then whether the repository is archived. */
function deprecatedArchived(m: Maintenance): Cell {
  const archived = formatBool(m.archived);
  return m.deprecated === null ? `no / ${archived}` : { wrap: `"${m.deprecated}" / ${archived}` };
}

function maintenanceRows(ctx: Context): Row[] {
  const row = (label: string, render: (m: Maintenance) => Cell): Row => ({
    label,
    value: (p) => section(p.maintenance, render),
  });
  return [
    row("Last release", (m) => formatDaysAgo(m.days_since_release)),
    row("Releases last year", (m) => String(m.stable_releases_last_year)),
    row("Last commit", (m) => formatAgo(m.last_commit_at, ctx.now)),
    row("Commits last year", (m) => formatCount(m.commits_last_year)),
    row("Weekly downloads", (m) => formatCompact(m.weekly_downloads)),
    row("Deprecated / archived", deprecatedArchived),
    row("Provenance", (m) => formatBool(m.provenance)),
  ];
}

/**
 * "13 (0 affect 17.0.1)", plus which installed versions any advisory affects when a version
 * other than `version` is installed.
 */
function advisories(s: Security, pkg: PackageReport): Cell {
  const total = String(s.advisories.length);
  if (s.advisories.length === 0 || pkg.version === null) return total;
  const count = s.advisories.filter((a) => a.affects_version).length;
  const lines = [`${total} (${count} ${count === 1 ? "affects" : "affect"} ${pkg.version})`];
  const installedVersions = pkg.in_repo?.installed_versions ?? [];
  if (installedVersions.some((v) => v !== pkg.version)) {
    const affected = new Set(s.advisories.flatMap((a) => a.affects_installed_versions));
    const list = installedVersions.filter((v) => affected.has(v));
    lines.push(`(installed affected: ${list.length === 0 ? "none" : inlineList(list)})`);
  }
  return lines;
}

function securityRows(): Row[] {
  const row = (label: string, render: (s: Security, pkg: PackageReport) => Cell): Row => ({
    label,
    value: (p) => section(p.security, (s) => render(s, p)),
  });
  return [
    row("Advisories", advisories),
    row("Dependency vulnerabilities", (s) => String(s.dependency_vulnerabilities.length)),
  ];
}

function groups(ctx: Context): Group[] {
  const description: Row = {
    label: "Description",
    value: (p) =>
      p.description === null ? NONE : { wrap: p.description, maxLines: DESCRIPTION_LINES },
  };
  return [
    { title: null, rows: [description] },
    ...(ctx.project === null ? [] : [{ title: "In this repo", rows: inRepoRows(ctx) }]),
    { title: "Cost", rows: costRows(ctx) },
    { title: "Compatibility", rows: compatibilityRows(ctx) },
    { title: "Maintenance", rows: maintenanceRows(ctx) },
    { title: "Security", rows: securityRows() },
  ];
}

function isWrap(cell: Cell): cell is Wrap {
  return typeof cell === "object" && !Array.isArray(cell);
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > width) {
      if (line) lines.push(line);
      line = "";
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Wrapped lines, cut to `maxLines` with an ellipsis on the last one. */
function wrapCell({ wrap, maxLines }: Wrap, width: number): string[] {
  const lines = wrapText(wrap, width);
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept.pop() ?? "";
  return [...kept, `${last.slice(0, Math.max(0, width - 1))}…`];
}

function cellLines(cell: Cell, width: number): string[] {
  if (isWrap(cell)) return wrapCell(cell, width);
  return typeof cell === "string" ? [cell] : cell;
}

/** Width the cell would like, before the column is capped. */
function naturalWidth(cell: Cell): number {
  if (isWrap(cell)) return Math.min(cell.wrap.length, WRAP_COLUMN);
  return Math.max(0, ...cellLines(cell, MAX_COLUMN).map((line) => line.length));
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

type Column = { pkg: PackageReport; cells: Cell[][]; width: number };

function buildColumn(pkg: PackageReport, table: Group[]): Column {
  const cells = table.map((group, g) =>
    group.rows.map((row, r): Cell => {
      if (pkg.error === null) return row.value(pkg);
      return g === 0 && r === 0 ? { wrap: `error: ${pkg.error}` } : "";
    }),
  );
  const width = Math.max(pkg.name.length, ...cells.flat().map(naturalWidth));
  return { pkg, cells, width: Math.min(width, MAX_COLUMN) };
}

/** Splits columns into consecutive runs that fit next to the label column. */
function chunkColumns(columns: Column[], available: number): Column[][] {
  const chunks: Column[][] = [];
  let current: Column[] = [];
  let used = 0;
  for (const column of columns) {
    const needed = GAP.length + column.width;
    if (current.length > 0 && used + needed > available) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(column);
    used += needed;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type Style = (text: string) => string;

function styles(color: boolean): { dim: Style; bold: Style } {
  if (!color) return { dim: (t) => t, bold: (t) => t };
  return { dim: (t) => `\x1b[2m${t}\x1b[22m`, bold: (t) => `\x1b[1m${t}\x1b[22m` };
}

/** Joins styled segments, padding each to its width; trailing spaces are dropped. */
function line(segments: Array<{ text: string; width: number; style?: Style }>): string {
  return segments
    .map(({ text, width, style }, i) => {
      const padding = i === segments.length - 1 ? "" : " ".repeat(Math.max(0, width - text.length));
      return (text && style ? style(text) : text) + padding;
    })
    .join(GAP)
    .trimEnd();
}

function renderChunk(
  columns: Column[],
  table: Group[],
  labelWidth: number,
  available: number,
  color: boolean,
): string[] {
  const { dim, bold } = styles(color);
  const widths = columns.map((c) =>
    Math.max(MIN_COLUMN, Math.min(c.width, available - GAP.length)),
  );
  const out = [
    line([
      { text: "", width: labelWidth },
      ...columns.map((c, i) => ({
        text: truncate(c.pkg.name, widths[i] ?? 0),
        width: widths[i] ?? 0,
        style: bold,
      })),
    ]),
  ];
  table.forEach((group, g) => {
    if (group.title !== null) out.push("", dim(group.title));
    group.rows.forEach((row, r) => {
      const lines = columns.map((c, i) => {
        const cell = c.cells[g]?.[r] ?? NONE;
        return cellLines(cell, widths[i] ?? 0).map((l) => truncate(l, widths[i] ?? 0));
      });
      const height = Math.max(1, ...lines.map((l) => l.length));
      for (let k = 0; k < height; k++) {
        out.push(
          line([
            { text: k === 0 ? INDENT + row.label : "", width: labelWidth, style: dim },
            ...lines.map((l, i) => ({ text: l[k] ?? "", width: widths[i] ?? 0 })),
          ]),
        );
      }
    });
  });
  return out;
}

function runtimeText(project: ProjectInfo): string {
  if (project.runtime === null) return "runtime unknown";
  if (project.runtime_range === null) return `${project.runtime} (no version range)`;
  return `${project.runtime} ${project.runtime_range}`;
}

function projectLines(report: Report): string[] {
  const { project } = report;
  const measured = `Measured on ${report.measured_on_platform}`;
  if (project === null) return ["No project found", measured];
  const lockfile =
    project.lockfile === null
      ? "no lockfile"
      : `${project.lockfile} (${plural(project.packages_in_lockfile, "package")})`;
  return [
    `Project ${project.root}`,
    ...(project.workspace === project.root ? [] : [`Workspace ${project.workspace}`]),
    `${lockfile}, type ${project.module_type}, ${runtimeText(project)}`,
    measured,
  ];
}

function unavailableLines(packages: PackageReport[], color: boolean): string[] {
  const missing = packages.filter((p) => p.unavailable.length > 0);
  if (missing.length === 0) return [];
  const { dim } = styles(color);
  return [
    "",
    dim("Unavailable data"),
    ...missing.map((p) => `${INDENT}${p.name}: ${p.unavailable.join("; ")}`),
  ];
}

/** Renders the report as one or more stacked tables: rows are facts, columns are packages. */
export function renderTable(report: Report, options: TableOptions): string {
  const ctx: Context = {
    project: report.project,
    now: report.generated_at,
    showLatest: report.packages.some(
      (p) => p.error === null && p.latest_version !== null && p.latest_version !== p.version,
    ),
    workspaces: knownWorkspaces(report),
  };
  const table = groups(ctx);
  const labelWidth = Math.max(
    ...table.flatMap((group) => group.rows.map((row) => INDENT.length + row.label.length)),
  );
  const available = options.width - labelWidth;
  const columns = report.packages.map((pkg) => buildColumn(pkg, table));
  const out = projectLines(report);
  for (const chunk of chunkColumns(columns, available)) {
    out.push("", ...renderChunk(chunk, table, labelWidth, available, options.color));
  }
  out.push(...unavailableLines(report.packages, options.color));
  return `${out.join("\n")}\n`;
}

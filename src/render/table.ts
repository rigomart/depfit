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
  formatChange,
  formatCompact,
  formatCount,
  formatDays,
  formatDaysAgo,
  formatPair,
  formatRepository,
  formatShare,
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

/** `showLatest`: some package resolved to a version other than npm latest. */
type Context = { project: ProjectInfo | null; now: string; showLatest: boolean };

const GAP = "  ";
const INDENT = "  ";
/** Columns wider than this are truncated (lists, URLs). */
const MAX_COLUMN = 40;
/** Free text asks for at most this width; it wraps to whatever the other cells need. */
const WRAP_COLUMN = 24;
const MIN_COLUMN = 8;
const DESCRIPTION_LINES = 3;
const KEYWORDS = 4;

function section<T>(value: T | null, render: (value: T) => Cell): Cell {
  return value === null ? NONE : render(value);
}

function listOrNone(items: string[]): string[] | string {
  return items.length === 0 ? "none" : headOfList(items);
}

function aboutRows(): Row[] {
  return [
    {
      label: "Description",
      value: (p) =>
        p.description === null ? NONE : { wrap: p.description, maxLines: DESCRIPTION_LINES },
    },
    {
      label: "Keywords",
      value: (p) =>
        p.keywords.length === 0 ? "none" : { wrap: inlineList(p.keywords, KEYWORDS), maxLines: 2 },
    },
  ];
}

/** "4.1.0 → 4.4.0 (minor)", or "same". */
function versionChange(r: InRepo, version: string | null): string {
  const change = r.version_change_from_installed;
  if (change === null || r.newest_installed === null) return NONE;
  if (change === "same") return "same";
  return `${r.newest_installed} → ${version ?? NONE} (${change})`;
}

/** Workspace dir of the current workspace relative to the root, or null at the root. */
function currentWorkspace(project: ProjectInfo | null): string | null {
  if (project === null || project.workspace === project.root) return null;
  return relative(project.root, project.workspace).split(sep).join("/");
}

/**
 * Workspace of each file in files_using, most files first. A file belongs to the longest known
 * workspace (declaring ones plus the current one) it sits in. In a monorepo, other files three or
 * more levels deep count under their first two segments (e.g. "apps/admin"); the rest are ".".
 */
function workspacesUsing(r: InRepo, project: ProjectInfo | null): string[] {
  const current = currentWorkspace(project);
  const known = [
    ...new Set([
      ...r.declared_in_workspaces.map((d) => d.workspace),
      ...(current ? [current] : []),
    ]),
  ]
    .filter((w) => w !== ".")
    .sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  for (const file of r.files_using) {
    const segments = file.split("/");
    const workspace =
      known.find((w) => file.startsWith(`${w}/`)) ??
      (known.length > 0 && segments.length >= 3 ? segments.slice(0, 2).join("/") : ".");
    counts.set(workspace, (counts.get(workspace) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([workspace]) => workspace);
}

/** "4 (packages/ui, apps/web)"; just the count when every file is in the root workspace. */
function filesUsing(r: InRepo, project: ProjectInfo | null): string {
  const count = String(r.files_using.length);
  const workspaces = workspacesUsing(r, project);
  if (workspaces.every((w) => w === ".")) return count;
  return `${count} (${inlineList(workspaces)})`;
}

function inRepoRows(ctx: Context): Row[] {
  const row = (label: string, render: (r: InRepo, pkg: PackageReport) => Cell): Row => ({
    label,
    value: (p) => section(p.in_repo, (r) => render(r, p)),
  });
  return [
    row("Installed", (r) =>
      r.installed_versions.length === 0 ? "no" : inlineList(r.installed_versions),
    ),
    row("Newest installed vs version", (r, p) => versionChange(r, p.version)),
    row("Pulled in by", (r) => listOrNone(r.pulled_in_by)),
    row("In package.json", (r) => r.in_package_json ?? "no"),
    row("Declared in", (r) =>
      listOrNone(r.declared_in_workspaces.map((d) => `${d.workspace} ${d.range}`)),
    ),
    row("Files using", (r) => filesUsing(r, ctx.project)),
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
    row("Other-platform packages", (c) => String(c.other_platform_packages)),
    row("Install scripts", (c) => listOrNone(c.install_scripts)),
    row("Native binaries", (c) => listOrNone(c.native_binaries)),
    row("Browser gzip (full import)", (c) => formatBytes(c.bundle.gzip_bytes_browser_full_import)),
    row("Node gzip (full import)", (c) => formatBytes(c.bundle.gzip_bytes_node_full_import)),
    row("Browser compatible", (c) => formatBool(c.bundle.browser_compatible)),
    row("Browser named exports", (c) => formatCount(c.bundle.browser_named_exports)),
    row("Subpath exports", (c) => {
      const count = c.bundle.subpath_exports.length;
      return count === 0 ? "none" : plural(count, "subpath");
    }),
    row("Unresolved imports", (c) => listOrNone(c.bundle.unresolved_imports)),
    row("Bundle errors", (c) => listOrNone(c.bundle.errors)),
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

function engines(c: Compatibility): string {
  const entries = Object.entries(c.engines);
  if (entries.length === 0) return "none";
  return entries.map(([runtime, range]) => `${runtime} ${range}`).join(", ");
}

function compatibilityRows(): Row[] {
  const row = (label: string, render: (c: Compatibility) => Cell): Row => ({
    label,
    value: (p) => section(p.compatibility, render),
  });
  return [
    row("Module format", (c) => c.module_format),
    row("Side-effects free", (c) => formatBool(c.side_effects_free)),
    row("Types", typesSource),
    row("Engines", engines),
    row("Engine satisfied", (c) => formatBool(c.engine_satisfied)),
    row("Peer deps", (c) => listOrNone(c.peer_dependencies.map(peerDependency))),
    row("License", (c) => c.license ?? NONE),
  ];
}

function maintenanceRows(ctx: Context): Row[] {
  const row = (label: string, render: (m: Maintenance) => Cell): Row => ({
    label,
    value: (p) => section(p.maintenance, render),
  });
  return [
    row("Deprecated", (m) => (m.deprecated === null ? "no" : { wrap: m.deprecated })),
    row("Last release", (m) => formatDaysAgo(m.days_since_release)),
    row("Stable releases last year", (m) => String(m.stable_releases_last_year)),
    row("Last commit", (m) => formatAgo(m.last_commit_at, ctx.now)),
    row("Commits 90d / year", (m) => formatPair(m.commits_last_90d, m.commits_last_year)),
    row("Sampled commits by bots", (m) =>
      m.sampled_commits_by_bots === null || m.sampled_commits === null
        ? NONE
        : `${m.sampled_commits_by_bots} of ${m.sampled_commits}`,
    ),
    row("Human committers", (m) => formatCount(m.human_committers)),
    row("Top human committer", (m) => {
      if (m.top_human_committer === null) return NONE;
      if (m.top_human_committer_share === null) return m.top_human_committer;
      return `${m.top_human_committer} ${formatShare(m.top_human_committer_share)}`;
    }),
    row("Merged PRs by others", (m) => formatShare(m.merged_prs_by_others_share)),
    row("Open issues / PRs", (m) => formatPair(m.open_issues, m.open_prs)),
    row("Issue close median", (m) => formatDays(m.issues_median_days_to_close)),
    row("Weekly downloads", (m) => formatCompact(m.weekly_downloads)),
    row("Downloads 90d change", (m) => formatChange(m.downloads_change_ratio_90d)),
    row("Archived", (m) => formatBool(m.archived)),
    row("Provenance", (m) => formatBool(m.provenance)),
    row("Repository", (m) => formatRepository(m.repository)),
  ];
}

function affect(count: number, version: string): string {
  return `${count} ${count === 1 ? "affects" : "affect"} ${version}`;
}

/** "13 (0 affect 17.0.1)", plus a line for the newest installed version when it differs. */
function advisories(s: Security, pkg: PackageReport): Cell {
  const total = String(s.advisories.length);
  if (s.advisories.length === 0 || pkg.version === null) return total;
  const lines = [
    `${total} (${affect(s.advisories.filter((a) => a.affects_version).length, pkg.version)})`,
  ];
  const installed = pkg.in_repo?.newest_installed ?? null;
  if (installed !== null && installed !== pkg.version) {
    const count = s.advisories.filter((a) => a.affects_newest_installed === true).length;
    lines.push(`(${affect(count, installed)})`);
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
  return [
    { title: null, rows: aboutRows() },
    ...(ctx.project === null ? [] : [{ title: "In this repo", rows: inRepoRows(ctx) }]),
    { title: "Cost", rows: costRows(ctx) },
    { title: "Compatibility", rows: compatibilityRows() },
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

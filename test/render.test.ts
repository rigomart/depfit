import { describe, expect, it } from "vitest";
import { renderTable } from "../src/render/table.ts";
import type { PackageReport } from "../src/report.ts";
import {
  betterSqlite3,
  bunProject,
  libsqlClient,
  missing,
  monorepoProject,
  nodeProject,
  nodePty,
  nodePtyUnmeasurable,
  nodeSqlite,
  noProjectReport,
  report,
  sharp,
  sonner,
  sonnerBundled,
  valibot,
  workersProject,
  yup,
  yupWithoutGithub,
  zod,
  zodBundled,
} from "./reports.ts";

const plain = { width: 120, color: false };

/** Cells of the first row with this label, split on the column gaps. */
function row(output: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = output.match(new RegExp(`^  ${escaped}\\s{2,}(.*)$`, "m"));
  if (!match?.[1]) throw new Error(`no row "${label}" in:\n${output}`);
  return match[1].trim().split(/\s{2,}/);
}

/** The lines that make up a row, including continuation lines of multi-line cells. */
function rowBlock(output: string, label: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${label}  `));
  const block = [lines[start] ?? ""];
  for (const next of lines.slice(start + 1)) {
    if (!next.startsWith("    ") || next.trim() === "") break;
    block.push(next);
  }
  return block;
}

/** The last column of each line of a row: the cell of a single-package table. */
function lastCells(output: string, label: string): string[] {
  return rowBlock(output, label).map(
    (l) =>
      l
        .trim()
        .split(/\s{2,}/)
        .at(-1) ?? "",
  );
}

describe("renderTable", () => {
  const output = renderTable(report([zod, valibot, yup]), plain);
  const sharpOutput = renderTable(report([sharp], bunProject), plain);

  it("puts packages in columns under a project header", () => {
    const lines = output.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "Project /home/dev/mcp-server",
      "package-lock.json (92 packages), type module, node >=20",
      "Measured on darwin-arm64",
    ]);
    expect(lines[4]?.trim().split(/\s+/)).toEqual(["zod", "valibot", "yup"]);
  });

  it("names the workspace when it is not the root and the runtime without a range", () => {
    expect(sharpOutput.split("\n").slice(0, 4)).toEqual([
      "Project /home/dev/site",
      "Workspace /home/dev/site/apps/web",
      "bun.lock (412 packages), type module, bun (no version range)",
      "Measured on darwin-arm64",
    ]);
  });

  it("shows the groups in order, description first", () => {
    const lines = output.split("\n");
    expect(lines[5]).toMatch(/^ {2}Description /);
    const titles = lines.slice(3).filter((l) => /^[A-Z]/.test(l));
    expect(titles).toEqual(["In this repo", "Cost", "Compatibility", "Maintenance", "Security"]);
  });

  it("wraps the description in its column and cuts it after three lines", () => {
    expect(lastCells(renderTable(report([yup]), plain), "Description")).toEqual([
      "Dead simple Object",
      "schema validation",
    ]);
    const block = lastCells(sharpOutput, "Description");
    expect(block).toHaveLength(3);
    expect(block.at(-1)).toMatch(/…$/);
    expect(block.join(" ")).toMatch(/^High performance Node\.js image processing/);
  });

  it("adds a Bundle group last, only when some package has a bundle", () => {
    expect(output).not.toContain("Bundle");
    const out = renderTable(report([zodBundled, valibot, sonnerBundled, nodePtyUnmeasurable]), {
      width: 200,
      color: false,
    });
    const titles = out.split("\n").filter((l) => /^[A-Z]/.test(l));
    expect(titles.at(-2)).toBe("Bundle");
    expect(row(out, "Eager JS min / gzip")).toEqual([
      "78.6 KB / 22.5 KB",
      "-",
      "33.5 KB / 9.3 KB",
      "-",
    ]);
    expect(row(out, "Lazy JS min / gzip")).toEqual(["0 B / 0 B", "-", "0 B / 0 B", "-"]);
    expect(row(out, "External (peers)")).toEqual(["none", "-", "react", "none"]);
    expect(row(out, "Bundler")[0]).toBe("rolldown@1.2.14, browser");
    expect(out).toContain("node-pty: bundle: IMPORT_OUTSIDE_BUNDLE import(…)");
  });

  it("formats repo facts", () => {
    expect(row(output, "Installed")).toEqual(["4.6.5", "no", "no"]);
    expect(row(output, "Declared in")).toEqual(["none", "none", "none"]);
    expect(row(output, "Files using")).toEqual(["1", "0", "0"]);
    expect(row(output, "Pulled in by")).toEqual(["@modelcontextprotocol/sdk", "none", "none"]);
    expect(rowBlock(output, "Pulled in by")[1]?.trim()).toBe("zod-to-json-schema");
  });

  it("shows what using the installed version instead would add", () => {
    expect(row(sharpOutput, "Installed")).toEqual(["0.34.5"]);
    expect(row(sharpOutput, "Pulled in by")).toEqual(["next"]);
    expect(row(sharpOutput, "Using installed version")).toEqual(["0.34.5: +0 packages"]);
    expect(row(output, "Using installed version")).toEqual(["-", "-", "-"]);
  });

  it("formats cost facts for the resolved version", () => {
    expect(row(output, "Cost for")).toEqual(["4.6.5 (latest)", "1.5.0 (latest)", "1.7.1 (latest)"]);
    expect(row(output, "New packages")).toEqual(["0", "1", "5"]);
    expect(row(output, "Reused packages")).toEqual(["1", "0", "0"]);
    expect(row(output, "New install size")).toEqual(["0 B", "1.9 MB", "504.7 KB"]);
    expect(row(output, "Install scripts")).toEqual(["none", "none", "none"]);
  });

  it("shows native and platform facts", () => {
    expect(row(sharpOutput, "Cost for")).toEqual(["0.35.5 (latest)"]);
    expect(row(sharpOutput, "New packages")).toEqual(["3"]);
    expect(row(sharpOutput, "Reused packages")).toEqual(["3"]);
    expect(row(sharpOutput, "New install size")).toEqual(["16.9 MB"]);
    expect(row(sharpOutput, "Other-platform packages")).toEqual(["25"]);
    expect(row(sharpOutput, "Install scripts")).toEqual(["sharp"]);
    expect(lastCells(sharpOutput, "Native binaries")).toEqual([
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
    ]);
  });

  it("names where the version comes from and shows latest only when it differs", () => {
    expect(output).not.toMatch(/^ {2}Latest /m);
    const requested: PackageReport = {
      ...zod,
      requested: "zod@^3",
      version: "3.25.76",
      version_source: "requested",
    };
    const out = renderTable(report([nodePty, requested, zod]), { width: 160, color: false });
    expect(row(out, "Cost for")).toEqual([
      "1.2.0-beta.15 (declared range)",
      "3.25.76 (requested)",
      "4.6.5 (latest)",
    ]);
    expect(row(out, "Latest")).toEqual(["1.1.0", "4.6.5", "same"]);
    expect(out.indexOf("  Latest ")).toBeGreaterThan(out.indexOf("  Cost for "));
  });

  it("shows every declaring workspace and the workspaces of the files using it", () => {
    const out = renderTable(report([sonner, sharp], bunProject), plain);
    expect(row(out, "Declared in")).toEqual(["packages/ui ^2.0.7", "none"]);
    expect(row(out, "Files using")).toEqual(["4 (packages/ui, apps/web)", "0"]);
    expect(row(renderTable(report([nodePty], nodeProject), plain), "Declared in")).toEqual([
      ". ^1.2.0-beta.15",
    ]);
  });

  it("groups files outside known workspaces by their first two directories in a monorepo", () => {
    const pkg: PackageReport = {
      ...sonner,
      in_repo: sonner.in_repo && {
        ...sonner.in_repo,
        files_using: [
          ...sonner.in_repo.files_using,
          "apps/admin/src/main.tsx",
          "apps/admin/src/toasts.tsx",
          "scripts/seed.ts",
        ],
      },
    };
    expect(row(renderTable(report([pkg], bunProject), plain), "Files using")).toEqual([
      "7 (packages/ui, apps/admin, +2 more)",
    ]);
  });

  it("renders a builtin next to npm packages in one table without errors", () => {
    const out = renderTable(
      report([nodeSqlite, betterSqlite3, libsqlClient], monorepoProject),
      plain,
    );
    expect(
      out
        .split("\n")[4]
        ?.trim()
        .split(/\s{2,}/),
    ).toEqual(["node:sqlite", "better-sqlite3", "@libsql/client"]);
    expect(out.match(/^Cost$/gm)).toHaveLength(1);
    for (const l of out.split("\n")) expect(l.length).toBeLessThanOrEqual(120);
    expect(row(out, "Description")[0]).toBe("-");
    expect(row(out, "Installed")).toEqual(["builtin", "no", "0.17.3"]);
    expect(lastCells(out, "Pulled in by")).toEqual(["alchemy", "drizzle-orm"]);
    expect(row(out, "Files using")).toEqual(["10 (apps/server, apps/desktop)", "0", "0"]);
    expect(row(out, "Cost for")).toEqual(["builtin", "12.4.1 (latest)", "0.18.0 (latest)"]);
    expect(out).not.toMatch(/^ {2}Latest /m);
    expect(row(out, "New packages")).toEqual(["0", "2", "5"]);
    expect(row(out, "New install size")).toEqual(["0 B", "27.7 MB", "10.2 MB"]);
    expect(row(out, "Using installed version")).toEqual(["-", "-", "0.17.3: +0 packages"]);
    expect(row(out, "Native binaries")).toEqual(["none", "better-sqlite3", "@libsql/darwin-arm64"]);
    expect(row(out, "Other-platform packages")).toEqual(["0", "0", "8"]);
    for (const label of ["Module format", "Types", "License", "Last release", "Advisories"]) {
      expect(row(out, label)[0], label).toBe("-");
    }
    expect(out).not.toContain("error:");
  });

  it("prints the cloudflare-workers runtime as-is", () => {
    const out = renderTable(report([zod], workersProject), plain);
    expect(out.split("\n")[2]).toBe(
      "bun.lock (412 packages), type module, cloudflare-workers (no version range)",
    );
  });

  it("formats compatibility facts", () => {
    expect(row(output, "Module format")).toEqual(["dual", "dual", "dual"]);
    expect(row(output, "Types")).toEqual(["bundled", "bundled", "bundled"]);
    expect(row(output, "Engines")).toEqual(["none", "none", "none"]);
    expect(row(output, "Peer deps")).toEqual([
      "none",
      "typescript >=5 optional (have 5.9.3)",
      "none",
    ]);
    expect(row(output, "License")).toEqual(["MIT", "MIT", "MIT"]);
  });

  it("lists every engine and marks whether the project runtime satisfies its entry", () => {
    const pkg = (satisfied: boolean | null): PackageReport => ({
      ...sharp,
      compatibility: sharp.compatibility && {
        ...sharp.compatibility,
        engines: { node: ">=18", bun: ">=1.1" },
        engine_satisfied: satisfied,
      },
    });
    const engines = (satisfied: boolean | null) =>
      lastCells(renderTable(report([pkg(satisfied)], bunProject), plain), "Engines").join(" ");
    expect(engines(true)).toBe("node >=18, bun >=1.1 (ok)");
    expect(engines(false)).toBe("node >=18, bun >=1.1 (not satisfied)");
    expect(engines(null)).toBe("node >=18, bun >=1.1");
  });

  it("wraps long engine ranges instead of cutting off the status", () => {
    const pkg: PackageReport = {
      ...betterSqlite3,
      compatibility: betterSqlite3.compatibility && {
        ...betterSqlite3.compatibility,
        engine_satisfied: false,
      },
    };
    const out = renderTable(report([pkg], nodeProject), plain);
    expect(lastCells(out, "Engines").join(" ")).toBe(
      "node 20.x || 22.x || 23.x || 24.x (not satisfied)",
    );
  });

  it("shows the types package and unsatisfied or missing peers", () => {
    const pkg: PackageReport = {
      ...valibot,
      compatibility: valibot.compatibility && {
        ...valibot.compatibility,
        types_source: "definitely_typed",
        types_package: "@types/luxon@3.7.6",
        peer_dependencies: [
          {
            name: "react",
            range: "^18",
            optional: false,
            installed: "19.2.3",
            satisfied_by_lockfile: false,
          },
          {
            name: "react-dom",
            range: "^18",
            optional: false,
            installed: null,
            satisfied_by_lockfile: false,
          },
        ],
      },
    };
    const out = renderTable(report([pkg]), plain);
    expect(lastCells(out, "Types")).toEqual(["definitely_typed", "@types/luxon@3.7.6"]);
    expect(lastCells(out, "Peer deps")).toEqual([
      "react ^18 (have 19.2.3, not satisfied)",
      "react-dom ^18 (not installed)",
    ]);
  });

  it("formats maintenance facts", () => {
    expect(row(output, "Last release")).toEqual(["27 days ago", "31 days ago", "384 days ago"]);
    expect(row(output, "Releases last year")).toEqual(["25", "7", "0"]);
    expect(row(output, "Last commit")).toEqual(["today", "1 day ago", "383 days ago"]);
    expect(row(output, "Commits last year")).toEqual(["598", "458", "0"]);
    expect(row(output, "Weekly downloads")).toEqual(["334M", "22.2M", "12.5M"]);
    expect(row(output, "Deprecated / archived")).toEqual(["no / no", "no / no", "no / no"]);
    expect(row(output, "Provenance")).toEqual(["yes", "yes", "no"]);
    expect(output).not.toContain("github.com");
  });

  it("counts advisories affecting the resolved and the installed versions", () => {
    expect(row(output, "Advisories")).toEqual(["1 (0 affect 4.6.5)", "1 (0 affect 1.5.0)", "0"]);
    expect(row(output, "Dependency vulnerabilities")).toEqual(["0", "0", "0"]);
    expect(lastCells(sharpOutput, "Advisories")).toEqual([
      "1 (0 affect 0.35.5)",
      "(installed affected: none)",
    ]);
    const advisory = sharp.security?.advisories[0];
    if (!advisory) throw new Error("fixture has no advisory");
    const affected: PackageReport = {
      ...sharp,
      in_repo: sharp.in_repo && { ...sharp.in_repo, installed_versions: ["0.33.1", "0.34.5"] },
      security: {
        advisories: [
          advisory,
          {
            ...advisory,
            id: "GHSA-a",
            affects_version: false,
            affects_installed_versions: ["0.34.5"],
          },
          {
            ...advisory,
            id: "GHSA-b",
            affects_version: true,
            affects_installed_versions: ["0.34.5", "0.33.1"],
          },
        ],
        dependency_vulnerabilities: ["semver@7.7.3:GHSA-c"],
      },
    };
    const out = renderTable(report([affected], bunProject), plain);
    expect(lastCells(out, "Advisories")).toEqual([
      "3 (1 affects 0.35.5)",
      "(installed affected: 0.33.1, 0.34.5)",
    ]);
    expect(row(out, "Dependency vulnerabilities")).toEqual(["1"]);
  });

  it("shortens long lists to the first two items", () => {
    const pulled = {
      ...zod,
      in_repo: zod.in_repo && { ...zod.in_repo, pulled_in_by: ["a", "b", "c", "d"] },
    };
    expect(lastCells(renderTable(report([pulled]), plain), "Pulled in by")).toEqual([
      "a",
      "b",
      "+2 more",
    ]);
  });

  it("omits the repo group when there is no project", () => {
    const out = renderTable(noProjectReport, plain);
    expect(out.split("\n").slice(0, 2)).toEqual(["No project found", "Measured on darwin-arm64"]);
    expect(out).not.toContain("In this repo");
    expect(out).not.toMatch(/^ {2}Installed /m);
    expect(out).not.toContain("Pulled in by");
    expect(row(out, "Peer deps")).toEqual(["none", "typescript >=5 optional"]);
    expect(row(out, "Advisories")).toEqual(["1 (0 affect 4.6.5)", "1 (0 affect 1.5.0)"]);
  });

  it("shows a package error in its column and keeps the other columns", () => {
    const out = renderTable(report([zod, missing]), plain);
    expect(out.split("\n")[4]?.trim().split(/\s+/)).toEqual(["zod", "zodd"]);
    const description = rowBlock(out, "Description").map((l) => l.slice(l.lastIndexOf("  ") + 2));
    expect(description.join(" ")).toContain("error: npm: package not found (404)");
    expect(row(out, "Installed")).toEqual(["4.6.5"]);
    expect(row(out, "Cost for")).toEqual(["4.6.5 (latest)"]);
    expect(row(out, "Weekly downloads")).toEqual(["334M"]);
  });

  it("renders null values as - and lists unavailable sources", () => {
    const out = renderTable(report([zod, yupWithoutGithub]), plain);
    expect(row(out, "Last commit")[1]).toBe("-");
    expect(row(out, "Commits last year")[1]).toBe("-");
    expect(row(out, "Deprecated / archived")[1]).toBe("no / -");
    expect(out.trimEnd().split("\n").slice(-2)).toEqual([
      "Unavailable data",
      "  yup: github: no token",
    ]);
  });

  it("renders a null description", () => {
    const bare: PackageReport = { ...yup, description: null, keywords: [] };
    expect(row(renderTable(report([bare]), plain), "Description")).toEqual(["-"]);
  });

  it("wraps deprecation messages verbatim next to the archived flag", () => {
    const message =
      "Use valibot instead. This package is no longer maintained and will not be updated.";
    const deprecated: PackageReport = {
      ...yup,
      maintenance: yup.maintenance && { ...yup.maintenance, deprecated: message, archived: true },
    };
    const block = lastCells(renderTable(report([deprecated]), plain), "Deprecated / archived");
    expect(block.length).toBeGreaterThan(1);
    expect(block.join(" ")).toBe(`"${message}" / yes`);
  });

  it("fits the width by stacking tables that repeat the labels", () => {
    const out = renderTable(report([zod, valibot, yup]), { width: 70, color: false });
    for (const l of out.split("\n")) expect(l.length).toBeLessThanOrEqual(70);
    expect(out.match(/^ {2}Weekly downloads/gm)).toHaveLength(3);
    expect(out.match(/^Maintenance$/gm)).toHaveLength(3);
    const lines = out.split("\n");
    const headers = lines.filter((_, i) => /^ {2}Description /.test(lines[i + 1] ?? ""));
    expect(headers.map((l) => l.trim())).toEqual(["zod", "valibot", "yup"]);
  });

  it("keeps every package in one table when they fit", () => {
    const wide = renderTable(report([zod, valibot, yup]), { width: 140, color: false });
    for (const l of wide.split("\n")) expect(l.length).toBeLessThanOrEqual(140);
    expect(wide.match(/^Maintenance$/gm)).toHaveLength(1);
  });

  it("truncates cells that do not fit a narrow terminal", () => {
    const out = renderTable(report([sharp], bunProject), { width: 50, color: false });
    for (const l of out.split("\n").slice(4)) expect(l.length).toBeLessThanOrEqual(50);
    expect(lastCells(out, "Native binaries")).toEqual([
      "@img/sharp-darwin-a…",
      "@img/sharp-libvips-…",
    ]);
    expect(lastCells(out, "Description")).toHaveLength(3);
  });

  it("emits no ANSI codes without color", () => {
    for (const out of [output, sharpOutput, renderTable(noProjectReport, plain)]) {
      expect(out).not.toContain("\x1b");
    }
  });

  it("only bolds package names and dims labels with color", () => {
    const out = renderTable(report([zod, valibot, yup]), { width: 120, color: true });
    expect(out).toContain("\x1b[1mzod\x1b[22m");
    expect(out).toContain("\x1b[2mMaintenance\x1b[22m");
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
    const codes = new Set(out.match(ansi));
    expect([...codes].sort()).toEqual(["\x1b[1m", "\x1b[22m", "\x1b[2m"]);
    expect(out.replace(ansi, "")).toBe(output);
  });
});

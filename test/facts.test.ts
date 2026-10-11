import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  atNewestInstalled,
  builtinFilesUsing,
  builtinReport,
  declaredRange,
  dependenciesOf,
  engineSatisfied,
  filesUsing,
  inRepoFacts,
  licensesInTree,
  type ProjectFacts,
  peerDependencyFacts,
  type TreePackage,
  treeCost,
  versionChange,
} from "../src/collect/facts.ts";
import type { LockIndex } from "../src/collect/lockfile.ts";
import { loadProject, type Project } from "../src/collect/project.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

type PkgOptions = Partial<Omit<TreePackage, "name" | "version" | "edges">> & {
  deps?: Record<string, string>;
};

/** A tree entry; `deps` are edges by name, and `path` defaults to a hoisted location. */
function pkg(name: string, version: string, options: PkgOptions = {}): TreePackage {
  const { deps = {}, ...rest } = options;
  return {
    path: `node_modules/${name}`,
    name,
    version,
    edges: Object.entries(deps).map(([dep, range]) => ({ key: dep, name: dep, range })),
    installed: true,
    diskBytes: 100,
    hasInstallScript: false,
    nativeBinary: false,
    license: "MIT",
    ...rest,
  };
}

async function load(...path: string[]): Promise<Project> {
  const project = await loadProject(join(FIXTURES, ...path));
  if (!project) throw new Error("fixture project not found");
  return project;
}

/** Project facts with nothing but `overrides`; the root is the current workspace. */
function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    lock: new Map(),
    workspace: ".",
    workspaces: [{ dir: ".", declared: new Map() }],
    catalogs: new Map(),
    sources: new Map(),
    ...overrides,
  };
}

function lock(entries: Record<string, string[]>): LockIndex {
  return new Map(
    Object.entries(entries).map(([name, versions]) => [
      name,
      new Map(versions.map((v) => [v, new Set<string>()])),
    ]),
  );
}

describe("project facts on the lockfile-* fixtures", () => {
  it.each(["lockfile-npm", "lockfile-pnpm", "lockfile-yarn", "lockfile-bun"])(
    "%s: zod is installed transitively and imported without being declared",
    async (dir) => {
      const project = await loadProject(join(FIXTURES, dir, "src"));
      if (!project) throw new Error("fixture project not found");

      expect(project.info.root).toBe(join(FIXTURES, dir));
      expect(project.info.workspace).toBe(join(FIXTURES, dir));
      expect(project.info.module_type).toBe("module");
      expect(project.info.packages_in_lockfile).toBe(92);

      const facts = inRepoFacts(project, "zod", "4.6.5");
      expect(facts.installed_versions).toEqual(["4.6.5"]);
      expect(facts.newest_installed).toBe("4.6.5");
      expect(facts.version_change_from_installed).toBe("same");
      expect(facts.in_package_json).toBeNull();
      expect(facts.declared_in_workspaces).toEqual([]);
      expect(facts.files_using).toEqual(["src/server.ts"]);
      expect(facts.pulled_in_by).toContain("@modelcontextprotocol/sdk");

      const express = inRepoFacts(project, "express", "5.0.0");
      expect(express.in_package_json).toBe("^5");
      expect(express.declared_in_workspaces).toEqual([{ workspace: ".", range: "^5" }]);
      expect(inRepoFacts(project, "typescript", "5.0.0").in_package_json).toBe("^5");
    },
  );

  it("reads the runtime from the lockfile and the range from engines", async () => {
    const npm = await loadProject(join(FIXTURES, "lockfile-npm"));
    expect(npm?.info).toMatchObject({ runtime: "node", runtime_range: ">=20" });
    const bun = await loadProject(join(FIXTURES, "lockfile-bun"));
    // bun.lock makes it a Bun project; engines only declares node.
    expect(bun?.info).toMatchObject({ runtime: "bun", runtime_range: null });
  });
});

describe("workspaces", () => {
  it.each([
    ["bun-workspace", "bun.lock", { runtime: "bun", runtime_range: "1.3.0" }],
    ["pnpm-workspace", "pnpm-lock.yaml", { runtime: "node", runtime_range: ">=22" }],
  ] as const)("%s: facts are for the workspace containing cwd", async (dir, lockfile, runtime) => {
    const root = join(FIXTURES, dir);
    const project = await load(dir, "apps", "web", "src");

    expect(project.info).toEqual({
      root,
      workspace: join(root, "apps", "web"),
      lockfile,
      packages_in_lockfile: 5,
      module_type: "module",
      ...runtime,
    });

    const zod = inRepoFacts(project, "zod", "4.6.5");
    expect(zod.in_package_json).toBe("^4.0.0");
    expect(zod.installed_versions).toEqual(["4.6.5"]);
    // examples/demo has a package.json but is not a workspace, so only its file counts.
    expect(zod.declared_in_workspaces).toEqual([
      { workspace: "apps/api", range: "^4.0.0" },
      { workspace: "apps/web", range: "^4.0.0" },
    ]);
    expect(zod.files_using).toEqual([
      "apps/api/src/server.ts",
      "apps/web/src/index.ts",
      "examples/demo/index.js",
    ]);

    const hono = inRepoFacts(project, "hono", "4.13.13");
    expect(hono).toMatchObject({
      installed_versions: ["4.13.13"],
      in_package_json: null,
      declared_in_workspaces: [{ workspace: "apps/api", range: "^4.13.0" }],
      files_using: ["apps/api/src/server.ts"],
    });

    const typescript = inRepoFacts(project, "typescript", "5.9.3");
    expect(typescript.in_package_json).toBeNull();
    expect(typescript.declared_in_workspaces).toEqual([{ workspace: ".", range: "^5.9.0" }]);
  });

  it.each(["bun-workspace", "pnpm-workspace"])(
    "%s: a package used only by a sibling workspace shows that workspace",
    async (dir) => {
      const project = await load(dir, "apps", "web");
      expect(inRepoFacts(project, "sonner", "2.0.7")).toEqual({
        installed_versions: ["2.0.7"],
        newest_installed: "2.0.7",
        version_change_from_installed: "same",
        // Only registry packages count as dependents, not the workspace package.
        pulled_in_by: [],
        in_package_json: null,
        declared_in_workspaces: [{ workspace: "packages/ui", range: "^2.0.7" }],
        files_using: ["packages/ui/src/toast.tsx"],
      });
      expect(inRepoFacts(project, "react", "19.2.0").pulled_in_by).toEqual(["sonner"]);
    },
  );

  it.each(["bun-workspace", "pnpm-workspace"])(
    "%s: catalog: references resolve to the catalog range",
    async (dir) => {
      const project = await load(dir, "packages", "ui", "src");
      expect(project.info.workspace).toBe(join(FIXTURES, dir, "packages", "ui"));
      const react = inRepoFacts(project, "react", "19.2.0");
      expect(react.in_package_json).toBe("catalog:");
      expect(react.declared_in_workspaces).toEqual([
        { workspace: "packages/ui", range: "catalog:" },
      ]);
      expect(declaredRange(project, "react")).toBe("^19.0.0");
      expect(declaredRange(project, "sonner")).toBe("^2.0.7");
      expect(declaredRange(project, "zod")).toBeNull();
    },
  );

  it("reads named pnpm catalogs", async () => {
    const project = await load("pnpm-workspace");
    expect(project.catalogs.get("legacy")?.get("react")).toBe("^18.0.0");
    const declared = new Map([["react", "catalog:legacy"]]);
    const legacy = { ...project, workspaces: [{ dir: ".", declared }] };
    expect(declaredRange(legacy, "react")).toBe("^18.0.0");
    const missing = {
      ...legacy,
      workspaces: [{ dir: ".", declared: new Map([["react", "catalog:nope"]]) }],
    };
    expect(declaredRange(missing, "react")).toBeNull();
  });

  it("uses the root as the workspace when run from the root", async () => {
    const root = join(FIXTURES, "bun-workspace");
    const project = await load("bun-workspace");
    expect(project.info.workspace).toBe(root);
    expect(project.info.module_type).toBe("commonjs");
    expect(inRepoFacts(project, "typescript", "5.9.3").in_package_json).toBe("^5.9.0");
    expect(inRepoFacts(project, "zod", "4.6.5").files_using).toEqual([
      "apps/api/src/server.ts",
      "apps/web/src/index.ts",
      "examples/demo/index.js",
    ]);
  });
});

describe("Cloudflare Workers runtime", () => {
  it.each([
    ["bun-workspace", "wrangler.toml"],
    ["pnpm-workspace", "wrangler.jsonc"],
  ])("%s: apps/api has a %s", async (dir) => {
    const api = await load(dir, "apps", "api", "src");
    expect(api.info).toMatchObject({ runtime: "cloudflare-workers", runtime_range: null });
    // Sibling workspaces keep their own runtime.
    const web = await load(dir, "apps", "web");
    expect(web.info.runtime).not.toBe("cloudflare-workers");
  });

  it("detects a wrangler dependency without a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depfit-workers-"));
    try {
      const manifest = { engines: { node: ">=22" }, devDependencies: { wrangler: "^4" } };
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      expect((await loadProject(dir))?.info).toMatchObject({
        runtime: "cloudflare-workers",
        runtime_range: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("builtins", () => {
  const sources = new Map([
    ["a.ts", 'import { readFile } from "node:fs/promises";'],
    ["b.js", "const fs = require('fs');"],
    ["c.ts", 'import { DatabaseSync } from "node:sqlite";'],
    ["d.ts", 'import sqlite from "sqlite";'],
    ["e.ts", 'import { Database } from "bun:sqlite";'],
    ["f.ts", 'import { glob } from "fs-extra";'],
  ]);

  it("matches the exact specifier, plus the bare form when Node has one", () => {
    expect(builtinFilesUsing(sources, "node:fs")).toEqual(["a.ts", "b.js"]);
    // "sqlite" is an npm package, not node:sqlite.
    expect(builtinFilesUsing(sources, "node:sqlite")).toEqual(["c.ts"]);
    expect(builtinFilesUsing(sources, "bun:sqlite")).toEqual(["e.ts"]);
  });

  it.each([
    ["bun-workspace", "bun:sqlite", ["apps/api/src/db.ts"]],
    ["pnpm-workspace", "node:sqlite", ["apps/api/src/db.ts"]],
    ["pnpm-workspace", "node:fs", ["apps/api/src/db.ts"]],
  ])("%s: %s lists files across the repo", async (dir, spec, files) => {
    const report = builtinReport(spec, await load(dir, "apps", "web"), []);
    expect(report.in_repo?.files_using).toEqual(files);
  });

  it("fills only in_repo files, a zero cost and null versions", () => {
    const report = builtinReport("node:sqlite", facts({ sources }), ["project: x"]);
    expect(report).toEqual({
      requested: "node:sqlite",
      kind: "builtin",
      name: "node:sqlite",
      version: null,
      version_source: null,
      latest_version: null,
      description: null,
      keywords: [],
      error: null,
      unavailable: ["project: x"],
      in_repo: {
        installed_versions: [],
        newest_installed: null,
        version_change_from_installed: null,
        pulled_in_by: [],
        in_package_json: null,
        declared_in_workspaces: [],
        files_using: ["c.ts"],
      },
      cost: {
        total_packages: 0,
        new_packages: [],
        reused_packages: [],
        new_install_bytes: 0,
        install_scripts: [],
        native_binaries: [],
        other_platform_packages: 0,
        at_newest_installed: null,
      },
      compatibility: null,
      maintenance: null,
      security: null,
    });
    expect(builtinReport("node:sqlite", null, []).in_repo).toBeNull();
  });
});

describe("filesUsing", () => {
  const sources = new Map([
    ["a.ts", 'import { z } from "zod";'],
    ["b.js", "const v = require('zod/v4');"],
    ["c.ts", 'const m = await import("zod");'],
    ["d.ts", 'import "zod-to-json-schema";'],
    ["e.ts", 'export * from "zod";'],
    ["f.ts", "// zod is great"],
  ]);

  it("matches imports, requires, dynamic imports, re-exports and subpaths only", () => {
    expect(filesUsing(sources, "zod")).toEqual(["a.ts", "b.js", "c.ts", "e.ts"]);
  });
});

describe("versionChange", () => {
  it("classifies version against the newest installed one", () => {
    expect(versionChange("1.2.3", null)).toBeNull();
    expect(versionChange("1.2.3", "1.2.3")).toBe("same");
    expect(versionChange("1.2.4", "1.2.3")).toBe("patch");
    expect(versionChange("1.3.0", "1.2.3")).toBe("minor");
    expect(versionChange("2.0.0", "1.2.3")).toBe("major");
    expect(versionChange("2.0.0-beta.1", "1.2.3")).toBe("major");
    expect(versionChange("1.0.0", "1.2.3")).toBe("older");
  });

  it("uses the highest installed version", async () => {
    const project = facts({ lock: lock({ sharp: ["0.33.1", "0.34.5"] }) });
    expect(inRepoFacts(project, "sharp", "0.35.5")).toMatchObject({
      installed_versions: ["0.33.1", "0.34.5"],
      newest_installed: "0.34.5",
      version_change_from_installed: "minor",
    });
  });
});

describe("atNewestInstalled", () => {
  it("costs nothing extra when a different version is already installed", () => {
    expect(atNewestInstalled("0.15.15", "0.17.3")).toEqual({
      version: "0.17.3",
      new_packages: [],
      new_install_bytes: 0,
    });
    expect(atNewestInstalled("2.0.0", "1.4.0")?.version).toBe("1.4.0");
  });

  it("is null when not installed or already the chosen version", () => {
    expect(atNewestInstalled("1.0.0", null)).toBeNull();
    expect(atNewestInstalled("1.0.0", "1.0.0")).toBeNull();
  });
});

describe("treeCost", () => {
  const yup = [
    pkg("yup", "1.7.1", {
      deps: { "tiny-case": "^1.0.3", toposort: "^2.0.2", "type-fest": "^2.19.0" },
    }),
    pkg("tiny-case", "1.0.3"),
    pkg("toposort", "2.0.2"),
    pkg("type-fest", "2.19.0"),
  ];
  const root = { name: "yup", version: "1.7.1" };

  it("treats everything as new without a lockfile", () => {
    const cost = treeCost(null, root, yup);
    expect(cost.total_packages).toBe(4);
    expect(cost.new_packages).toEqual([
      "tiny-case@1.0.3",
      "toposort@2.0.2",
      "type-fest@2.19.0",
      "yup@1.7.1",
    ]);
    expect(cost.reused_packages).toEqual([]);
    expect(cost.new_install_bytes).toBe(400);
  });

  it("reuses exact versions and locked versions satisfying the requested range", () => {
    const project = lock({
      toposort: ["2.0.2"],
      "type-fest": ["2.20.0", "4.0.0"],
      yup: ["0.32.11"],
    });
    const cost = treeCost(project, root, yup);
    expect(cost.new_packages).toEqual(["tiny-case@1.0.3", "yup@1.7.1"]);
    expect(cost.reused_packages).toEqual(["toposort@2.0.2", "type-fest@2.20.0"]);
    expect(cost.new_install_bytes).toBe(200);
  });

  it("adds nothing when version is exactly locked, whatever its subtree", () => {
    const project = lock({ yup: ["1.7.1"] });
    const cost = treeCost(project, root, yup);
    expect(cost.new_packages).toEqual([]);
    expect(cost.reused_packages).toEqual(["yup@1.7.1"]);
    expect(cost.new_install_bytes).toBe(0);
    expect(cost.total_packages).toBe(4);
  });

  it("reuses the root when the lockfile satisfies ^version", () => {
    const cost = treeCost(lock({ yup: ["1.8.0"] }), root, yup);
    expect(cost.new_packages).toEqual([]);
    expect(cost.reused_packages).toEqual(["yup@1.8.0"]);
  });

  it("does not count the children of a reused package", () => {
    // graphql (new) -> request ^10.0.0 (locked 10.0.7 reusable) -> types ^18 and content-type,
    // which the fresh install resolved to versions the lockfile lacks.
    const tree = [
      pkg("graphql", "9.0.5", { deps: { request: "^10.0.0", "user-agent": "^7.0.0" } }),
      pkg("request", "10.0.16", { deps: { types: "^18.0.0", "content-type": "^3.1.0" } }),
      pkg("types", "18.0.0"),
      pkg("content-type", "3.1.1"),
      pkg("user-agent", "7.0.3"),
    ];
    const project = lock({
      graphql: ["9.0.3"],
      request: ["10.0.7"],
      types: ["16.0.0"],
      "user-agent": ["7.0.3"],
    });
    const cost = treeCost(project, { name: "graphql", version: "9.0.5" }, tree);
    expect(cost.new_packages).toEqual(["graphql@9.0.5"]);
    expect(cost.reused_packages).toEqual(["request@10.0.7", "user-agent@7.0.3"]);
  });

  it("does not descend into a peer the lockfile satisfies", () => {
    const tree = [
      pkg("recharts", "3.10.1", {
        deps: { "react-dom": "^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0" },
      }),
      pkg("react-dom", "19.3.0", { deps: { scheduler: "^0.28.0" } }),
      pkg("scheduler", "0.28.0"),
    ];
    const project = lock({ "react-dom": ["19.2.3"], scheduler: ["0.27.0"] });
    const cost = treeCost(project, { name: "recharts", version: "3.10.1" }, tree);
    expect(cost.new_packages).toEqual(["recharts@3.10.1"]);
    expect(cost.reused_packages).toEqual(["react-dom@19.2.3"]);
  });

  it("resolves edges like Node, nearest node_modules first", () => {
    const tree = [
      pkg("a", "1.0.0", { deps: { b: "^1.0.0", c: "^1.0.0" } }),
      pkg("c", "1.0.0", { deps: { b: "^2.0.0" } }),
      pkg("b", "1.0.0"),
      pkg("b", "2.0.0", { path: "node_modules/c/node_modules/b" }),
    ];
    const cost = treeCost(lock({ b: ["1.0.0"] }), { name: "a", version: "1.0.0" }, tree);
    expect(cost.new_packages).toEqual(["a@1.0.0", "b@2.0.0", "c@1.0.0"]);
    expect(cost.reused_packages).toEqual(["b@1.0.0"]);
  });

  it("excludes optional packages for other platforms from every count", () => {
    const tree = [
      pkg("sharp", "0.35.5", {
        deps: {
          "@img/sharp-darwin-arm64": "0.35.5",
          "@img/sharp-linux-x64": "0.35.5",
          "@img/sharp-wasm32": "0.35.5",
          "detect-libc": "^2.1.0",
        },
        nativeBinary: true,
      }),
      pkg("@img/sharp-darwin-arm64", "0.35.5", { nativeBinary: true, diskBytes: 5000 }),
      pkg("@img/sharp-linux-x64", "0.35.5", { installed: false, diskBytes: 0 }),
      pkg("@img/sharp-wasm32", "0.35.5", {
        installed: false,
        diskBytes: 0,
        deps: { "@emnapi/runtime": "^1.0.0" },
      }),
      pkg("@emnapi/runtime", "1.11.3", { installed: false, diskBytes: 0 }),
      pkg("detect-libc", "2.1.2", { license: "Apache-2.0" }),
    ];
    const cost = treeCost(
      lock({ "detect-libc": ["2.1.2"] }),
      { name: "sharp", version: "0.35.5" },
      tree,
    );
    expect(cost).toEqual({
      total_packages: 3,
      new_packages: ["@img/sharp-darwin-arm64@0.35.5", "sharp@0.35.5"],
      reused_packages: ["detect-libc@2.1.2"],
      new_install_bytes: 5100,
      install_scripts: [],
      native_binaries: ["@img/sharp-darwin-arm64", "sharp"],
      other_platform_packages: 3,
    });
    expect(licensesInTree(tree)).toEqual(["Apache-2.0", "MIT"]);
    expect(dependenciesOf("sharp", tree).map((p) => p.name)).toEqual([
      "@img/sharp-darwin-arm64",
      "detect-libc",
    ]);
  });
});

describe("peerDependencyFacts", () => {
  it("reports the highest installed version and whether it satisfies the range", () => {
    const project = lock({ typescript: ["4.9.5", "5.9.3"] });
    expect(
      peerDependencyFacts({ typescript: ">=5", react: "^18" }, new Set(["react"]), project),
    ).toEqual([
      {
        name: "typescript",
        range: ">=5",
        optional: false,
        installed: "5.9.3",
        satisfied_by_lockfile: true,
      },
      {
        name: "react",
        range: "^18",
        optional: true,
        installed: null,
        satisfied_by_lockfile: false,
      },
    ]);
  });

  it("leaves installed and satisfied unknown without a project", () => {
    expect(peerDependencyFacts({ react: "^18" }, new Set(), null)).toEqual([
      {
        name: "react",
        range: "^18",
        optional: false,
        installed: null,
        satisfied_by_lockfile: null,
      },
    ]);
  });
});

describe("engineSatisfied", () => {
  it("compares the lowest allowed project runtime with the engine range", () => {
    expect(engineSatisfied(">=20", ">=18")).toBe(true);
    expect(engineSatisfied(">=18", ">=20.9.0")).toBe(false);
    expect(engineSatisfied("v22.3.0", "^20 || >=22")).toBe(true);
    expect(engineSatisfied("1.3.0", ">=1.3.14")).toBe(false);
  });

  it("is null when either side is unknown", () => {
    expect(engineSatisfied(null, ">=18")).toBeNull();
    expect(engineSatisfied(">=20", null)).toBeNull();
    expect(engineSatisfied("lts/*", ">=18")).toBeNull();
  });
});

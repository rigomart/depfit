import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleFacts, collapseNativeVariants, subpathExports } from "../src/collect/bundle.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "depfit-bundle-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes `node_modules/<name>` with the given manifest and files; returns the manifest. */
async function installed(
  name: string,
  manifest: Record<string, unknown>,
  entries: Record<string, string>,
) {
  const full = { name, version: "1.0.0", ...manifest };
  const all = { "package.json": JSON.stringify(full), ...entries };
  for (const [path, contents] of Object.entries(all)) {
    const file = join(dir, "node_modules", name, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  return full;
}

describe("bundleFacts", () => {
  it("bundles past a missing native addon and lists it", async () => {
    const manifest = await installed(
      "native-thing",
      { main: "lib/index.js" },
      {
        "lib/index.js":
          'const binding = require("../build/Release/x.node");\nmodule.exports = { get: () => binding.get() };\n',
      },
    );
    const bundle = await bundleFacts(dir, "native-thing", [], manifest);
    expect(bundle.errors).toEqual([]);
    expect(bundle.gzip_bytes_node_full_import).toBeGreaterThan(0);
    expect(bundle.unresolved_imports).toEqual(["x.node"]);
    expect(bundle.browser_compatible).toBe(false);
    expect(bundle.browser_named_exports).toBeNull();
  });

  it("lists a bare import that resolves to an installed .node file", async () => {
    await installed("thing-darwin", { main: "thing.darwin.node" }, { "thing.darwin.node": "\0" });
    const manifest = await installed(
      "thing",
      { main: "index.js" },
      { "index.js": 'module.exports = require("thing-darwin");\n' },
    );
    const bundle = await bundleFacts(dir, "thing", [], manifest);
    expect(bundle.errors).toEqual([]);
    expect(bundle.unresolved_imports).toEqual(["thing.darwin.node"]);
  });

  it("marks generated and missing relative paths external", async () => {
    const manifest = await installed(
      "generated-client",
      { type: "module", main: "index.js" },
      {
        "index.js":
          'import ".prisma/client/default";\nexport * from "./util.js";\nexport * from "./gen/index.js";\n',
        "util.js": "export const fromUtil = 1;\n",
        // "./util.js" is missing here but resolves from the package root, which must stay bundled.
        "gen/index.js": 'import "./util.js";\nexport const gen = 1;\n',
      },
    );
    const bundle = await bundleFacts(dir, "generated-client", [], manifest);
    expect(bundle.errors).toEqual([]);
    expect(bundle.gzip_bytes_node_full_import).toBeGreaterThan(0);
    expect(bundle.browser_named_exports).toBe(2);
    expect(bundle.unresolved_imports).toEqual(["./util.js", ".prisma/client/default"]);
  });

  it("lists subpath exports", async () => {
    const manifest = await installed(
      "subpaths",
      {
        type: "module",
        exports: {
          ".": "./index.js",
          "./element/adapter": "./element.js",
          "./*": "./*.js",
          "./package.json": "./package.json",
        },
      },
      { "index.js": "export {};\n", "element.js": "export const a = 1;\n" },
    );
    const bundle = await bundleFacts(dir, "subpaths", [], manifest);
    expect(bundle.browser_named_exports).toBe(0);
    expect(bundle.subpath_exports).toEqual(["./element/adapter", "./*"]);
  });
});

describe("subpath folders", () => {
  it("lists nested package.json folders with an entry point when there is no exports map", async () => {
    const manifest = await installed(
      "folders",
      { main: "dist/index.js" },
      {
        "dist/index.js": "module.exports = {};\n",
        "element/adapter/package.json": JSON.stringify({ main: "../../dist/adapter.js" }),
        "combine/package.json": JSON.stringify({ module: "../dist/combine.mjs" }),
        "docs/package.json": JSON.stringify({ name: "no-entry" }),
        "node_modules/dep/package.json": JSON.stringify({ main: "index.js" }),
        "a/b/c/d/package.json": JSON.stringify({ main: "too-deep.js" }),
      },
    );
    const bundle = await bundleFacts(dir, "folders", [], manifest);
    expect(bundle.subpath_exports).toEqual(["./combine", "./element/adapter"]);
  });

  it("ignores folders when an exports value exists", async () => {
    const manifest = await installed(
      "blocked",
      { exports: "./index.js" },
      { "index.js": "export {};\n", "sub/package.json": JSON.stringify({ main: "x.js" }) },
    );
    expect((await bundleFacts(dir, "blocked", [], manifest)).subpath_exports).toEqual([]);
  });
});

describe("collapseNativeVariants", () => {
  it("collapses per-platform builds of one module and keeps single files", () => {
    expect(
      collapseNativeVariants([
        "keyring.darwin-arm64.node",
        "keyring.linux-x64-gnu.node",
        "keyring.win32-x64-msvc.node",
        "keytar.node",
        ".prisma/client/default",
      ]),
    ).toEqual([".prisma/client/default", "keyring.*.node (3 variants)", "keytar.node"]);
  });
});

describe("subpathExports", () => {
  it("is empty without a subpath map", () => {
    expect(subpathExports({})).toEqual([]);
    expect(subpathExports({ exports: "./index.js" })).toEqual([]);
    expect(subpathExports({ exports: { import: "./a.mjs", require: "./a.cjs" } })).toEqual([]);
    expect(
      subpathExports({ exports: { ".": "./a.js", "./package.json": "./package.json" } }),
    ).toEqual([]);
  });
});

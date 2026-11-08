import { describe, expect, it } from "vitest";
import { byCodePoint, listSubpaths, subpathSpecifier } from "../src/collect/subpaths.ts";

const keys = (exports: unknown) => listSubpaths({ exports }).subpaths.map((s) => s.key);

describe("listSubpaths", () => {
  it("treats a missing, null, empty or false exports field as no map, as Vite does", () => {
    for (const manifest of [{}, { exports: null }, { exports: "" }, { exports: false }]) {
      expect(listSubpaths(manifest)).toEqual({ exportsMap: false, subpaths: [], patterns: [] });
    }
  });

  it("lists nothing for a string, an array, or root-only conditions", () => {
    const rootOnly = [
      "./index.js",
      ["./index.js", "./index.cjs"],
      { import: "./index.js", require: "./index.cjs" },
      { ".": "./index.js" },
    ];
    for (const exports of rootOnly) {
      expect(listSubpaths({ exports })).toEqual({ exportsMap: true, subpaths: [], patterns: [] });
    }
  });

  it("follows the first matching condition in the object's order, without falling through", () => {
    const exports = {
      "./a": { types: "./a.d.ts", import: "./a.mjs", require: "./a.cjs" },
      "./b": { require: "./b.cjs", default: "./b.js" },
      "./c": { node: "./c-node.js", browser: "./c-browser.js", default: "./c.js" },
      "./d": { import: { types: "./d.d.mts" }, default: "./d.js" },
      "./e": { development: "./e.dev.js", production: "./e.prod.js" },
      "./f": { module: "./f.mjs", import: "./f.js" },
    };
    expect(listSubpaths({ exports }).subpaths).toEqual([
      { key: "./a", target: "./a.mjs" },
      { key: "./b", target: "./b.js" },
      { key: "./c", target: "./c-browser.js" },
      { key: "./e", target: "./e.prod.js" },
      { key: "./f", target: "./f.mjs" },
    ]);
  });

  it("takes the first target of an array that resolves", () => {
    const exports = {
      "./a": [{ worker: "./a-worker.js" }, "./a.js"],
      "./b": [null, { import: "./b.mjs" }],
    };
    expect(listSubpaths({ exports }).subpaths).toEqual([
      { key: "./a", target: "./a.js" },
      { key: "./b", target: "./b.mjs" },
    ]);
  });

  it("leaves out null, types-only, Node-only and non-JS targets", () => {
    const exports = {
      "./blocked": null,
      "./internal": { types: "./internal.d.ts" },
      "./server": { node: "./server.js" },
      "./decl": "./types.d.ts",
      "./style.css": "./dist/style.css",
      "./data": "./data.json",
      "./wasm": "./engine.wasm",
      "./noext": "./dist/index",
      "./ok": "./ok.cjs",
      "./ui": "./ui.jsx",
    };
    expect(keys(exports)).toEqual(["./ok", "./ui"]);
  });

  it("admits exactly .js, .mjs, .cjs and .jsx targets", () => {
    const exports = {
      "./a": "./a.js",
      "./b": "./b.mjs",
      "./c": "./c.cjs",
      "./d": "./d.jsx",
      "./e": "./e.mjsx",
      "./f": "./f.cjsx",
      "./g": "./g.ts",
    };
    expect(keys(exports)).toEqual(["./a", "./b", "./c", "./d"]);
  });

  it("leaves out the root, ./package.json and folder keys, and lists aliases of one file", () => {
    const exports = {
      ".": "./index.js",
      "./package.json": "./package.json",
      "./dist/": "./dist/",
      "./core": "./core.js",
      "./core.js": "./core.js",
    };
    expect(listSubpaths({ exports }).subpaths).toEqual([
      { key: "./core", target: "./core.js" },
      { key: "./core.js", target: "./core.js" },
    ]);
  });

  it("reports every pattern key verbatim and in map order, whatever its target", () => {
    const exports = {
      "./lib/languages/*": { import: "./es/languages/*.js" },
      "./styles/*": "./styles/*",
      "./core": "./core.js",
      "./internal/*": null,
    };
    expect(listSubpaths({ exports })).toEqual({
      exportsMap: true,
      subpaths: [{ key: "./core", target: "./core.js" }],
      patterns: ["./lib/languages/*", "./styles/*", "./internal/*"],
    });
  });

  it("lists every key before any cap", () => {
    const exports = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`./m${i}`, `./m${i}.js`]),
    );
    expect(keys(exports)).toHaveLength(101);
  });
});

describe("subpathSpecifier", () => {
  it("joins the package name and the key without its ./", () => {
    expect(subpathSpecifier("highlight.js", "./lib/core")).toBe("highlight.js/lib/core");
    expect(subpathSpecifier("@scope/pkg", "./a.js")).toBe("@scope/pkg/a.js");
  });
});

describe("byCodePoint", () => {
  it("orders by code point, not UTF-16 unit, and shorter prefixes first", () => {
    // U+FF5E sorts before U+1F600 by code point, after it by UTF-16 unit.
    expect(["./\u{1F600}", "./\uFF5E", "./a", "./"].sort(byCodePoint)).toEqual([
      "./",
      "./a",
      "./\uFF5E",
      "./\u{1F600}",
    ]);
  });
});

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";
import {
  bundleEntry,
  bundleReasons,
  type ChunkInfo,
  chunkBytes,
  externalPackages,
  importsOutsideBundle,
  isNonJsModule,
  moduleLabel,
  splitChunks,
  unresolvedProblem,
} from "../src/collect/bundle.ts";
import { prepareBundleEntries } from "../src/collect/bundle-entry.ts";

const chunk = (fileName: string, rest: Partial<ChunkInfo> = {}): ChunkInfo => ({
  fileName,
  isEntry: false,
  imports: [],
  dynamicImports: [],
  code: `/*${fileName}*/`,
  ...rest,
});

const names = (chunks: ChunkInfo[]) => chunks.map((c) => c.fileName).sort();

describe("splitChunks", () => {
  it("counts the entry and its static closure as eager, dynamic-only chunks as lazy, once each", () => {
    const chunks = [
      chunk("entry.js", {
        isEntry: true,
        imports: ["shared.js", "react"],
        dynamicImports: ["a.js"],
      }),
      chunk("shared.js"),
      chunk("a.js", { imports: ["shared.js", "a-dep.js"], dynamicImports: ["b.js", "a.js"] }),
      chunk("a-dep.js"),
      chunk("b.js", { imports: ["a-dep.js"] }),
    ];
    const { eager, lazy } = splitChunks(chunks);
    expect(names(eager)).toEqual(["entry.js", "shared.js"]);
    expect(names(lazy)).toEqual(["a-dep.js", "a.js", "b.js"]);
  });

  it("puts a chunk that is both statically and dynamically imported in eager only", () => {
    const { eager, lazy } = splitChunks([
      chunk("entry.js", { isEntry: true, imports: ["x.js"], dynamicImports: ["x.js"] }),
      chunk("x.js"),
    ]);
    expect(names(eager)).toEqual(["entry.js", "x.js"]);
    expect(lazy).toEqual([]);
  });

  it("sums minified bytes and per-chunk gzip -9 bytes", () => {
    const entry = chunk("entry.js", { isEntry: true, code: "export const a = 1;" });
    const lazy = chunk("lazy.js", { code: "export const b = 'é';" });
    entry.dynamicImports = ["lazy.js"];
    const gz = (code: string) => gzipSync(code, { level: 9 }).byteLength;
    expect(chunkBytes([entry, lazy])).toEqual({
      eager_js_min_bytes: 19,
      eager_js_gzip9_bytes: gz(entry.code),
      lazy_js_min_bytes: 22,
      lazy_js_gzip9_bytes: gz(lazy.code),
    });
    expect(chunkBytes([{ ...entry, dynamicImports: [] }]).lazy_js_min_bytes).toBe(0);
  });
});

describe("importsOutsideBundle", () => {
  const parse = (code: string) => parseAst(code, { lang: "js", sourceType: "module" });
  const outside = (code: string, externals: string[] = []) =>
    importsOutsideBundle(
      [
        { fileName: "entry.js", code },
        { fileName: "a-1.js", code: "" },
      ],
      parse,
      externals,
    );

  it("allows imports of other emitted chunks and of externals and their subpaths", () => {
    expect(
      outside(
        'import{a}from"./a-1.js";import r from"react";import{jsx}from"react/jsx-runtime";export*from"./a-1.js";()=>import(`./a-1.js`)',
        ["react"],
      ),
    ).toEqual([]);
  });

  it("reports static, re-exported, remote, and computed imports outside the bundle", () => {
    expect(outside('import"./gone.js";export{x}from"react-dom";import r from"react"')).toEqual([
      "./gone.js",
      "react-dom",
      "react",
    ]);
    expect(outside("()=>import(`https://e.com/x.js`);()=>import('./a-1.js')")).toEqual([
      "https://e.com/x.js",
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the scanned code holds a template literal.
    expect(outside("let n=await import(`./lang/${e}.js`),m=await import(e)")).toEqual([
      "import(…)",
    ]);
  });

  it("ignores require calls, strings, and property names", () => {
    expect(outside('require("x");var s=`import("y")`,o={import:1};o.import')).toEqual([]);
  });
});

describe("bundleEntry on fixture packages", () => {
  const fixtures = fileURLToPath(new URL("./fixtures/bundle/", import.meta.url));

  /** Builds `snippet` from an install of the fixture packages; the first one is the candidate. */
  async function build(snippet: string, packages: string[], externals: string[] = []) {
    const [candidate = ""] = packages;
    const prepared = await prepareBundleEntries([snippet], [candidate]);
    const entry = prepared.ok ? prepared.entries.get(candidate) : undefined;
    if (!entry) throw new Error(prepared.ok ? "no entry" : prepared.message);
    const dir = await mkdtemp(join(tmpdir(), "depfit-bundle-test-"));
    try {
      await writeFile(join(dir, "package.json"), '{ "private": true }');
      for (const name of packages) {
        await cp(join(fixtures, name), join(dir, "node_modules", name), { recursive: true });
      }
      return await bundleEntry(dir, entry, externals);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ["url-import", "https://example.com/code.js"],
    ["template-url-import", "https://example.com/code.js"],
    ["computed-import", "import(…)"],
  ])("gives no number when the output of %s imports %s", async (name, specifier) => {
    expect(await build(`import * as m from "${name}"`, [name])).toEqual({
      bytes: null,
      problems: [{ code: "IMPORT_OUTSIDE_BUNDLE", specifier }],
    });
  });

  it.each([
    "module-require",
    "typeof-guarded-module",
    "global-require",
    "computed-global-require",
    "alias-require",
    "free-helper-require",
    "function-require",
    "new-function",
    "indirect-eval",
    "umd-define",
  ])("measures the emitted bytes of %s, which loads nothing through an import", async (name) => {
    const outcome = await build(`import * as m from "${name}"`, [name]);
    expect(outcome.problems).toEqual([]);
    expect(outcome.bytes?.eager_js_min_bytes).toBeGreaterThan(0);
  });

  it("treats imports between emitted chunks and of externals as part of the bundle", async () => {
    const lazy = await build('import * as m from "lazy-chunk"', ["lazy-chunk"]);
    expect(lazy.problems).toEqual([]);
    expect(lazy.bytes?.lazy_js_min_bytes).toBeGreaterThan(0);
    const peer = await build('import { run } from "with-peer"', ["with-peer", "peer"], ["peer"]);
    expect(peer.problems).toEqual([]);
  });

  it("measures JSON as Vite does: required whole, imported by name per field", async () => {
    const required = await build('import { version } from "json-cjs"', ["json-cjs"]);
    expect(required.problems).toEqual([]);
    expect(required.bytes?.eager_js_min_bytes).toBeGreaterThan(0);
    // data.json holds a 4000-character field the package never reads.
    const named = await build('import { read } from "json-named"', ["json-named"]);
    expect(named.problems).toEqual([]);
    expect(named.bytes?.eager_js_min_bytes).toBeLessThan(1000);
  });

  it("measures a binding named globalThis like any other name", async () => {
    const plain = await build('import { small } from "named"', ["named"]);
    const renamed = await build('import { small as globalThis } from "named"', ["named"]);
    expect(plain.problems).toEqual([]);
    expect(renamed).toEqual(plain);
  });
});

describe("bundle reasons and labels", () => {
  it("gives one entry per code with its first few names, sorted and without duplicates", () => {
    const outside = (specifier: string | null) => ({ code: "IMPORT_OUTSIDE_BUNDLE", specifier });
    expect(
      bundleReasons([
        { code: "UNRESOLVED_IMPORT", specifier: "node:path" },
        outside(null),
        { code: "UNRESOLVED_IMPORT", specifier: "fs" },
        { code: "UNRESOLVED_IMPORT", specifier: "fs" },
        { code: "NO_ENTRY", specifier: null },
      ]),
    ).toEqual([
      "bundle: IMPORT_OUTSIDE_BUNDLE",
      "bundle: NO_ENTRY",
      "bundle: UNRESOLVED_IMPORT fs, node:path",
    ]);
    expect(bundleReasons(["./e.js", "./d.js", "./c.js", "./b.js", "./a.js"].map(outside))).toEqual([
      "bundle: IMPORT_OUTSIDE_BUNDLE ./a.js, ./b.js, ./c.js (+2 more)",
    ]);
  });

  it("calls the snippet's own unresolvable import of the candidate NO_ENTRY", () => {
    const entries = ["/var/t/__depfit_entry.mjs", "/private/var/t/__depfit_entry.mjs"];
    const at = (source: string, importer?: string) =>
      unresolvedProblem(source, importer, entries, "@biomejs/biome").code;
    expect(at("@biomejs/biome", "/private/var/t/__depfit_entry.mjs")).toBe("NO_ENTRY");
    expect(at("@biomejs/biome/nope", "/var/t/__depfit_entry.mjs")).toBe("NO_ENTRY");
    expect(at("fs", "/var/t/__depfit_entry.mjs")).toBe("UNRESOLVED_IMPORT");
    expect(at("@biomejs/biome", "/var/t/node_modules/x/index.js")).toBe("UNRESOLVED_IMPORT");
    expect(at("fs")).toBe("UNRESOLVED_IMPORT");
  });

  it("labels modules by their path inside node_modules", () => {
    expect(moduleLabel("/tmp/depfit-x/node_modules/a/node_modules/unicorn-magic/default.js")).toBe(
      "unicorn-magic/default.js",
    );
    expect(moduleLabel("/tmp/depfit-x/node_modules/@uiw/md/markdown.css?inline")).toBe(
      "@uiw/md/markdown.css",
    );
    expect(moduleLabel("/tmp/depfit-x/__depfit_entry.mjs")).toBe("__depfit_entry.mjs");
  });

  it("treats CSS, wasm, and assets as non-JS, and JS, JSON, and extensionless files as JS", () => {
    for (const id of ["a/b.css", "a/b.wasm", "a/logo.svg?url", "a/font.woff2", "a/x.PNG"]) {
      expect(isNonJsModule(id), id).toBe(true);
    }
    for (const id of ["a/b.js", "a/b.cjs", "a/b.mjs", "a/data.json", "a/bin/cli", "a/.hidden"]) {
      expect(isNonJsModule(id), id).toBe(false);
    }
  });

  it("externalizes every peer that ships code, optional ones included", () => {
    expect(
      externalPackages({
        peerDependencies: { react: "^19", "react-dom": "^19", "@types/node": "*" },
        peerDependenciesMeta: { "@types/react": { optional: true }, vue: { optional: true } },
      }),
    ).toEqual(["react", "react-dom", "vue"]);
    expect(externalPackages({})).toEqual([]);
  });
});

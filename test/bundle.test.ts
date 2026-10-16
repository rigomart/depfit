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
  moduleLabel,
  problemsFromBuild,
  splitChunks,
  unresolvedProblem,
  type ViteBuildResult,
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
    // A require() of package.json keeps the whole JSON module, its 600-character description too.
    const required = await build('import { version } from "json-cjs"', ["json-cjs"]);
    expect(required.problems).toEqual([]);
    expect(required.bytes?.eager_js_min_bytes).toBeGreaterThan(600);
    // data.json holds a 4000-character field the package never reads.
    const named = await build('import { read } from "json-named"', ["json-named"]);
    expect(named.problems).toEqual([]);
    expect(named.bytes?.eager_js_min_bytes).toBeLessThan(1000);
  });

  it("measures Vite's production build, whatever the shell's NODE_ENV and VITE_ variables", async () => {
    const shell = { NODE_ENV: process.env.NODE_ENV, VITE_LEAK: process.env.VITE_LEAK };
    process.env.NODE_ENV = "development";
    process.env.VITE_LEAK = "from-shell";
    try {
      const outcome = await build('import { mode } from "env-dev"', ["env-dev"]);
      expect(outcome.problems).toEqual([]);
      // The development branch holds an 800-character warning; production drops it.
      expect(outcome.bytes?.eager_js_min_bytes).toBeLessThan(200);
    } finally {
      for (const [key, value] of Object.entries(shell)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("measures a package's browser:false mapping, and gives no number for a Node built-in", async () => {
    const mapped = await build('import { run } from "browser-false"', ["browser-false"]);
    expect(mapped.problems).toEqual([]);
    // server.js holds 4000 characters and is mapped away for browsers (Vite's stub is ~600 bytes).
    expect(mapped.bytes?.eager_js_min_bytes).toBeLessThan(2000);
    expect(await build('import { read } from "uses-fs"', ["uses-fs"])).toEqual({
      bytes: null,
      problems: [{ code: "UNRESOLVED_IMPORT", specifier: "node:fs" }],
    });
  });

  it.each(["alias-builtin", "alias-builtin-browser"])(
    "gives no number for a Node built-in behind an import alias (%s)",
    async (name) => {
      expect(await build(`import { u } from "${name}"`, [name])).toEqual({
        bytes: null,
        problems: [{ code: "UNRESOLVED_IMPORT", specifier: "#crypto" }],
      });
    },
  );

  it("measures a browser:false mapping named without its extension", async () => {
    const mapped = await build('import { run } from "browser-false-relative-noext"', [
      "browser-false-relative-noext",
    ]);
    expect(mapped.problems).toEqual([]);
    expect(mapped.bytes?.eager_js_min_bytes).toBeLessThan(2000);
  });

  it("measures a browser:false mapping of a Node built-in name, and a Worker made from bundled code", async () => {
    const mapped = await build('import { random } from "browser-false-builtin"', [
      "browser-false-builtin",
    ]);
    expect(mapped.problems).toEqual([]);
    const blob = await build('import { start } from "blob-worker"', ["blob-worker"]);
    expect(blob.problems).toEqual([]);
  });

  it("gives no number when Vite replaces a missing optional peer or member", async () => {
    const peer = await build('import { useMid } from "optional-peer-outer"', [
      "optional-peer-outer",
      "optional-peer-mid",
    ]);
    expect(peer.bytes).toBeNull();
    expect(peer.problems).toContainEqual({ code: "UNRESOLVED_IMPORT", specifier: "not-installed" });
    const member = await build('import * as m from "named"; m.nope', ["named"]);
    expect(member.bytes).toBeNull();
    expect(member.problems.map((p) => p.code)).toContain("MISSING_EXPORT");
  });

  it.each(["asset-url-large", "worker-url", "worker-inline", "css-import"])(
    "gives no number when Vite emits a non-JS file for %s",
    async (name) => {
      const outcome = await build(`import * as m from "${name}"`, [name]);
      expect(outcome.bytes).toBeNull();
      expect(new Set(outcome.problems.map((p) => p.code))).toEqual(new Set(["NON_JS_IMPORT"]));
    },
  );

  it("gives no number for an inline worker, whose separate build depfit's checks and peer exclusion do not reach", async () => {
    const outcome = await build(
      'import { start } from "worker-inline-peer"',
      ["worker-inline-peer", "peer"],
      ["peer"],
    );
    expect(outcome.bytes).toBeNull();
    expect(outcome.problems).toEqual([
      { code: "NON_JS_IMPORT", specifier: "worker worker-inline-peer/worker.js" },
    ]);
  });

  it("counts what Vite inlines into the JS, and leaves files loaded by path at runtime out", async () => {
    // A small image becomes a data URL inside the JS: its bytes are in the number, unlike the same
    // code whose image file is missing (left as a URL loaded at runtime).
    const inlined = await build('import * as m from "asset-url"', ["asset-url"]);
    const missing = await build('import * as m from "asset-url-missing"', ["asset-url-missing"]);
    expect(inlined.problems).toEqual([]);
    expect(inlined.bytes?.eager_js_min_bytes ?? 0).toBeGreaterThan(
      (missing.bytes?.eager_js_min_bytes ?? 0) + 100,
    );
    for (const name of ["asset-url-missing", "worker-file", "worker-remote"]) {
      const outcome = await build(`import * as m from "${name}"`, [name]);
      expect(outcome.problems, name).toEqual([]);
    }
  });

  it("turns a CommonJS require() of a peer into an import, with no runtime require helper", async () => {
    const outcome = await build('import { make } from "cjs-peer"', ["cjs-peer", "peer"], ["peer"]);
    expect(outcome.problems).toEqual([]);
    // With plain `external`, Vite's runtime `require` shim makes this 536 bytes.
    expect(outcome.bytes?.eager_js_min_bytes).toBeLessThan(400);
  });

  it("measures a binding named globalThis like any other name", async () => {
    const plain = await build('import { small } from "named"', ["named"]);
    const renamed = await build('import { small as globalThis } from "named"', ["named"]);
    expect(plain.problems).toEqual([]);
    expect(renamed).toEqual(plain);
  });
});

describe("problemsFromBuild", () => {
  const result = (rest: Partial<ViteBuildResult>): ViteBuildResult => ({
    vite: "8.3.4",
    rolldown: "1.2.14",
    resolutions: [],
    logs: [],
    chunks: [],
    assets: [],
    workers: [],
    errors: null,
    ...rest,
  });
  const parse = (code: string) => parseAst(code, { lang: "js", sourceType: "module" });

  it("names a module by its path inside node_modules, never the install directory", () => {
    const log = (exporter: string) => ({
      level: "warn",
      code: "MISSING_EXPORT",
      plugin: null,
      exporter,
      id: null,
    });
    const problems = problemsFromBuild(
      result({
        logs: [
          log("/private/var/folders/x/depfit-abc/node_modules/unicorn-magic/default.js"),
          log("node_modules/other/index.js"),
        ],
      }),
      [],
      "execa",
      parse,
    );
    expect(problems.map((p) => p.specifier)).toEqual([
      "unicorn-magic/default.js",
      "other/index.js",
    ]);
  });

  it("keeps a bare specifier as written", () => {
    const problems = problemsFromBuild(
      result({
        logs: [
          {
            level: "warn",
            code: "UNRESOLVED_IMPORT",
            plugin: null,
            exporter: "@scope/pkg",
            id: null,
          },
        ],
      }),
      [],
      "x",
      parse,
    );
    expect(problems).toEqual([{ code: "UNRESOLVED_IMPORT", specifier: "@scope/pkg" }]);
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
    const at = (source: string, fromEntry: boolean) =>
      unresolvedProblem(source, fromEntry, "@biomejs/biome").code;
    expect(at("@biomejs/biome", true)).toBe("NO_ENTRY");
    expect(at("@biomejs/biome/nope", true)).toBe("NO_ENTRY");
    expect(at("fs", true)).toBe("UNRESOLVED_IMPORT");
    expect(at("@biomejs/biome", false)).toBe("UNRESOLVED_IMPORT");
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

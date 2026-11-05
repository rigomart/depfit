import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BundleOutcome } from "../src/collect/bundle.ts";
import { bundleSkipped } from "../src/collect/index.ts";
import { browserSignals, loadProject } from "../src/collect/project.ts";
import {
  EXPORT_LIMIT,
  measureRootEntry,
  medianBytes,
  type RootEntryMeasurement,
  rootEntryFacts,
} from "../src/collect/root-entry.ts";
import { browserProject } from "./reports.ts";

const BUNDLER = "vite@8.3.4 (rolldown@1.2.14)";
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

const ok = (gzip: number): BundleOutcome => ({
  bytes: {
    eager_js_min_bytes: gzip * 3,
    eager_js_gzip9_bytes: gzip,
    lazy_js_min_bytes: 0,
    lazy_js_gzip9_bytes: 0,
  },
  problems: [],
});
const failed = (code: string, specifier: string | null = null): BundleOutcome => ({
  bytes: null,
  problems: [{ code, specifier }],
});

describe("browserSignals", () => {
  it("lists UI runtimes, then frameworks, then index.html and the browser field", () => {
    const manifest = {
      dependencies: { next: "16", "react-dom": "19" },
      devDependencies: { preact: "10" },
      browser: { "./server.js": false },
    };
    expect(browserSignals(manifest, true)).toEqual([
      "react-dom",
      "preact",
      "next",
      "index.html",
      "browser",
    ]);
  });

  it("does not count build tools, peers, or optional dependencies", () => {
    const manifest = {
      devDependencies: { vite: "8", webpack: "5", rollup: "4", esbuild: "0.25", parcel: "2" },
      peerDependencies: { "react-dom": "19" },
      optionalDependencies: { vue: "3" },
    };
    expect(browserSignals(manifest, false)).toEqual([]);
  });

  it("reads the workspace's own package.json and directory", async () => {
    const project = await loadProject(join(fixtures, "browser-app"));
    expect(project?.info.browser_signals).toEqual(["preact", "index.html"]);
  });
});

describe("bundleSkipped", () => {
  const info = (browser_signals: string[]) => ({ info: { ...browserProject, browser_signals } });

  it("measures only a workspace with a browser signal, unless DEPFIT_BUNDLE=0", () => {
    expect(bundleSkipped(info(["preact"]), {})).toBeNull();
    expect(bundleSkipped(info([]), {})).toBe("bundle: skipped, no browser signal in workspace");
    expect(bundleSkipped(null, {})).toBe("bundle: skipped, no browser signal in workspace");
    expect(bundleSkipped(info(["preact"]), { DEPFIT_BUNDLE: "0" })).toBe(
      "bundle: skipped, DEPFIT_BUNDLE=0",
    );
  });
});

describe("rootEntryFacts", () => {
  const measurement = (rest: Partial<RootEntryMeasurement>): RootEntryMeasurement => ({
    whole: ok(1000),
    names: ["a", "b", "c"],
    listProblems: [],
    singles: [
      { name: "a", outcome: ok(100) },
      { name: "b", outcome: ok(300) },
      { name: "c", outcome: ok(200) },
    ],
    ...rest,
  });

  it("reports the whole build and the median of the measured exports", () => {
    expect(rootEntryFacts(measurement({}), BUNDLER, ["react"])).toEqual({
      bundle: {
        bundler: BUNDLER,
        target: "browser",
        entry_point: ".",
        whole_eager_js_min_bytes: 3000,
        whole_eager_js_gzip9_bytes: 1000,
        whole_lazy_js_min_bytes: 0,
        whole_lazy_js_gzip9_bytes: 0,
        exports: 3,
        exports_measured: 3,
        single_export_median_eager_js_gzip9_bytes: 200,
        external_packages: ["react"],
      },
      reasons: [],
    });
  });

  it("leaves failed exports out of the median and counts them in one entry", () => {
    const facts = rootEntryFacts(
      measurement({
        names: ["a", "b", "c", "d"],
        singles: [
          { name: "a", outcome: ok(100) },
          { name: "b", outcome: failed("UNRESOLVED_IMPORT", "node:fs") },
          { name: "c", outcome: ok(201) },
          { name: "d", outcome: failed("NON_JS_IMPORT", "style.css") },
        ],
      }),
      BUNDLER,
      [],
    );
    expect(facts.bundle).toMatchObject({
      exports: 4,
      exports_measured: 2,
      single_export_median_eager_js_gzip9_bytes: 151,
    });
    expect(facts.reasons).toEqual([
      "bundle: 2 exports unmeasurable (NON_JS_IMPORT, UNRESOLVED_IMPORT)",
    ]);
  });

  it("gives one entry per cause when the whole build and every export fail for it", () => {
    const fs = failed("UNRESOLVED_IMPORT", "node:fs");
    const facts = rootEntryFacts(
      measurement({
        whole: fs,
        names: ["a", "b"],
        singles: [
          { name: "a", outcome: fs },
          { name: "b", outcome: failed("UNRESOLVED_IMPORT", "node:path") },
        ],
      }),
      BUNDLER,
      [],
    );
    expect(facts.bundle).toMatchObject({ exports: 2, exports_measured: 0 });
    expect(facts.reasons).toEqual(["bundle: UNRESOLVED_IMPORT node:fs"]);
  });

  it("counts in the summary only the exports that fail for a cause the whole build does not", () => {
    const fs = failed("UNRESOLVED_IMPORT", "node:fs");
    const both: BundleOutcome = {
      bytes: null,
      problems: [...fs.problems, { code: "NON_JS_IMPORT", specifier: "a.css" }],
    };
    const facts = rootEntryFacts(
      measurement({
        whole: fs,
        names: ["a", "b", "c"],
        singles: [
          { name: "a", outcome: fs },
          { name: "b", outcome: both },
          { name: "c", outcome: ok(10) },
        ],
      }),
      BUNDLER,
      [],
    );
    expect(facts.reasons).toEqual([
      "bundle: UNRESOLVED_IMPORT node:fs",
      "bundle: 1 exports unmeasurable (NON_JS_IMPORT)",
    ]);
  });

  it("reports a failed export that recorded no problem as BUILD_ERROR", () => {
    const facts = rootEntryFacts(
      measurement({
        whole: failed("UNRESOLVED_IMPORT", "node:fs"),
        names: ["a"],
        singles: [{ name: "a", outcome: { bytes: null, problems: [] } }],
      }),
      BUNDLER,
      [],
    );
    expect(facts.reasons).toEqual([
      "bundle: UNRESOLVED_IMPORT node:fs",
      "bundle: 1 exports unmeasurable (BUILD_ERROR)",
    ]);
  });

  it("does not repeat a listing failure whose code the whole build reports", () => {
    const facts = rootEntryFacts(
      measurement({
        whole: failed("UNRESOLVED_IMPORT", "missing-dep"),
        names: null,
        listProblems: [
          { code: "UNRESOLVED_IMPORT", specifier: "missing-dep" },
          { code: "UNRESOLVED_IMPORT", specifier: "other" },
        ],
        singles: null,
      }),
      BUNDLER,
      [],
    );
    expect(facts.reasons).toEqual(["bundle: UNRESOLVED_IMPORT missing-dep"]);
  });

  it("keeps the whole build's reason and reports a listing failure only once", () => {
    const problem = failed("UNRESOLVED_IMPORT", "missing-dep");
    const facts = rootEntryFacts(
      measurement({ whole: problem, names: null, listProblems: problem.problems, singles: null }),
      BUNDLER,
      [],
    );
    expect(facts.bundle).toMatchObject({
      whole_eager_js_min_bytes: null,
      whole_lazy_js_gzip9_bytes: null,
      exports: null,
      exports_measured: null,
      single_export_median_eager_js_gzip9_bytes: null,
    });
    expect(facts.reasons).toEqual(["bundle: UNRESOLVED_IMPORT missing-dep"]);
  });

  it("does not build exports over the cap, and still reports the whole build", () => {
    const names = Array.from({ length: EXPORT_LIMIT + 1 }, (_, i) => `e${i}`);
    const facts = rootEntryFacts(measurement({ names, singles: null }), BUNDLER, []);
    expect(facts.bundle).toMatchObject({
      whole_eager_js_gzip9_bytes: 1000,
      exports: 1001,
      exports_measured: null,
      single_export_median_eager_js_gzip9_bytes: null,
    });
    expect(facts.reasons).toEqual(["bundle: EXPORT_LIMIT 1001"]);
  });

  it("takes the median of an even count as the rounded mean of the middle two", () => {
    expect(medianBytes([])).toBeNull();
    expect(medianBytes([5])).toBe(5);
    expect(medianBytes([4, 1, 2, 3])).toBe(3);
    expect(medianBytes([10, 1, 4])).toBe(4);
  });
});

describe("measureRootEntry on fixture packages", () => {
  async function measure(name: string, packages: string[] = [name], externals: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    try {
      await writeFile(join(dir, "package.json"), '{ "private": true }');
      for (const pkg of packages) {
        await cp(join(fixtures, "bundle", pkg), join(dir, "node_modules", pkg), {
          recursive: true,
        });
      }
      return await measureRootEntry(dir, name, externals);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("builds every export alone, default included, and measures the rest when one fails", async () => {
    const result = await measure("root-mixed");
    expect(result.whole).toEqual(failed("IMPORT_OUTSIDE_BUNDLE", "https://example.com/code.js"));
    expect(result.names).toEqual(["default", "large", "remote", "small"]);
    const byName = Object.fromEntries((result.singles ?? []).map((s) => [s.name, s.outcome]));
    expect(byName.remote).toEqual(failed("IMPORT_OUTSIDE_BUNDLE", "https://example.com/code.js"));
    for (const name of ["default", "large", "small"]) expect(byName[name]?.problems).toEqual([]);
    const large = byName.large?.bytes?.eager_js_min_bytes ?? 0;
    expect(large).toBeGreaterThan(byName.small?.bytes?.eager_js_min_bytes ?? Infinity);
  });

  it("lists only named exports when there is no default", async () => {
    const result = await measure("named");
    expect(result.names).toEqual(["large", "small"]);
    expect(result.whole.problems).toEqual([]);
    expect(result.singles?.every((s) => s.outcome.bytes !== null)).toBe(true);
  });

  it("resolves a CommonJS module to its default export alone", async () => {
    const result = await measure("umd-define");
    expect(result.names).toEqual(["default"]);
    expect(result.singles?.[0]?.outcome.problems).toEqual([]);
  });

  it("leaves peers out of every build", async () => {
    const result = await measure("with-peer", ["with-peer", "peer"], ["peer"]);
    expect(result.whole.problems).toEqual([]);
    expect(result.names).toEqual(["run"]);
    expect(result.singles?.[0]?.outcome.problems).toEqual([]);
  });

  it("fails every export the same way when the package imports a Node built-in", async () => {
    const result = await measure("uses-fs");
    expect(result.whole).toEqual(failed("UNRESOLVED_IMPORT", "node:fs"));
    expect(result.singles?.map((s) => s.outcome)).toEqual([failed("UNRESOLVED_IMPORT", "node:fs")]);
  });

  it("lists no exports for a package with no root entry point", async () => {
    const result = await measure("no-entry");
    expect(result.whole).toEqual(failed("NO_ENTRY", "no-entry"));
    expect(result.names).toBeNull();
    expect(result.listProblems).toEqual([{ code: "NO_ENTRY", specifier: "no-entry" }]);
  });
});

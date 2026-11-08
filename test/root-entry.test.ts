import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  readListing,
  type RootEntryMeasurement,
  cacheableMeasurement,
  measureForReport,
  rootEntryBundle,
  rootEntryFacts,
  REPORT_SUBPATH_LIMIT,
  type ListingResult,
  type SubpathMeasurement,
  subpathDetail,
  unbuiltSubpaths,
} from "../src/collect/root-entry.ts";
import { SUBPATH_LIMIT } from "../src/collect/subpaths.ts";
import { createVitePool } from "../src/collect/vite-pool.ts";
import { browserProject } from "./reports.ts";

const BUNDLER = "vite@8.3.4 (rolldown@1.2.14)";
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

const ok = (gzip: number, externals: string[] = []): BundleOutcome => ({
  bytes: {
    eager_js_min_bytes: gzip * 3,
    eager_js_gzip9_bytes: gzip,
    lazy_js_min_bytes: 0,
    lazy_js_gzip9_bytes: 0,
  },
  problems: [],
  externals,
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
    subpaths: { exportsMap: true, listed: 0, patterns: [], subpaths: [], reason: null },
    ...rest,
  });

  it("reports the whole build and the median of the measured exports", () => {
    const withReact = measurement({ whole: ok(1000, ["react"]) });
    expect(rootEntryFacts(withReact, BUNDLER, "2026-11-08T12:00:00.000Z")).toEqual({
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
        exports_map: true,
        subpaths_listed: 0,
        subpaths_whole_eager_js_gzip9_bytes: {},
        subpath_patterns_unmeasured: [],
        measured_at: "2026-11-08T12:00:00.000Z",
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
    );
    expect(facts.reasons).toEqual(["bundle: UNRESOLVED_IMPORT missing-dep"]);
  });

  it("keeps the whole build's reason and reports a listing failure only once", () => {
    const problem = failed("UNRESOLVED_IMPORT", "missing-dep");
    const facts = rootEntryFacts(
      measurement({ whole: problem, names: null, listProblems: problem.problems, singles: null }),
      BUNDLER,
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
    const facts = rootEntryFacts(measurement({ names, singles: null }), BUNDLER);
    expect(facts.bundle).toMatchObject({
      whole_eager_js_gzip9_bytes: 1000,
      exports: 1001,
      exports_measured: null,
      single_export_median_eager_js_gzip9_bytes: null,
    });
    expect(facts.reasons).toEqual(["bundle: EXPORT_LIMIT 1001"]);
  });

  it("lists the peers any measured build imports, and null when no build was measured", () => {
    const facts = rootEntryFacts(
      measurement({
        whole: failed("UNRESOLVED_IMPORT", "node:fs"),
        singles: [
          { name: "a", outcome: ok(100, ["react"]) },
          { name: "b", outcome: ok(100, ["react-dom", "react"]) },
          { name: "c", outcome: failed("UNRESOLVED_IMPORT", "node:fs") },
        ],
      }),
      BUNDLER,
    );
    expect(facts.bundle.external_packages).toEqual(["react", "react-dom"]);
    const none = rootEntryFacts(
      measurement({ whole: failed("NO_ENTRY", "x"), names: null, singles: null }),
      BUNDLER,
    );
    expect(none.bundle.external_packages).toBeNull();
  });

  const withSubpaths = (subpaths: Partial<SubpathMeasurement>, rest = {}) =>
    measurement({
      subpaths: {
        exportsMap: true,
        listed: subpaths.subpaths?.length ?? 0,
        patterns: [],
        subpaths: [],
        reason: null,
        ...subpaths,
      },
      ...rest,
    });

  it("maps each subpath to its whole eager gzip bytes and names each null key by code", () => {
    const measured = withSubpaths({
      patterns: ["./lang/*"],
      subpaths: [
        { key: "./core", outcome: ok(400, ["react"]) },
        { key: "./node", outcome: failed("UNRESOLVED_IMPORT", "node:fs") },
        { key: "./silent", outcome: { bytes: null, problems: [] } },
        { key: "./tty", outcome: failed("UNRESOLVED_IMPORT", "node:tty") },
      ],
    });
    const facts = rootEntryFacts(measured, BUNDLER);
    expect(facts.bundle).toMatchObject({
      external_packages: [],
      exports_map: true,
      subpaths_listed: 4,
      subpaths_whole_eager_js_gzip9_bytes: {
        "./core": 400,
        "./node": null,
        "./silent": null,
        "./tty": null,
      },
      subpath_patterns_unmeasured: ["./lang/*"],
    });
    expect(Object.keys(facts.bundle.subpaths_whole_eager_js_gzip9_bytes ?? {})).toEqual([
      "./core",
      "./node",
      "./silent",
      "./tty",
    ]);
    expect(facts.reasons).toEqual([
      'bundle: BUILD_ERROR in subpaths ["./silent"]',
      'bundle: UNRESOLVED_IMPORT in subpaths ["./node","./tty"]',
    ]);
    expect(subpathDetail(measured)).toEqual([
      {
        entry_point: "./core",
        whole_eager_js_gzip9_bytes: 400,
        whole_lazy_js_gzip9_bytes: 0,
        external_packages: ["react"],
        unmeasurable_codes: [],
      },
      {
        entry_point: "./node",
        whole_eager_js_gzip9_bytes: null,
        whole_lazy_js_gzip9_bytes: null,
        external_packages: null,
        unmeasurable_codes: ["UNRESOLVED_IMPORT"],
      },
      {
        entry_point: "./silent",
        whole_eager_js_gzip9_bytes: null,
        whole_lazy_js_gzip9_bytes: null,
        external_packages: null,
        unmeasurable_codes: ["BUILD_ERROR"],
      },
      {
        entry_point: "./tty",
        whole_eager_js_gzip9_bytes: null,
        whole_lazy_js_gzip9_bytes: null,
        external_packages: null,
        unmeasurable_codes: ["UNRESOLVED_IMPORT"],
      },
    ]);
  });

  it("appends a subpath code to the root entry that already reports it, one entry per cause", () => {
    const facts = rootEntryFacts(
      withSubpaths(
        {
          subpaths: [
            { key: "./a", outcome: failed("UNRESOLVED_IMPORT", "node:fs") },
            { key: "./b", outcome: failed("NON_JS_IMPORT", "worker x.js") },
            { key: "./c", outcome: failed("MISSING_EXPORT", "y") },
            { key: "./d", outcome: ok(10) },
          ],
        },
        {
          whole: failed("UNRESOLVED_IMPORT", "node:path"),
          singles: [
            { name: "a", outcome: failed("MISSING_EXPORT", "z") },
            { name: "b", outcome: ok(10) },
            { name: "c", outcome: ok(10) },
          ],
        },
      ),
      BUNDLER,
    );
    expect(facts.reasons).toEqual([
      'bundle: UNRESOLVED_IMPORT node:path; UNRESOLVED_IMPORT in subpaths ["./a"]',
      'bundle: 1 exports unmeasurable (MISSING_EXPORT); MISSING_EXPORT in subpaths ["./c"]',
      'bundle: NON_JS_IMPORT in subpaths ["./b"]',
    ]);
    for (const code of ["UNRESOLVED_IMPORT", "MISSING_EXPORT", "NON_JS_IMPORT"]) {
      expect(facts.reasons.filter((reason) => reason.includes(code))).toHaveLength(1);
    }
  });

  it("gives each state of the subpaths its fields and at most one entry of its own", () => {
    const state = (subpaths: Partial<SubpathMeasurement>) => {
      const { bundle, reasons } = rootEntryFacts(withSubpaths(subpaths), BUNDLER);
      return {
        exports_map: bundle.exports_map,
        listed: bundle.subpaths_listed,
        map: bundle.subpaths_whole_eager_js_gzip9_bytes,
        patterns: bundle.subpath_patterns_unmeasured,
        reasons,
      };
    };
    expect(state({ exportsMap: false, listed: 0, subpaths: null })).toEqual({
      exports_map: false,
      listed: 0,
      map: null,
      patterns: [],
      reasons: [],
    });
    expect(state({ patterns: ["./x/*"] })).toEqual({
      exports_map: true,
      listed: 0,
      map: {},
      patterns: ["./x/*"],
      reasons: [],
    });
    const over = `bundle: SUBPATH_LIMIT ${REPORT_SUBPATH_LIMIT + 1}`;
    expect(state({ listed: REPORT_SUBPATH_LIMIT + 1, subpaths: null, reason: over })).toEqual({
      exports_map: true,
      listed: REPORT_SUBPATH_LIMIT + 1,
      map: null,
      patterns: [],
      reasons: [over],
    });
    const unreadable = "bundle: SUBPATH_LIST_FAILED x/package.json ENOENT";
    expect(
      state({ exportsMap: null, listed: null, patterns: null, subpaths: null, reason: unreadable }),
    ).toEqual({
      exports_map: null,
      listed: null,
      map: null,
      patterns: null,
      reasons: [unreadable],
    });
  });

  it("names a subpath that fails for two codes once per code, and escapes keys as JSON", () => {
    const both: BundleOutcome = {
      bytes: null,
      problems: [
        { code: "UNRESOLVED_IMPORT", specifier: "node:fs" },
        { code: "NON_JS_IMPORT", specifier: "a.css" },
      ],
    };
    const facts = rootEntryFacts(
      withSubpaths(
        {
          subpaths: [
            { key: "./a,./b", outcome: both },
            { key: './q"uote', outcome: failed("UNRESOLVED_IMPORT", "node:path") },
          ],
        },
        { whole: failed("NON_JS_IMPORT", "x.css") },
      ),
      BUNDLER,
    );
    expect(facts.reasons).toEqual([
      'bundle: NON_JS_IMPORT x.css; NON_JS_IMPORT in subpaths ["./a,./b"]',
      'bundle: UNRESOLVED_IMPORT in subpaths ["./a,./b","./q\\"uote"]',
    ]);
  });

  it("gives null subpath fields when the subpaths were not measured at all", () => {
    const { bundle } = rootEntryFacts(measurement({ subpaths: null }), BUNDLER);
    expect(bundle).toMatchObject({
      exports_map: null,
      subpaths_listed: null,
      subpaths_whole_eager_js_gzip9_bytes: null,
      subpath_patterns_unmeasured: null,
    });
  });

  it("takes the median of an even count as the rounded mean of the middle two", () => {
    expect(medianBytes([])).toBeNull();
    expect(medianBytes([5])).toBe(5);
    expect(medianBytes([4, 1, 2, 3])).toBe(3);
    expect(medianBytes([10, 1, 4])).toBe(4);
  });
});

describe("rootEntryBundle, the CLI's call", () => {
  const runner = (name: string) =>
    fileURLToPath(new URL(`./fixtures/runner/${name}`, import.meta.url));
  async function install(manifest?: Record<string, unknown> | null) {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    const pkg = join(dir, "node_modules", "with-subpaths");
    await cp(join(fixtures, "bundle", "with-subpaths"), pkg, { recursive: true });
    if (manifest === null) await rm(join(pkg, "package.json"));
    else if (manifest) await writeFile(join(pkg, "package.json"), JSON.stringify(manifest));
    return dir;
  }
  const withKeys = (count: number) => ({
    name: "with-subpaths",
    type: "module",
    exports: {
      ".": "./index.js",
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`./m${i}`, "./core.js"])),
    },
  });

  it("gives a null map and only the root's entry after a toolchain mismatch", async () => {
    const dir = await install();
    try {
      const facts = await rootEntryBundle(
        dir,
        "with-subpaths",
        {},
        {
          runnerScript: runner("other-toolchain.mjs"),
        },
      );
      expect(facts.bundle).toMatchObject({
        exports_map: true,
        subpaths_listed: 3,
        subpaths_whole_eager_js_gzip9_bytes: null,
        subpath_patterns_unmeasured: ["./lang/*"],
      });
      expect(facts.reasons).toEqual(["bundle: TOOLCHAIN_MISMATCH vite@0.0.0 rolldown@0.0.0"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cap's entry beside the root's crash", async () => {
    const dir = await install(withKeys(REPORT_SUBPATH_LIMIT + 1));
    try {
      const facts = await rootEntryBundle(
        dir,
        "with-subpaths",
        {},
        {
          runnerScript: runner("exit-now.mjs"),
        },
      );
      expect(facts.bundle).toMatchObject({
        exports_map: true,
        subpaths_listed: REPORT_SUBPATH_LIMIT + 1,
        subpaths_whole_eager_js_gzip9_bytes: null,
      });
      expect(facts.reasons).toHaveLength(2);
      expect(facts.reasons[0]).toMatch(/^bundle: BUNDLER_ERROR /);
      expect(facts.reasons[1]).toBe(`bundle: SUBPATH_LIMIT ${REPORT_SUBPATH_LIMIT + 1}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an unreadable manifest's entry beside the root's crash", async () => {
    const dir = await install(null);
    try {
      const facts = await rootEntryBundle(
        dir,
        "with-subpaths",
        {},
        {
          runnerScript: runner("exit-now.mjs"),
        },
      );
      expect(facts.bundle).toMatchObject({
        exports_map: null,
        subpaths_listed: null,
        subpaths_whole_eager_js_gzip9_bytes: null,
        subpath_patterns_unmeasured: null,
      });
      expect(facts.reasons).toHaveLength(2);
      expect(facts.reasons[1]).toBe(
        "bundle: SUBPATH_LIST_FAILED with-subpaths/package.json ENOENT",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times a measurement by its last completed build, not by a later subpath failure", async () => {
    const dir = await install();
    const script = fileURLToPath(
      new URL("./fixtures/runner/crash-on-subpath.mjs", import.meta.url),
    );
    // A clock that counts its reads: tick n is the n-th build that completed.
    let ticks = 0;
    const now = () => ++ticks;
    try {
      const result = await measureForReport(
        dir,
        "with-subpaths",
        {},
        { runnerScript: script, now },
      );
      const { whole, names, singles, subpaths } = result.measurement;
      expect(result.crash).toBeNull();
      expect(subpaths?.reason).toMatch(/^bundle: BUNDLER_ERROR/);
      expect(whole.bytes).not.toBeNull();
      // The root's builds that completed: the whole build, both listing builds, each export.
      const rootBuilds = 1 + 2 + (singles?.length ?? 0);
      expect(names).toEqual(["core", "default"]);
      expect(ticks).toBe(rootBuilds);
      expect(result.measuredAt).toBe(new Date(rootBuilds).toISOString());
      expect(cacheableMeasurement(result)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has no measurement time when no build completed", async () => {
    const dir = await install();
    const script = fileURLToPath(new URL("./fixtures/runner/exit-now.mjs", import.meta.url));
    try {
      const result = await measureForReport(
        dir,
        "with-subpaths",
        {},
        { runnerScript: script, now: () => 1 },
      );
      expect(result.crash).toMatch(/^bundle: BUNDLER_ERROR/);
      expect(result.measuredAt).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps 30 listed subpaths and none of 31", async () => {
    for (const [count, mapped] of [
      [REPORT_SUBPATH_LIMIT, true],
      [REPORT_SUBPATH_LIMIT + 1, false],
    ] as const) {
      const dir = await install(withKeys(count));
      try {
        const facts = await rootEntryBundle(dir, "with-subpaths", {});
        const map = facts.bundle.subpaths_whole_eager_js_gzip9_bytes;
        expect(facts.bundle.subpaths_listed).toBe(count);
        if (mapped) {
          expect(Object.keys(map ?? {})).toHaveLength(count);
          expect(Object.values(map ?? {}).every((v) => typeof v === "number")).toBe(true);
        } else {
          expect(map).toBeNull();
          expect(facts.reasons).toContain(`bundle: SUBPATH_LIMIT ${count}`);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("unbuiltSubpaths", () => {
  const listing = (count: number, exportsMap = true): ListingResult => ({
    ok: true,
    listing: {
      exportsMap,
      subpaths: Array.from({ length: count }, (_, i) => ({ key: `./m${i}`, target: `./m${i}.js` })),
      patterns: ["./x/*"],
    },
  });
  const crash = "bundle: BUNDLER_ERROR vite build exited 1";

  it("follows the states' order: unknown listing, no map, empty map, over the cap, else the cause", () => {
    const unread: ListingResult = { ok: false, reason: "bundle: SUBPATH_LIST_FAILED x ENOENT" };
    expect(unbuiltSubpaths(unread, 30, crash)).toEqual({
      exportsMap: null,
      listed: null,
      patterns: null,
      subpaths: null,
      reason: "bundle: SUBPATH_LIST_FAILED x ENOENT",
    });
    expect(unbuiltSubpaths(listing(0, false), 30, crash)).toMatchObject({
      exportsMap: false,
      subpaths: null,
      reason: null,
    });
    expect(unbuiltSubpaths(listing(0), 30, crash)).toMatchObject({
      listed: 0,
      subpaths: [],
      reason: null,
    });
    expect(unbuiltSubpaths(listing(31), 30, crash)).toMatchObject({
      listed: 31,
      subpaths: null,
      reason: "bundle: SUBPATH_LIMIT 31",
    });
    expect(unbuiltSubpaths(listing(5), 30, crash)).toMatchObject({ listed: 5, reason: crash });
    expect(
      unbuiltSubpaths(listing(5), 30),
      "a root failure leaves the reason to the root's entry",
    ).toMatchObject({
      listed: 5,
      patterns: ["./x/*"],
      subpaths: null,
      reason: null,
    });
  });
});

describe("measureRootEntry on fixture packages", () => {
  async function measure(
    name: string,
    packages: string[] = [name],
    externals: string[] = [],
    runnerScript?: string,
    onSubpathPhase?: (ms: number) => void,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    try {
      await writeFile(join(dir, "package.json"), '{ "private": true }');
      for (const pkg of packages) {
        await cp(join(fixtures, "bundle", pkg), join(dir, "node_modules", pkg), {
          recursive: true,
        });
      }
      return await measureRootEntry(dir, name, externals, {
        subpaths: true,
        runnerScript,
        onSubpathPhase,
      });
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

  it("builds each listed subpath whole, once per file, and leaves patterns unbuilt", async () => {
    const result = await measure("with-subpaths");
    expect(result.subpaths?.exportsMap).toBe(true);
    expect(result.subpaths?.patterns).toEqual(["./lang/*"]);
    expect(result.subpaths?.reason).toBeNull();
    const byKey = Object.fromEntries(
      (result.subpaths?.subpaths ?? []).map((s) => [s.key, s.outcome]),
    );
    expect(Object.keys(byKey)).toEqual(["./core", "./core.js", "./node"]);
    expect(byKey["./core"]?.bytes).not.toBeNull();
    expect(byKey["./core.js"]).toBe(byKey["./core"]);
    expect(byKey["./node"]).toEqual(failed("UNRESOLVED_IMPORT", "node:fs"));
    expect(rootEntryFacts(result, "vite").reasons).toEqual([
      'bundle: UNRESOLVED_IMPORT in subpaths ["./node"]',
    ]);
  });

  it("measures no subpath unless asked, as the CLI calls it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    try {
      const pkg = join(dir, "node_modules", "with-subpaths");
      await cp(join(fixtures, "bundle", "with-subpaths"), pkg, { recursive: true });
      const result = await measureRootEntry(dir, "with-subpaths", []);
      expect(result.subpaths).toBeNull();
      expect(result.whole.bytes).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives a package with no exports map no subpaths", async () => {
    const result = await measure("named");
    expect(result.subpaths).toEqual({
      exportsMap: false,
      listed: 0,
      patterns: [],
      subpaths: null,
      reason: null,
    });
  });

  it("keeps the root's results when the child fails during the subpath builds", async () => {
    const script = fileURLToPath(
      new URL("./fixtures/runner/crash-on-subpath.mjs", import.meta.url),
    );
    const result = await measure("with-subpaths", ["with-subpaths"], [], script);
    expect(result.whole.bytes?.eager_js_gzip9_bytes).toBe(35);
    expect(result.singles?.map((s) => s.name)).toEqual(["core", "default"]);
    expect(result.subpaths).toMatchObject({
      exportsMap: true,
      patterns: ["./lang/*"],
      subpaths: null,
    });
    expect(result.subpaths?.reason).toMatch(/^bundle: BUNDLER_ERROR vite build exited/);
    const facts = rootEntryFacts(result, "vite");
    expect(facts.bundle.whole_eager_js_gzip9_bytes).toBe(35);
    expect(facts.bundle.exports_measured).toBe(2);
    expect(facts.reasons).toEqual([result.subpaths?.reason]);
    expect(facts.bundle.subpaths_whole_eager_js_gzip9_bytes).toBeNull();
    expect(facts.bundle.subpaths_listed).toBe(3);
  });

  it("reports the manifest time alone when the root phase aborts", async () => {
    const script = fileURLToPath(new URL("./fixtures/runner/exit-now.mjs", import.meta.url));
    const times: number[] = [];
    await expect(
      measure("with-subpaths", ["with-subpaths"], [], script, (ms) => times.push(ms)),
    ).rejects.toThrow();
    expect(times).toHaveLength(1);
  });

  it("builds 100 listed subpaths and none of 101", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    const pkg = join(dir, "node_modules", "many");
    const measureKeysOnOneFile = async (count: number) => {
      const keys = Array.from({ length: count }, (_, i) => [`./m${i}`, "./index.js"]);
      const exports = { ".": "./index.js", ...Object.fromEntries(keys) };
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "many", exports }));
      const { subpaths } = await measureRootEntry(dir, "many", [], { subpaths: true });
      if (subpaths === null) throw new Error("subpaths were requested");
      return subpaths;
    };
    try {
      await cp(join(fixtures, "bundle", "named"), pkg, { recursive: true });
      const atCap = await measureKeysOnOneFile(SUBPATH_LIMIT);
      expect(atCap.reason).toBeNull();
      expect(atCap.subpaths).toHaveLength(SUBPATH_LIMIT);
      expect(atCap.subpaths?.every((s) => s.outcome.bytes !== null)).toBe(true);
      expect(await measureKeysOnOneFile(SUBPATH_LIMIT + 1)).toEqual({
        exportsMap: true,
        listed: SUBPATH_LIMIT + 1,
        patterns: [],
        subpaths: null,
        reason: `bundle: SUBPATH_LIMIT ${SUBPATH_LIMIT + 1}`,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds at most the report's 30 when asked for that limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    const pkg = join(dir, "node_modules", "many");
    const keys = Array.from({ length: REPORT_SUBPATH_LIMIT + 1 }, (_, i) => [
      `./m${i}`,
      "./index.js",
    ]);
    try {
      await cp(join(fixtures, "bundle", "named"), pkg, { recursive: true });
      const exports = { ".": "./index.js", ...Object.fromEntries(keys) };
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "many", exports }));
      const options = { subpaths: true, subpathLimit: REPORT_SUBPATH_LIMIT };
      const { subpaths } = await measureRootEntry(dir, "many", [], options);
      expect(subpaths?.subpaths).toBeNull();
      expect(subpaths?.reason).toBe(`bundle: SUBPATH_LIMIT ${REPORT_SUBPATH_LIMIT + 1}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an unreadable manifest as SUBPATH_LIST_FAILED without a temp path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-test-"));
    try {
      expect(await readListing(dir, "absent")).toEqual({
        ok: false,
        reason: "bundle: SUBPATH_LIST_FAILED absent/package.json ENOENT",
      });
      await cp(join(fixtures, "bundle", "named"), join(dir, "node_modules", "broken"), {
        recursive: true,
      });
      await writeFile(join(dir, "node_modules", "broken", "package.json"), "{ not json");
      expect(await readListing(dir, "broken")).toEqual({
        ok: false,
        reason: "bundle: SUBPATH_LIST_FAILED broken/package.json invalid JSON",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const imported = (m: Awaited<ReturnType<typeof measure>>) => ({
    whole: m.whole.bytes ? m.whole.externals : null,
    singles: Object.fromEntries(
      (m.singles ?? []).map((s) => [s.name, s.outcome.bytes ? s.outcome.externals : null]),
    ),
  });

  it("does not list an optional peer the output never imports", async () => {
    const result = await measure("optional-peer-unused", ["optional-peer-unused"], ["typescript"]);
    expect(imported(result)).toEqual({ whole: [], singles: { check: [], parse: [] } });
    expect(rootEntryFacts(result, "vite").bundle.external_packages).toEqual([]);
  });

  it("lists a peer imported through a subpath, the same in the whole and per-export builds", async () => {
    const result = await measure("subpath-peer", ["subpath-peer", "peer"], ["peer"]);
    // `other` never calls the peer, but an external import stays as a side-effect import.
    expect(imported(result)).toEqual({
      whole: ["peer"],
      singles: { other: ["peer"], run: ["peer"] },
    });
    const fromSingles = new Set(Object.values(imported(result).singles).flat());
    expect([...fromSingles]).toEqual(imported(result).whole);
    expect(rootEntryFacts(result, "vite").bundle.external_packages).toEqual(["peer"]);
  });
});

describe("measureRootEntry on a shared pool", () => {
  const scripted = fileURLToPath(new URL("./fixtures/runner/scripted.mjs", import.meta.url));
  type Rule = { match: string; delayMs?: number; crash?: string };
  const WHOLE = 'import * as __depfit_0 from "with-subpaths";';
  const CORE = "{ core as __depfit_0 }";
  const DEFAULT = 'import __depfit_0 from "with-subpaths";';

  async function installed(rules: Rule[] | null): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "depfit-root-pool-"));
    await writeFile(join(dir, "package.json"), '{ "private": true }');
    await cp(
      join(fixtures, "bundle", "with-subpaths"),
      join(dir, "node_modules", "with-subpaths"),
      {
        recursive: true,
      },
    );
    if (rules) {
      await writeFile(join(dir, "runner-rules.json"), JSON.stringify({ exports: ["core"], rules }));
    }
    return dir;
  }

  async function measured(
    rules: Rule[] | null,
    options: { size?: number; lifo?: boolean; serial?: boolean; script?: string | null } = {},
  ) {
    const dir = await installed(rules);
    const script = options.script === null ? undefined : (options.script ?? scripted);
    const pool = createVitePool({ size: options.size ?? 4, lifo: options.lifo, script });
    try {
      const result = await measureRootEntry(dir, "with-subpaths", [], {
        subpaths: true,
        pool,
        serial: options.serial,
      }).catch((error: unknown) => error);
      const log = (await readFile(join(dir, "runner-log.txt"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line.slice(0, line.lastIndexOf(" "))) as string);
      return { result, log };
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("keeps the root's results when a subpath build fails while root builds still run", async () => {
    const { result } = await measured([
      { match: "with-subpaths/", crash: "subpath crash" },
      { match: CORE, delayMs: 300 },
      { match: DEFAULT, delayMs: 300 },
    ]);
    expect(result).toMatchObject({
      whole: { bytes: { eager_js_gzip9_bytes: 35 } },
      names: ["core", "default"],
      subpaths: { exportsMap: true, listed: 3, subpaths: null },
    });
    const measurement = result as RootEntryMeasurement;
    expect(
      measurement.singles?.map((single) => single.outcome.bytes?.eager_js_gzip9_bytes),
    ).toEqual([35, 35]);
    expect(measurement.subpaths?.reason).toMatch(
      /^bundle: BUNDLER_ERROR vite build exited 1: subpath crash/,
    );
  });

  it("reports the failure that comes first in today's order, whatever finished first", async () => {
    const late = await measured([
      { match: CORE, delayMs: 300, crash: "crash core" },
      { match: DEFAULT, crash: "crash default" },
    ]);
    expect(String(late.result)).toMatch(/crash core/);
    const early = await measured([
      { match: CORE, crash: "crash core" },
      { match: DEFAULT, delayMs: 300, crash: "crash default" },
    ]);
    expect(String(early.result)).toMatch(/crash core/);
  });

  it("starts nothing else until the whole build is in", async () => {
    const { log } = await measured([{ match: WHOLE, delayMs: 200 }]);
    expect(log[0]).toContain(WHOLE);
    expect(log).toHaveLength(7);
  });

  it("builds one at a time in today's order on the serial schedule", async () => {
    const { log } = await measured([], { size: 1, serial: true });
    const order = [
      WHOLE,
      "export * from",
      "export { default }",
      CORE,
      DEFAULT,
      '"with-subpaths/core"',
      '"with-subpaths/node"',
    ];
    expect(log.map((source) => order.findIndex((part) => source.includes(part)))).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("gives the same result with real Vite whatever the worker count or order", async () => {
    const sorted = (value: unknown) =>
      JSON.stringify(value, (_, inner: unknown) =>
        Array.isArray(inner) &&
        inner.every((item) => typeof item === "object" && item && "code" in item)
          ? [...inner].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
          : inner,
      );
    const runs = [];
    for (const options of [
      { size: 1, serial: true, script: null },
      { size: 1, script: null },
      { size: 4, script: null },
      { size: 4, lifo: true, script: null },
    ]) {
      runs.push(await measured(null, options));
    }
    const [first, ...rest] = runs.map((run) => sorted(run.result));
    expect(first).toContain('"eager_js_gzip9_bytes"');
    for (const other of rest) expect(other).toBe(first);
  });
});

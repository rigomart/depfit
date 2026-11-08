/**
 * The cache's tree step against a local registry (SPEC.md, "Cache (#8)", gates K2 (b) and (d), K3):
 * npm resolves the tree on every call, and only a lockfile already cached is a hit.
 */
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Cache, openCache } from "../src/collect/cache.ts";
import {
  type CachedFacts,
  type CachedInstallOptions,
  cachedInstallFacts,
  isNpmFailure,
  withCacheFallback,
} from "../src/collect/cached-install.ts";
import type { ReportMeasurement } from "../src/collect/root-entry.ts";
import { type Registry, startRegistry } from "./local-registry.ts";

const SLOW = 120_000;
let registry: Registry;
let work: string;
const saved: Record<string, string | undefined> = {};
const NPM_ENV = [
  "npm_config_registry",
  "npm_config_cache",
  "npm_config_userconfig",
  "npm_config_fetch_retries",
  "npm_config_omit",
  "DEPFIT_LOCK_DIR",
];

beforeAll(async () => {
  registry = await startRegistry();
  work = await mkdtemp(join(tmpdir(), "depfit-cached-install-"));
  for (const name of NPM_ENV) saved[name] = process.env[name];
  await writeFile(join(work, "npmrc"), "");
  process.env.npm_config_registry = registry.url;
  process.env.npm_config_cache = join(work, "npm-cache");
  process.env.npm_config_userconfig = join(work, "npmrc");
  process.env.npm_config_fetch_retries = "0";
  delete process.env.npm_config_omit;
  delete process.env.DEPFIT_LOCK_DIR;
});

afterAll(async () => {
  for (const name of NPM_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await registry.close();
  await rm(work, { recursive: true, force: true });
});

let cacheDir: string;
let cache: Cache;
const open = async () => {
  const opened = await openCache({ dir: cacheDir });
  if (!opened) throw new Error("cache did not open");
  return opened;
};
beforeEach(async () => {
  cacheDir = await mkdtemp(join(work, "cache-"));
  cache = await open();
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const factsOnly: CachedInstallOptions = { measure: null, cacheable: () => false };
const call = (name: string, options: CachedInstallOptions = factsOnly, using: Cache = cache) =>
  cachedInstallFacts(using, { name, version: "1.0.0", manifest: {} }, options);
const versionOf = (tree: { name: string; version: string }[], name: string) =>
  tree.find((pkg) => pkg.name === name)?.version;

function measuring(crash: string | null = null) {
  let calls = 0;
  const measurement: ReportMeasurement = {
    measurement: {
      whole: {
        bytes: {
          eager_js_min_bytes: 10,
          eager_js_gzip9_bytes: 5,
          lazy_js_min_bytes: 0,
          lazy_js_gzip9_bytes: 0,
        },
        problems: [],
        externals: [],
      },
      names: ["v"],
      listProblems: [],
      singles: [],
      subpaths: null,
    },
    crash,
    measuredAt: crash ? null : new Date().toISOString(),
  };
  const options: CachedInstallOptions = {
    measure: async () => {
      calls++;
      return measurement;
    },
    cacheable: (m) => m.crash === null,
  };
  return { options, calls: () => calls };
}

describe("a floating range", () => {
  it(
    "misses when a new version is published, and hits the earlier tree when latest moves back",
    async () => {
      await registry.publish("fb", "1.0.0");
      await registry.publish("fa", "1.0.0", { dependencies: { fb: "^1.0.0" } });
      const first = await call("fa");
      expect(first.step).toBe("cold");
      expect(versionOf(first.tree, "fb")).toBe("1.0.0");

      await registry.publish("fb", "1.1.0");
      const second = await call("fa");
      expect(second.step).toBe("miss");
      expect(versionOf(second.tree, "fb")).toBe("1.1.0");

      registry.tag("fb", "latest", "1.0.0");
      const third = await call("fa");
      expect(third.step).toBe("hit");
      expect(versionOf(third.tree, "fb")).toBe("1.0.0");
    },
    SLOW,
  );

  it(
    "misses when the version it resolved to is unpublished",
    async () => {
      await registry.publish("ub", "1.0.0");
      await registry.publish("ub", "1.1.0");
      await registry.publish("ua", "1.0.0", { dependencies: { ub: "^1.0.0" } });
      const first = await call("ua");
      expect(versionOf(first.tree, "ub")).toBe("1.1.0");

      registry.unpublish("ub", "1.1.0");
      const second = await call("ua");
      expect(second.step).toBe("miss");
      expect(versionOf(second.tree, "ub")).toBe("1.0.0");
    },
    SLOW,
  );

  it(
    "still hits when a packument outside the tree changes (an optional peer)",
    async () => {
      await registry.publish("pc", "1.0.0");
      await registry.publish("pa", "1.0.0", {
        peerDependencies: { pc: "^1.0.0" },
        peerDependenciesMeta: { pc: { optional: true } },
      });
      await call("pa");
      await registry.publish("pc", "1.1.0");
      const second = await call("pa");
      expect(second.step).toBe("hit");
      expect(versionOf(second.tree, "pc")).toBeUndefined();
    },
    SLOW,
  );
});

describe("an incomplete install", () => {
  it(
    "caches nothing when an optional dependency fails to download, and measures again once it does",
    async () => {
      await registry.publish("od", "1.0.0");
      await registry.publish("oa", "1.0.0", { optionalDependencies: { od: "^1.0.0" } });
      registry.failTarball("od", "1.0.0", true);
      const { options, calls } = measuring();
      const first = await call("oa", options);
      expect(first.tree.find((pkg) => pkg.name === "od")?.installed).toBe(false);
      expect(await cache.hasVersion("oa", "1.0.0")).toBe(false);
      expect(await readdir(join(cache.root, "installs"))).toEqual([]);

      registry.failTarball("od", "1.0.0", false);
      const second = await call("oa", options);
      expect(second.step).toBe("cold");
      expect(second.tree.find((pkg) => pkg.name === "od")?.installed).toBe(true);
      expect(calls()).toBe(2);
      expect((await call("oa", options)).step).toBe("hit");
    },
    SLOW,
  );

  it(
    "keys the same lockfile apart under omit=optional, with other install facts",
    async () => {
      await registry.publish("xd", "1.0.0");
      await registry.publish("xa", "1.0.0", { optionalDependencies: { xd: "^1.0.0" } });
      const full = await call("xa");
      expect(full.tree.find((pkg) => pkg.name === "xd")?.installed).toBe(true);
      process.env.npm_config_omit = "optional";
      try {
        const omitting = await open();
        expect(omitting.npm.hash).not.toBe(cache.npm.hash);
        const omitted = await call("xa", factsOnly, omitting);
        expect(omitted.step).toBe("miss");
        expect(omitted.tree.find((pkg) => pkg.name === "xd")?.installed).toBe(false);
        expect((await call("xa", factsOnly, omitting)).step).toBe("hit");
      } finally {
        delete process.env.npm_config_omit;
      }
      expect((await call("xa")).step).toBe("hit");
    },
    SLOW,
  );
});

describe("parts", () => {
  it(
    "adds the measurement to facts a workspace with no browser signal cached",
    async () => {
      await registry.publish("ma", "1.0.0");
      expect((await call("ma")).step).toBe("cold");
      const { options, calls } = measuring();
      const browser = await call("ma", options);
      expect(browser.step).toBe("miss");
      expect(calls()).toBe(1);
      const hit = await call("ma", options);
      expect(hit.step).toBe("hit");
      expect(hit.measurement?.measuredAt).toBe(browser.measurement?.measuredAt);
      expect(calls()).toBe(1);
      expect((await call("ma")).step).toBe("hit");
    },
    SLOW,
  );

  it(
    "measures again after a measurement that failed to run",
    async () => {
      await registry.publish("ca", "1.0.0");
      const crashed = measuring("bundle: BUNDLER_ERROR worker exited");
      expect((await call("ca", crashed.options)).measurement?.crash).not.toBeNull();
      const { options, calls } = measuring();
      expect((await call("ca", options)).step).toBe("miss");
      expect(calls()).toBe(1);
      expect((await call("ca", options)).step).toBe("hit");
    },
    SLOW,
  );

  it(
    "serves two calls at once, a browser one and another, with one install kept",
    async () => {
      await registry.publish("cc", "1.0.0");
      const { options } = measuring();
      const [a, b] = await Promise.all([call("cc", options), call("cc")]);
      expect(a.tree).toEqual(b.tree);
      expect(await readdir(join(cache.root, "installs"))).toHaveLength(1);
      expect((await call("cc", options)).step).toBe("hit");
    },
    SLOW,
  );
});

describe("a cache that fails partway", () => {
  it(
    "takes the uncached path when its directory is gone after opening",
    async () => {
      await registry.publish("gone", "1.0.0");
      await rm(cache.root, { recursive: true, force: true });
      let uncached = 0;
      const facts = await withCacheFallback<CachedFacts | string>(
        () => call("gone"),
        async () => {
          uncached++;
          return "uncached facts";
        },
      );
      expect(facts).toBe("uncached facts");
      expect(uncached).toBe(1);
    },
    SLOW,
  );

  it(
    "does not retry an npm failure, which is the install's own",
    async () => {
      // Never published, so npm's resolution fails with E404.
      let uncached = 0;
      const failing = withCacheFallback<CachedFacts | null>(
        () => call("never-published"),
        async () => {
          uncached++;
          return null;
        },
      );
      await expect(failing).rejects.toSatisfy(isNpmFailure);
      expect(uncached).toBe(0);
    },
    SLOW,
  );

  it(
    "still gives the call its facts when publishing fails",
    async () => {
      await registry.publish("fp", "1.0.0");
      const entries = join(cache.root, "entries");
      await chmod(entries, 0o500);
      try {
        const facts = await call("fp");
        expect(facts.step).toBe("cold");
        expect(versionOf(facts.tree, "fp")).toBe("1.0.0");
      } finally {
        await chmod(entries, 0o700);
      }
    },
    SLOW,
  );
});

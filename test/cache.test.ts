import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_FORMAT,
  type Cache,
  cacheDirectory,
  canonicalJson,
  chooseVictims,
  fileLengths,
  identityOf,
  type IdentityInputs,
  keysFor,
  openCache,
  SIZE_FILE,
  sha256,
  stagingAbandoned,
  treeHash,
  validPart,
} from "../src/collect/cache.ts";

const lock = (packages: Record<string, unknown>, lockfileVersion = 3) =>
  JSON.stringify({ name: "depfit-probe", lockfileVersion, requires: true, packages });

const BASE = {
  "": { name: "depfit-probe", dependencies: { a: "^1.0.0" } },
  "node_modules/a": {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
    integrity: "sha512-aaa",
    dependencies: { b: "^2.0.0" },
  },
  "node_modules/b": {
    version: "2.0.0",
    resolved: "https://registry.npmjs.org/b/-/b-2.0.0.tgz",
    integrity: "sha512-bbb",
  },
};

describe("cacheDirectory", () => {
  it("uses XDG_CACHE_HOME on every platform, else the platform's cache directory", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(cacheDirectory({ XDG_CACHE_HOME: "/x" }, platform, "/home/u")).toBe("/x/depfit");
    }
    expect(cacheDirectory({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Caches/depfit");
    expect(cacheDirectory({}, "linux", "/home/u")).toBe("/home/u/.cache/depfit");
    expect(cacheDirectory({ LOCALAPPDATA: "C:/L" }, "win32", "C:/U")).toBe(
      join("C:/L", "depfit", "Cache"),
    );
  });
});

describe("treeHash", () => {
  const base = treeHash(lock(BASE));

  it("ignores key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(BASE)
        .reverse()
        .map(([path, entry]) => [path, Object.fromEntries(Object.entries(entry).reverse())]),
    );
    expect(treeHash(lock(reordered))).toBe(base);
  });

  it("changes with any entry's version, resolved, integrity, path or flags", () => {
    const changed = (path: string, field: string, value: unknown) =>
      treeHash(lock({ ...BASE, [path]: { ...BASE[path as keyof typeof BASE], [field]: value } }));
    expect(changed("node_modules/b", "version", "2.0.1")).not.toBe(base);
    expect(changed("node_modules/b", "resolved", "https://other/b-2.0.0.tgz")).not.toBe(base);
    expect(changed("node_modules/b", "integrity", "sha512-ccc")).not.toBe(base);
    expect(changed("node_modules/b", "optional", true)).not.toBe(base);
    expect(changed("node_modules/b", "peer", true)).not.toBe(base);
    const { "node_modules/b": b, ...rest } = BASE;
    expect(treeHash(lock({ ...rest, "node_modules/a/node_modules/b": b }))).not.toBe(base);
  });

  it("changes with the root entry's dependency and with a package added or removed", () => {
    const root = { ...BASE[""], dependencies: { a: "^1.0.1" } };
    expect(treeHash(lock({ ...BASE, "": root }))).not.toBe(base);
    const { "node_modules/b": _b, ...without } = BASE;
    expect(treeHash(lock(without))).not.toBe(base);
    const added = { ...BASE, "node_modules/c": { version: "1.0.0", integrity: "sha512-c" } };
    expect(treeHash(lock(added))).not.toBe(base);
    expect(treeHash(lock(BASE, 2))).not.toBe(base);
  });
});

describe("keys", () => {
  const inputs: IdentityInputs = {
    sources: "s",
    vite: ["rolldown@1.2.14", "vite@8.3.4", "picomatch@4.0.3"],
    runtime: "bun 1.3.14",
    worker: "24.14.1 1.3.1",
    platform: { os: "darwin", cpu: "arm64", libc: null },
  };
  const id = identityOf(inputs);

  it("change with each identity input", () => {
    const variants: Partial<IdentityInputs>[] = [
      { sources: "t" },
      { vite: ["rolldown@1.2.14", "vite@8.3.4", "picomatch@4.0.4"] },
      { runtime: "node 24.14.1" },
      { worker: "24.14.1 1.3.2" },
      { platform: { os: "linux", cpu: "arm64", libc: "glibc" } },
    ];
    for (const variant of variants) expect(identityOf({ ...inputs, ...variant })).not.toBe(id);
  });

  it("change with the npm settings, the tree, the name and the version", () => {
    const keys = keysFor(id, "npm", "tree", "a", "1.0.0");
    expect(keysFor(id, "npm2", "tree", "a", "1.0.0").entry).not.toBe(keys.entry);
    expect(keysFor(id, "npm", "tree2", "a", "1.0.0").entry).not.toBe(keys.entry);
    expect(keysFor(id, "npm", "tree", "b", "1.0.0").entry).not.toBe(keys.entry);
    expect(keysFor(id, "npm", "tree", "a", "1.0.1").entry).not.toBe(keys.entry);
    expect(keysFor("other", "npm", "tree", "a", "1.0.0").entry).not.toBe(keys.entry);
  });

  it("name an install by the tree and npm settings, not by depfit's identity", () => {
    expect(keysFor("other", "npm", "tree", "a", "1.0.0").install).toBe(
      keysFor(id, "npm", "tree", "a", "1.0.0").install,
    );
    expect(keysFor(id, "npm2", "tree", "a", "1.0.0").install).not.toBe(
      keysFor(id, "npm", "tree", "a", "1.0.0").install,
    );
  });

  it("canonicalJson sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}',
    );
  });
});

describe("validPart", () => {
  const body = { tree: [], bundledTypes: true };
  const envelope = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: CACHE_FORMAT,
      part: "facts",
      key: "k",
      sha256: sha256(JSON.stringify(body)),
      body,
      ...overrides,
    });

  it("returns the body of a whole envelope", () => {
    expect(validPart(envelope(), "facts", "k")).toEqual(body);
  });

  it("rejects a truncated, garbage, wrong-key, wrong-part, wrong-version or wrong-checksum part", () => {
    const whole = envelope();
    expect(validPart(whole.slice(0, whole.length - 5), "facts", "k")).toBeNull();
    expect(validPart("not json at all", "facts", "k")).toBeNull();
    expect(validPart("[]", "facts", "k")).toBeNull();
    expect(validPart(whole, "facts", "other")).toBeNull();
    expect(validPart(whole, "bundle", "k")).toBeNull();
    expect(validPart(envelope({ format: CACHE_FORMAT + 1 }), "facts", "k")).toBeNull();
    expect(validPart(envelope({ sha256: sha256("x") }), "facts", "k")).toBeNull();
    expect(
      validPart(envelope({ body: { ...body, bundledTypes: false } }), "facts", "k"),
    ).toBeNull();
  });
});

describe("chooseVictims", () => {
  const item = (path: string, bytes: number, lastUsedMs: number) => ({ path, bytes, lastUsedMs });

  it("takes the least recently used first until the rest fits", () => {
    const items = [item("new", 40, 300), item("old", 40, 100), item("mid", 40, 200)];
    expect(chooseVictims(items, 100).map((v) => v.path)).toEqual(["old"]);
    expect(chooseVictims(items, 40).map((v) => v.path)).toEqual(["old", "mid"]);
    expect(chooseVictims(items, 120)).toEqual([]);
  });

  it("takes an item larger than the limit on its own", () => {
    expect(chooseVictims([item("huge", 500, 900)], 100).map((v) => v.path)).toEqual(["huge"]);
  });
});

describe("stagingAbandoned", () => {
  const alive = (pid: number) => pid === 42;
  const DAY = 24 * 60 * 60 * 1000;

  it("deletes a dead call's staging on this host, and anything older than a day", () => {
    expect(stagingAbandoned("host-42-abc123", "host", alive, 0)).toBe(false);
    expect(stagingAbandoned("host-43-abc123", "host", alive, 0)).toBe(true);
    expect(stagingAbandoned("my-host-43-abc.json", "my-host", alive, 0)).toBe(true);
    expect(stagingAbandoned("other-43-abc123", "host", alive, 0)).toBe(false);
    expect(stagingAbandoned("garbage", "host", alive, 0)).toBe(false);
    expect(stagingAbandoned("host-42-abc123", "host", alive, DAY + 1)).toBe(true);
    expect(stagingAbandoned("other-43-abc123", "host", alive, DAY + 1)).toBe(true);
  });
});

describe("the cache on disk", () => {
  let dir: string;
  let cache: Cache;
  const LIMITS = { installs: 10_000, entries: 2_000 };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "depfit-cache-test-"));
    const opened = await openCache({ dir, limits: LIMITS });
    if (!opened) throw new Error("cache did not open");
    cache = opened;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const partFile = (name: string, version: string, key: string, part: string) =>
    join(cache.root, "entries", `${encodeURIComponent(name)}@${version}`, `${key}.${part}.json`);

  it("lives under the given directory, never the user's own", () => {
    expect(cache.root).toBe(join(dir, `v${CACHE_FORMAT}`));
  });

  it("writes a part once (the first writer wins) and reads it back", async () => {
    await cache.write("facts", "@scope/a", "1.0.0", "k", { first: true });
    await cache.write("facts", "@scope/a", "1.0.0", "k", { first: false });
    expect(await cache.read("facts", "@scope/a", "1.0.0", "k")).toEqual({ first: true });
    expect(await cache.hasVersion("@scope/a", "1.0.0")).toBe(true);
    expect(await cache.hasVersion("@scope/a", "1.0.1")).toBe(false);
    expect(await cache.read("bundle", "@scope/a", "1.0.0", "k")).toBeNull();
  });

  it("removes an invalid part it reads, so the next write replaces it", async () => {
    await cache.write("facts", "a", "1.0.0", "k", { n: 1 });
    const file = partFile("a", "1.0.0", "k", "facts");
    await writeFile(file, (await readFile(file, "utf8")).slice(0, 20));
    expect(await cache.read("facts", "a", "1.0.0", "k")).toBeNull();
    await expect(stat(file)).rejects.toThrow();
    await cache.write("facts", "a", "1.0.0", "k", { n: 2 });
    expect(await cache.read("facts", "a", "1.0.0", "k")).toEqual({ n: 2 });
  });

  it("misses a part deleted between finding it and reading it", async () => {
    await cache.write("facts", "a", "1.0.0", "k", { n: 1 });
    expect(await cache.hasVersion("a", "1.0.0")).toBe(true);
    await rm(partFile("a", "1.0.0", "k", "facts"));
    expect(await cache.read("facts", "a", "1.0.0", "k")).toBeNull();
  });

  it("keeps an install with its size record, the sum of its file lengths", async () => {
    const staged = await cache.staging();
    await mkdir(join(staged, "node_modules", "a"), { recursive: true });
    await writeFile(join(staged, "node_modules", "a", "index.js"), "x".repeat(1234));
    await writeFile(join(staged, "package-lock.json"), "{}");
    await mkdir(join(staged, ".depfit-w0"));
    await writeFile(join(staged, ".depfit-w0", "__depfit_entry.mjs"), "leftover");
    expect(await cache.publishInstall(staged, "key1")).toBe(true);
    const kept = join(cache.root, "installs", "key1");
    expect(await readdir(kept)).not.toContain(".depfit-w0");
    const recorded = Number(await readFile(join(kept, SIZE_FILE), "utf8"));
    const lengths = (await fileLengths(kept)) - (await stat(join(kept, SIZE_FILE))).size;
    expect(recorded).toBe(1236);
    expect(recorded).toBe(lengths);
  });

  it("does not keep an install larger than its limit, nor a second copy of one", async () => {
    const big = await cache.staging();
    await writeFile(join(big, "blob"), "x".repeat(LIMITS.installs + 1));
    expect(await cache.publishInstall(big, "big")).toBe(false);
    const first = await cache.staging();
    await writeFile(join(first, "f"), "1");
    expect(await cache.publishInstall(first, "same")).toBe(true);
    const second = await cache.staging();
    await writeFile(join(second, "f"), "2");
    expect(await cache.publishInstall(second, "same")).toBe(false);
  });

  it("evicts the least recently used until each part is under its limit", async () => {
    for (const [i, name] of ["old", "mid", "new"].entries()) {
      const staged = await cache.staging();
      await writeFile(join(staged, "blob"), "x".repeat(4000));
      await cache.publishInstall(staged, name);
      const when = new Date(Date.now() - (3 - i) * 60_000);
      await utimes(join(cache.root, "installs", name, SIZE_FILE), when, when);
    }
    for (let i = 0; i < 5; i++) {
      await cache.write("facts", `p${i}`, "1.0.0", "k", { pad: "y".repeat(400) });
      const when = new Date(Date.now() - (10 - i) * 60_000);
      const file = partFile(`p${i}`, "1.0.0", "k", "facts");
      await utimes(file, when, when);
    }
    await cache.evict();
    expect((await readdir(join(cache.root, "installs"))).sort()).toEqual(["mid", "new"]);
    expect(await cache.read("facts", "p0", "1.0.0", "k")).toBeNull();
    expect(await cache.read("facts", "p4", "1.0.0", "k")).not.toBeNull();
    let entryBytes = 0;
    for (const sub of await readdir(join(cache.root, "entries"))) {
      for (const file of await readdir(join(cache.root, "entries", sub))) {
        entryBytes += (await stat(join(cache.root, "entries", sub, file))).size;
      }
    }
    expect(entryBytes).toBeLessThanOrEqual(LIMITS.entries);
  });

  it("stays under its limits after every one of repeated publications", async () => {
    for (let i = 0; i < 6; i++) {
      const staged = await cache.staging();
      await writeFile(join(staged, "blob"), "x".repeat(3000));
      await cache.publishInstall(staged, `k${i}`);
      await cache.evict();
      let total = 0;
      for (const key of await readdir(join(cache.root, "installs"))) {
        total += Number(await readFile(join(cache.root, "installs", key, SIZE_FILE), "utf8"));
      }
      expect(total).toBeLessThanOrEqual(LIMITS.installs);
    }
  });

  it("deletes staging of dead calls and older than 24 hours, and keeps a live call's", async () => {
    const host = hostname().replace(/[^A-Za-z0-9.]/g, "_");
    const tmp = join(cache.root, "tmp");
    const live = await cache.staging();
    await mkdir(join(tmp, `${host}-999999999-dead00`));
    const old = join(tmp, `${host}-${process.pid}-old000`);
    await mkdir(old);
    const dayAndHour = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(old, dayAndHour, dayAndHour);
    await mkdir(join(tmp, "other-host-1-x"));
    await cache.evict();
    expect((await readdir(tmp)).sort()).toEqual(
      [live.slice(tmp.length + 1), "other-host-1-x"].sort(),
    );
  });

  it("deletes a published install that lost its size record", async () => {
    await mkdir(join(cache.root, "installs", "orphan"), { recursive: true });
    await cache.evict();
    expect(await readdir(join(cache.root, "installs"))).toEqual([]);
  });
});

describe("openCache", () => {
  it("is null when the directory cannot be used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depfit-cache-ro-"));
    const file = join(dir, "file");
    await writeFile(file, "not a directory");
    expect(await openCache({ dir: file })).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

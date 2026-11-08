/**
 * depfit's local cache (eval/bundle/SPEC.md, "Cache (#8)"): install facts and bundle measurements
 * keyed by the exact resolved install tree, plus install directories kept for #10.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { track } from "./children.ts";
import { currentPlatform } from "./install.ts";
import { asRecord, asStringArray, isRecord } from "./util.ts";

/** Bumped when the on-disk layout changes (a part's shape is covered by the sources hash); in every key and the root directory name. */
export const CACHE_FORMAT = 1;

export type Limits = { installs: number; entries: number };

/** SPEC.md, "Cache (#8)": the approved limits. */
export const LIMITS: Limits = { installs: 2 * 1024 ** 3, entries: 128 * 1024 ** 2 };

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Written inside an install directory before it is published: the sum of its file lengths. */
export const SIZE_FILE = ".depfit-size";

export type Part = "facts" | "bundle";

/**
 * `$XDG_CACHE_HOME/depfit` when set, on any platform; otherwise the platform's cache directory.
 */
export function cacheDirectory(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "depfit");
  if (platform === "darwin") return join(home, "Library", "Caches", "depfit");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "depfit", "Cache");
  }
  return join(home, ".cache", "depfit");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON with every object's keys sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 of the whole lockfile's `lockfileVersion` and `packages`, the root entry included. */
export function treeHash(lockText: string): string {
  const lock = asRecord(JSON.parse(lockText));
  return sha256(
    canonicalJson({ lockfileVersion: lock.lockfileVersion ?? null, packages: lock.packages ?? {} }),
  );
}

export type Keys = { entry: string; install: string };

/**
 * The entry key (identity, npm settings, tree, name, version) and the install directory's key (the
 * same without the measurement identity: the install does not depend on depfit's code).
 */
export function keysFor(
  identity: string,
  npmSettings: string,
  tree: string,
  name: string,
  version: string,
): Keys {
  const install = sha256(canonicalJson({ format: CACHE_FORMAT, npmSettings, tree, name, version }));
  return { entry: sha256(canonicalJson({ identity, install })), install };
}

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 60_000, shell: process.platform === "win32" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    track(child);
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));

async function sourcesHash(): Promise<string> {
  const files = (await readdir(HERE, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(HERE, entry.name))
    .sort();
  const hash = createHash("sha256");
  for (const file of [...files, join(HERE, "..", "..", "package.json")]) {
    hash.update(`${file.slice(HERE.length)}\0`);
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readManifest(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The real directory Node would load `name` from, starting at `from` (a package's real directory):
 * Node resolves symlinks first (pnpm-style layouts), so its lookup starts beside the real location.
 */
async function findPackage(from: string, name: string): Promise<string | null> {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (await readManifest(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * `name@version` of every installed package Vite depends on, Vite included, sorted: its
 * dependencies, optional dependencies and installed peers, transitively.
 */
export async function viteClosure(
  start: string = dirname(createRequire(join(HERE, "bundle.ts")).resolve("vite/package.json")),
): Promise<string[]> {
  const seen = new Map<string, string>();
  const queue = [await realpath(start)];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    if (seen.has(dir)) continue;
    const manifest = await readManifest(join(dir, "package.json"));
    if (!manifest) continue;
    seen.set(dir, `${String(manifest.name)}@${String(manifest.version)}`);
    const names = [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].flatMap((deps) => Object.keys(asRecord(deps)));
    for (const name of new Set(names)) {
      const found = await findPackage(dir, name);
      if (found) queue.push(found);
    }
  }
  return [...new Set(seen.values())].sort();
}

/**
 * Everything besides the tree that decides a measurement and its install facts: depfit's code,
 * the Vite closure it builds with, its runtime, the Node and zlib of the workers' `node` (gzip
 * happens there), and the platform.
 */
export async function measurementIdentity(): Promise<string> {
  const [sources, vite, worker] = await Promise.all([
    sourcesHash(),
    viteClosure(),
    run("node", ["-p", 'process.versions.node+" "+process.versions.zlib']),
  ]);
  const runtime = process.versions.bun
    ? `bun ${process.versions.bun}`
    : `node ${process.versions.node}`;
  return identityOf({ sources, vite, runtime, worker: worker.trim(), platform: currentPlatform() });
}

export type IdentityInputs = {
  /** sha256 of depfit's src/collect/ and package.json. */
  sources: string;
  /** `name@version` of every package in Vite's installed closure. */
  vite: string[];
  /** The runtime running depfit, e.g. "bun 1.3.14". */
  runtime: string;
  /** The Node and zlib versions of the workers' `node`. */
  worker: string;
  platform: { os: string; cpu: string; libc: string | null };
};

export function identityOf(inputs: IdentityInputs): string {
  return sha256(canonicalJson({ format: CACHE_FORMAT, ...inputs }));
}

export type NpmSettings = { hash: string; omit: ReadonlySet<string> };

/** `npm config list --json` run in `dir` (only a minimal manifest there): its sha256 and its `omit` setting. */
export async function npmSettings(dir: string): Promise<NpmSettings> {
  const parsed: unknown = JSON.parse(await run("npm", ["config", "list", "--json"], dir));
  return {
    hash: sha256(canonicalJson(parsed)),
    omit: new Set(asStringArray(asRecord(parsed).omit)),
  };
}

export type Item = { path: string; bytes: number; lastUsedMs: number };

/** Least recently used first, until the rest fits in `limit` bytes. */
export function chooseVictims(items: Item[], limit: number): Item[] {
  let total = items.reduce((sum, item) => sum + item.bytes, 0);
  const victims: Item[] = [];
  for (const item of [...items].sort(
    (a, b) => a.lastUsedMs - b.lastUsedMs || a.path.localeCompare(b.path),
  )) {
    if (total <= limit) break;
    victims.push(item);
    total -= item.bytes;
  }
  return victims;
}

/**
 * Whether the eviction pass deletes a staging item named `<host>-<pid>-...`: when it is older than
 * a day, or when its call ran on this host and is no longer alive. Another host's young item stays.
 */
export function stagingAbandoned(
  name: string,
  host: string,
  alive: (pid: number) => boolean,
  ageMs: number,
): boolean {
  if (ageMs > STAGING_MAX_AGE_MS) return true;
  const match = /^(.*)-(\d+)-[^-]+$/.exec(name);
  return match !== null && match[1] === host && !alive(Number(match[2]));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

/** Sum of the lengths of every regular file under `dir`. */
export async function fileLengths(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) bytes += await fileLengths(full);
    else if (entry.isFile()) bytes += (await lstat(full)).size;
  }
  return bytes;
}

export type Cache = {
  root: string;
  identity: string;
  npm: NpmSettings;
  keys: (lockText: string, name: string, version: string) => Keys;
  /** Whether anything is cached for name@version, under any key. */
  hasVersion: (name: string, version: string) => Promise<boolean>;
  /** A part's body when it is valid, else null (an invalid file is removed). */
  read: (part: Part, name: string, version: string, key: string) => Promise<unknown>;
  /** Publishes a part unless one is already there (the first writer wins). */
  write: (part: Part, name: string, version: string, key: string, body: unknown) => Promise<void>;
  /** A new staging directory of this call. */
  staging: () => Promise<string>;
  /** Keeps an install directory (staged by this call) under its key; false when it is not kept. */
  publishInstall: (dir: string, key: string) => Promise<boolean>;
  discard: (dir: string) => Promise<void>;
  /** The eviction pass: dead calls' staging, then each part over its limit. */
  evict: () => Promise<void>;
};

const encodeName = (name: string) => encodeURIComponent(name);

/** Test seams: the limits, and a pause at a named step (so a test can kill the call there). */
export type CacheOptions = {
  dir?: string;
  limits?: Limits;
  hooks?: { beforeLink?: () => Promise<void>; beforeRename?: () => Promise<void> };
};

/** Opens the cache; null when it cannot be used (the call then measures everything fresh). */
export async function openCache(options: CacheOptions = {}): Promise<Cache | null> {
  try {
    return await open(options);
  } catch {
    return null;
  }
}

async function open(options: CacheOptions): Promise<Cache> {
  const root = join(options.dir ?? cacheDirectory(), `v${CACHE_FORMAT}`);
  const limits = options.limits ?? LIMITS;
  const hooks = options.hooks ?? {};
  const entries = join(root, "entries");
  const installs = join(root, "installs");
  const tmp = join(root, "tmp");
  for (const dir of [entries, installs, tmp]) await mkdir(dir, { recursive: true });
  const host = hostname().replace(/[^A-Za-z0-9.]/g, "_");
  const prefix = `${host}-${process.pid}-`;
  const unique = () => `${prefix}${randomBytes(6).toString("hex")}`;

  const staging = () => mkdtemp(join(tmp, prefix));
  const discard = (dir: string) => rm(dir, { recursive: true, force: true });
  const removeWholeOrNothing = async (path: string) => {
    const moved = join(tmp, unique());
    try {
      await rename(path, moved);
    } catch {
      return;
    }
    await discard(moved);
  };

  const probe = await staging();
  let identity: string;
  let npm: NpmSettings;
  try {
    await writeFile(
      join(probe, "package.json"),
      JSON.stringify({ name: "depfit-probe", private: true }),
    );
    [identity, npm] = await Promise.all([measurementIdentity(), npmSettings(probe)]);
  } finally {
    await discard(probe);
  }

  const partPath = (part: Part, name: string, version: string, key: string) =>
    join(entries, `${encodeName(name)}@${version}`, `${key}.${part}.json`);

  return {
    root,
    identity,
    npm,
    keys: (lockText, name, version) =>
      keysFor(identity, npm.hash, treeHash(lockText), name, version),
    hasVersion: async (name, version) => {
      try {
        return (await readdir(join(entries, `${encodeName(name)}@${version}`))).length > 0;
      } catch {
        return false;
      }
    },
    read: async (part, name, version, key) => {
      const path = partPath(part, name, version, key);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return null;
      }
      const body = validPart(text, part, key);
      if (body === null) {
        await removeWholeOrNothing(path);
        return null;
      }
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return body;
    },
    write: async (part, name, version, key, body) => {
      const path = partPath(part, name, version, key);
      const temp = join(tmp, `${unique()}.json`);
      const json = JSON.stringify(body);
      const envelope = { format: CACHE_FORMAT, part, key, sha256: sha256(json), body };
      await writeFile(temp, JSON.stringify(envelope));
      try {
        await mkdir(dirname(path), { recursive: true });
        await hooks.beforeLink?.();
        await link(temp, path);
      } catch (error) {
        if (!(isRecord(error) && error.code === "EEXIST")) throw error;
      } finally {
        await rm(temp, { force: true });
      }
    },
    staging,
    publishInstall: async (dir, key) => {
      for (const entry of await readdir(dir)) {
        if (entry.startsWith(".depfit-") || entry.startsWith("__depfit")) {
          await rm(join(dir, entry), { recursive: true, force: true });
        }
      }
      const bytes = await fileLengths(dir);
      if (bytes > limits.installs) return false;
      await writeFile(join(dir, SIZE_FILE), String(bytes));
      await hooks.beforeRename?.();
      try {
        await rename(dir, join(installs, key));
        return true;
      } catch {
        return false;
      }
    },
    discard,
    evict: async () => {
      const now = Date.now();
      for (const name of await readdir(tmp)) {
        const age = await stat(join(tmp, name)).then(
          (s) => now - s.mtimeMs,
          () => 0,
        );
        if (stagingAbandoned(name, host, pidAlive, age)) await discard(join(tmp, name));
      }
      const entryItems: Item[] = [];
      for (const dir of await readdir(entries)) {
        const files = await readdir(join(entries, dir)).catch(() => []);
        for (const file of files) {
          const path = join(entries, dir, file);
          const info = await stat(path).catch(() => null);
          if (info) entryItems.push({ path, bytes: info.size, lastUsedMs: info.mtimeMs });
        }
      }
      const installItems: Item[] = [];
      for (const key of await readdir(installs)) {
        const path = join(installs, key);
        const sizeFile = join(path, SIZE_FILE);
        const [text, info] = await Promise.all([
          readFile(sizeFile, "utf8").catch(() => null),
          stat(sizeFile).catch(() => null),
        ]);
        const bytes = text === null ? Number.NaN : Number(text);
        if (!info || !Number.isFinite(bytes)) {
          await removeWholeOrNothing(path);
          continue;
        }
        installItems.push({ path, bytes, lastUsedMs: info.mtimeMs });
      }
      for (const victim of chooseVictims(entryItems, limits.entries))
        await removeWholeOrNothing(victim.path);
      for (const victim of chooseVictims(installItems, limits.installs))
        await removeWholeOrNothing(victim.path);
    },
  };
}

/** A part's body when its envelope is whole and belongs to `key`, else null. */
export function validPart(text: string, part: Part, key: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { format, key: stored, part: storedPart, sha256: checksum, body } = parsed;
  if (format !== CACHE_FORMAT || stored !== key || storedPart !== part) return null;
  if (body === undefined || checksum !== sha256(JSON.stringify(body))) return null;
  return body;
}

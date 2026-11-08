/** Isolated `npm install` of one package in a temp dir, to see its own tree with no dedupe. */
import { type ExecFileOptions, execFile } from "node:child_process";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { track } from "./children.ts";
import type { TreeEdge, TreePackage } from "./facts.ts";
import { resolveAlias } from "./lockfile.ts";
import { asRecord, asString, asStringArray, asStringRecord, isRecord } from "./util.ts";

function npm(args: string[], options: ExecFileOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("npm", args, options, (error) => (error ? reject(error) : resolve()));
    track(child);
  });
}

export type Install = { dir: string; tree: TreePackage[] };

/** Native addons (.node) and FFI libraries (.dylib, .so, .so.1, .dll). */
const NATIVE_FILE = /(?:\.node|\.dylib|\.dll|\.so(?:\.\d+)*)$/;

async function dirStats(dir: string, top = true): Promise<{ bytes: number; native: boolean }> {
  let bytes = 0;
  let native = false;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Nested node_modules are separate tree entries.
    if (top && entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirStats(full, false);
      bytes += sub.bytes;
      native ||= sub.native;
    } else if (entry.isFile()) {
      bytes += (await stat(full)).size;
      if (NATIVE_FILE.test(entry.name) || entry.name === "binding.gyp") native = true;
    }
  }
  return { bytes, native };
}

function licenseOf(entry: Record<string, unknown>): string | null {
  return asString(entry.license) ?? asString(asRecord(entry.license).type);
}

/** What a package makes npm install: dependencies, optionalDependencies and required peers. */
function edgesOf(entry: Record<string, unknown>): TreeEdge[] {
  const optionalPeers = new Set(
    Object.entries(asRecord(entry.peerDependenciesMeta))
      .filter(([, meta]) => asRecord(meta).optional === true)
      .map(([peer]) => peer),
  );
  const requiredPeers = Object.entries(asStringRecord(entry.peerDependencies)).filter(
    ([key]) => !optionalPeers.has(key),
  );
  return [
    ...Object.entries(asStringRecord(entry.dependencies)),
    ...Object.entries(asStringRecord(entry.optionalDependencies)),
    ...requiredPeers,
  ].map(([key, raw]) => ({ key, ...resolveAlias(key, raw) }));
}

/** The platform npm checks optional packages against (npm-install-checks' `checkPlatform`). */
export type Platform = { os: string; cpu: string; libc: string | null };

let libcFamily: string | null | undefined;

/** glibc or musl on Linux (as npm detects it from the process report); null elsewhere. */
function currentLibc(): string | null {
  if (process.platform !== "linux") return null;
  if (libcFamily !== undefined) return libcFamily;
  const report: unknown = process.report?.getReport();
  const header = isRecord(report) ? asRecord(report.header) : {};
  const shared = isRecord(report) ? asStringArray(report.sharedObjects) : [];
  libcFamily = header.glibcVersionRuntime
    ? "glibc"
    : shared.some((file) => file.includes("libc.musl-") || file.includes("ld-musl-"))
      ? "musl"
      : null;
  return libcFamily;
}

export function currentPlatform(): Platform {
  return { os: process.platform, cpu: process.arch, libc: currentLibc() };
}

/** npm's `checkList`: none of the negated values, and one of the others when there are any. */
function listAllows(value: string | null, raw: unknown): boolean {
  const list = typeof raw === "string" ? [raw] : asStringArray(raw);
  if (list.length === 1 && list[0] === "any") return true;
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (entry.startsWith("!")) {
      negated++;
      if (value === entry.slice(1)) return false;
    } else if (value === entry) match = true;
  }
  return match || negated === list.length;
}

/** Whether npm skips this lockfile entry on `platform` (its `os`, `cpu` or `libc`). */
export function platformExcludes(entry: Record<string, unknown>, platform: Platform): boolean {
  if (entry.os !== undefined && !listAllows(platform.os, entry.os)) return true;
  if (entry.cpu !== undefined && !listAllows(platform.cpu, entry.cpu)) return true;
  if (entry.libc !== undefined && (!platform.libc || !listAllows(platform.libc, entry.libc))) {
    return true;
  }
  return false;
}

/** Whether npm's `omit` setting (dev, optional, peer) leaves this lockfile entry out. */
function omitted(entry: Record<string, unknown>, omit: ReadonlySet<string>): boolean {
  if (omit.has("dev") && (entry.dev === true || entry.devOptional === true)) return true;
  if (omit.has("optional") && (entry.optional === true || entry.devOptional === true)) return true;
  return omit.has("peer") && entry.peer === true;
}

/**
 * The installed tree. `whole` is false when a package npm should have installed here is missing
 * (not excluded by its `os`, `cpu` or `libc`, nor by `omit`), or a package directory could not be
 * read: such an install is never cached (SPEC.md, "Cache (#8)").
 */
export async function readTree(
  dir: string,
  options: { platform?: Platform; omit?: ReadonlySet<string> } = {},
): Promise<{ tree: TreePackage[]; whole: boolean }> {
  const platform = options.platform ?? currentPlatform();
  const omit = options.omit ?? new Set<string>();
  const lock = asRecord(JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8")));
  const packages = Object.entries(asRecord(lock.packages)).filter(([path]) =>
    path.includes("node_modules/"),
  );
  let whole = true;
  const tree = await Promise.all(
    packages.map(async ([path, value]): Promise<TreePackage> => {
      const entry = asRecord(value);
      const name = asString(entry.name) ?? path.slice(path.lastIndexOf("node_modules/") + 13);
      // npm leaves out only the optional packages it cannot install here: other OS/CPU/libc.
      const packageDir = join(dir, path);
      const size = await dirStats(packageDir).catch((error: unknown) => {
        // Only the package directory itself missing means npm left it out; anything else is a read failure.
        const missing = isRecord(error) && error.code === "ENOENT" && error.path === packageDir;
        if (!missing || !(platformExcludes(entry, platform) || omitted(entry, omit))) whole = false;
        return null;
      });
      return {
        path,
        name,
        version: asString(entry.version) ?? "",
        edges: edgesOf(entry),
        installed: size !== null,
        diskBytes: size?.bytes ?? 0,
        hasInstallScript: entry.hasInstallScript === true,
        nativeBinary: size?.native ?? false,
        license: licenseOf(entry),
      };
    }),
  );
  return { tree, whole };
}

const NPM_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];

const MANIFEST = { name: "depfit-probe", private: true };

function npmOptions(dir: string): ExecFileOptions {
  return {
    cwd: dir,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  };
}

/**
 * Eval-only (eval/run.ts): `DEPFIT_LOCK_DIR` names a directory of frozen install trees, one npm
 * lockfile per name@version. An install replays the frozen tree with `npm ci` when there is one,
 * and otherwise records the tree it resolved, so a later run installs the same packages.
 */
function frozenLockPath(name: string, version: string): string | null {
  const dir = process.env.DEPFIT_LOCK_DIR;
  return dir ? join(dir, `${name.replace("/", "__")}@${version}.package-lock.json`) : null;
}

/** The frozen lockfile `DEPFIT_LOCK_DIR` holds for name@version, or null. */
export async function frozenLock(name: string, version: string): Promise<string | null> {
  const lockPath = frozenLockPath(name, version);
  return lockPath ? readFile(lockPath, "utf8").catch(() => null) : null;
}

/**
 * Publishes a recorded tree at `lockPath` atomically and never over an existing record: written to a
 * temp file beside it, then hard-linked into place, which fails if another install recorded first
 * (that record stands; this install's tree is only used for this run).
 */
async function recordLock(source: string, lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const temp = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  await copyFile(source, temp);
  try {
    await link(temp, lockPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Records the tree installed in `dir` under `DEPFIT_LOCK_DIR`, when that is set (eval only). */
export async function recordFrozenLock(dir: string, name: string, version: string): Promise<void> {
  const lockPath = frozenLockPath(name, version);
  if (lockPath) await recordLock(join(dir, "package-lock.json"), lockPath);
}

/**
 * Resolves name@version alone with `npm install --package-lock-only` in `dir`, which must be empty:
 * no lockfile and no node_modules, so npm cannot keep an old resolution. Returns the lockfile.
 */
export async function resolveLock(dir: string, name: string, version: string): Promise<string> {
  await writeFile(join(dir, "package.json"), JSON.stringify(MANIFEST));
  await npm(["install", "--package-lock-only", `${name}@${version}`, ...NPM_FLAGS], npmOptions(dir));
  return readFile(join(dir, "package-lock.json"), "utf8");
}

/**
 * Installs into `dir`: `npm ci` from `lock` when given (the tree is that lockfile's, by
 * construction), else `npm install name@version`, recording the tree under `DEPFIT_LOCK_DIR` when
 * that is set. Returns the lockfile npm wrote.
 */
export async function installInto(
  dir: string,
  name: string,
  version: string,
  lock: string | null,
): Promise<string> {
  if (lock) {
    const root = asRecord(asRecord(asRecord(JSON.parse(lock)).packages)[""]);
    const dependencies = asStringRecord(root.dependencies);
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...MANIFEST, dependencies }));
    await writeFile(join(dir, "package-lock.json"), lock);
    await npm(["ci", ...NPM_FLAGS], npmOptions(dir));
  } else {
    await writeFile(join(dir, "package.json"), JSON.stringify(MANIFEST));
    await npm(["install", `${name}@${version}`, ...NPM_FLAGS], npmOptions(dir));
    await recordFrozenLock(dir, name, version);
  }
  return readFile(join(dir, "package-lock.json"), "utf8");
}

/**
 * Installs name@version alone (scripts disabled), runs `use` on the result, and always removes
 * the temp dir afterwards.
 */
export async function withIsolatedInstall<T>(
  name: string,
  version: string,
  use: (install: Install) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "depfit-"));
  try {
    await installInto(dir, name, version, await frozenLock(name, version));
    return await use({ dir, tree: (await readTree(dir)).tree });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Isolated `npm install` of one package in a temp dir, to see its own tree with no dedupe. */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TreeEdge, TreePackage } from "./facts.ts";
import { resolveAlias } from "./lockfile.ts";
import { asRecord, asString, asStringRecord } from "./util.ts";

const run = promisify(execFile);

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

async function readTree(dir: string): Promise<TreePackage[]> {
  const lock = asRecord(JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8")));
  const packages = Object.entries(asRecord(lock.packages)).filter(([path]) =>
    path.includes("node_modules/"),
  );

  return Promise.all(
    packages.map(async ([path, value]): Promise<TreePackage> => {
      const entry = asRecord(value);
      const name = asString(entry.name) ?? path.slice(path.lastIndexOf("node_modules/") + 13);
      // npm leaves out only the optional packages it cannot install here: other OS/CPU/libc.
      const size = await dirStats(join(dir, path)).catch(() => null);
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
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "depfit-probe", private: true }),
    );
    await run(
      "npm",
      [
        "install",
        `${name}@${version}`,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      {
        cwd: dir,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === "win32",
      },
    );
    return await use({ dir, tree: await readTree(dir) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

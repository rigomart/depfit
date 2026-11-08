/**
 * Vitest global setup: every test run uses a cache directory of its own through XDG_CACHE_HOME,
 * and the run fails if anything wrote to the user's real depfit cache directory meanwhile.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDirectory } from "../src/collect/cache.ts";

async function snapshot(dir: string): Promise<string> {
  const walk = async (path: string): Promise<string[]> => {
    const info = await stat(path).catch(() => null);
    if (!info) return [];
    if (!info.isDirectory()) return [`${path} ${info.size} ${info.mtimeMs}`];
    const names = await readdir(path).catch(() => []);
    const nested = await Promise.all(names.map((name) => walk(join(path, name))));
    return [`${path}/ ${info.mtimeMs}`, ...nested.flat()];
  };
  return (await walk(dir)).join("\n");
}

export default async function setup(): Promise<() => Promise<void>> {
  const real = cacheDirectory({ ...process.env, XDG_CACHE_HOME: undefined });
  const before = await snapshot(real);
  const isolated = await mkdtemp(join(tmpdir(), "depfit-test-xdg-"));
  process.env.XDG_CACHE_HOME = isolated;
  return async () => {
    await rm(isolated, { recursive: true, force: true });
    if ((await snapshot(real)) !== before) {
      throw new Error(`a test wrote to the real depfit cache directory ${real}`);
    }
  };
}

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { platformExcludes, readTree } from "../src/collect/install.ts";

const MAC = { os: "darwin", cpu: "arm64", libc: null };
const LINUX = { os: "linux", cpu: "x64", libc: "glibc" };

describe("platformExcludes", () => {
  it("follows npm's os, cpu and libc lists, negations included", () => {
    expect(platformExcludes({ os: ["linux"] }, MAC)).toBe(true);
    expect(platformExcludes({ os: ["darwin"] }, MAC)).toBe(false);
    expect(platformExcludes({ os: ["!win32"] }, MAC)).toBe(false);
    expect(platformExcludes({ os: ["!darwin"] }, MAC)).toBe(true);
    expect(platformExcludes({ cpu: ["x64"] }, MAC)).toBe(true);
    expect(platformExcludes({ os: "any" }, MAC)).toBe(false);
    expect(platformExcludes({ libc: ["musl"] }, LINUX)).toBe(true);
    expect(platformExcludes({ libc: ["glibc"] }, LINUX)).toBe(false);
    expect(platformExcludes({ libc: ["glibc"] }, MAC)).toBe(true);
    expect(platformExcludes({}, MAC)).toBe(false);
  });
});

describe("readTree", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "depfit-readtree-"));
  });
  afterEach(async () => {
    await chmod(join(dir, "node_modules", "a"), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const install = async (packages: Record<string, Record<string, unknown>>, present: string[]) => {
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }),
    );
    for (const path of present) {
      await mkdir(join(dir, path), { recursive: true });
      await writeFile(join(dir, path, "index.js"), "x");
    }
  };

  it("is whole when only other platforms' optional packages are missing", async () => {
    await install(
      {
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a-linux": { version: "1.0.0", optional: true, os: ["linux"] },
      },
      ["node_modules/a"],
    );
    const { tree, whole } = await readTree(dir, { platform: MAC });
    expect(whole).toBe(true);
    expect(tree.find((p) => p.name === "a-linux")?.installed).toBe(false);
  });

  it("is not whole when a package for this platform is missing", async () => {
    await install(
      {
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "1.0.0", optional: true },
      },
      ["node_modules/a"],
    );
    expect((await readTree(dir, { platform: MAC })).whole).toBe(false);
  });

  it("is whole when npm's omit setting left the missing package out", async () => {
    await install(
      {
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "1.0.0", optional: true },
      },
      ["node_modules/a"],
    );
    expect((await readTree(dir, { platform: MAC, omit: new Set(["optional"]) })).whole).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "is not whole when a package directory cannot be read",
    async () => {
      await install({ "node_modules/a": { version: "1.0.0" } }, ["node_modules/a"]);
      await chmod(join(dir, "node_modules", "a"), 0o000);
      const { tree, whole } = await readTree(dir, { platform: MAC });
      expect(whole).toBe(false);
      expect(tree[0]?.installed).toBe(false);
    },
  );
});

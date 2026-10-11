import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countPackages,
  dependentsOf,
  type LockIndex,
  lockedVersions,
  parseLockfile,
} from "../src/collect/lockfile.ts";
import type { Lockfile } from "../src/report.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

const cases: Array<[string, Lockfile]> = [
  ["mcp-server", "package-lock.json"],
  ["mcp-server-pnpm", "pnpm-lock.yaml"],
  ["mcp-server-yarn", "yarn.lock"],
  ["mcp-server-bun", "bun.lock"],
];

function parseFixture(dir: string, lockfile: Lockfile): LockIndex {
  return parseLockfile(lockfile, readFileSync(join(FIXTURES, dir, lockfile), "utf8"));
}

function packageSet(index: LockIndex): string[] {
  return [...index]
    .flatMap(([name, versions]) => [...versions.keys()].map((v) => `${name}@${v}`))
    .sort();
}

function dependentsMap(index: LockIndex): Record<string, string[]> {
  return Object.fromEntries([...index.keys()].map((name) => [name, dependentsOf(index, name)]));
}

describe("parseLockfile", () => {
  const npm = parseFixture("mcp-server", "package-lock.json");

  it.each(cases)("%s (%s) has the same package set as package-lock.json", (dir, lockfile) => {
    const index = parseFixture(dir, lockfile);
    expect(packageSet(index)).toEqual(packageSet(npm));
    expect(index.size).toBe(92);
    expect(countPackages(index)).toBe(93);
  });

  it.each(cases)("%s (%s) resolves zod@4.6.5, pulled in by the MCP SDK", (dir, lockfile) => {
    const index = parseFixture(dir, lockfile);
    expect(lockedVersions(index, "zod")).toEqual(["4.6.5"]);
    expect(dependentsOf(index, "zod")).toContain("@modelcontextprotocol/sdk");
  });

  it.each(cases.filter(([, lockfile]) => lockfile !== "yarn.lock"))(
    "%s (%s) records dependency, optional and peer edges like npm",
    (dir, lockfile) => {
      const index = parseFixture(dir, lockfile);
      expect(dependentsMap(index)).toEqual(dependentsMap(npm));
      // zod-to-json-schema reaches zod only through peerDependencies.
      expect(dependentsOf(index, "zod")).toEqual([
        "@modelcontextprotocol/sdk",
        "zod-to-json-schema",
      ]);
    },
  );

  it("yarn v1 records no peers, so only peer edges are missing", () => {
    const yarn = dependentsMap(parseFixture("mcp-server-yarn", "yarn.lock"));
    for (const [name, dependents] of Object.entries(yarn)) {
      expect(dependentsMap(npm)[name]).toEqual(expect.arrayContaining(dependents));
    }
    expect(yarn.zod).toEqual(["@modelcontextprotocol/sdk"]);
  });

  it("reads aliases and nested versions from package-lock.json", () => {
    const index = parseLockfile(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { a: "^1" } },
          "node_modules/a": { version: "1.0.0", dependencies: { "b-cjs": "npm:b@^1", b: "^2" } },
          "node_modules/b": { version: "2.0.0" },
          "node_modules/b-cjs": { name: "b", version: "1.5.0" },
          "node_modules/ws": { version: "0.0.0", link: true },
        },
      }),
    );
    expect(lockedVersions(index, "b")).toEqual(["1.5.0", "2.0.0"]);
    expect(index.get("b")?.get("1.5.0")).toEqual(new Set(["a"]));
    expect(index.get("b")?.get("2.0.0")).toEqual(new Set(["a"]));
    expect(index.has("ws")).toBe(false);
  });

  it.each([
    ["bun-workspace", "bun.lock"],
    ["pnpm-workspace", "pnpm-lock.yaml"],
  ] as const)("%s (%s) skips workspace packages and importers", (dir, lockfile) => {
    const index = parseFixture(dir, lockfile);
    expect(packageSet(index)).toEqual(["hono@4.13.13", "typescript@5.9.3", "zod@4.6.5"]);
    expect(dependentsOf(index, "zod")).toEqual([]);
  });
});

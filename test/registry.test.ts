import { describe, expect, it } from "vitest";
import { chooseVersion, parseSpec } from "../src/collect/registry.ts";

describe("parseSpec", () => {
  it("splits names from ranges and dist-tags", () => {
    expect(parseSpec("zod")).toEqual({ kind: "npm", name: "zod", range: null });
    expect(parseSpec("zod@^3")).toEqual({ kind: "npm", name: "zod", range: "^3" });
    expect(parseSpec("zod@")).toEqual({ kind: "npm", name: "zod", range: null });
    expect(parseSpec("@a/b@next")).toEqual({ kind: "npm", name: "@a/b", range: "next" });
    expect(parseSpec("@a/b")).toEqual({ kind: "npm", name: "@a/b", range: null });
  });

  it("recognizes node: and bun: runtime modules", () => {
    expect(parseSpec("node:sqlite")).toEqual({ kind: "builtin", name: "node:sqlite" });
    expect(parseSpec(" node:fs/promises ")).toEqual({ kind: "builtin", name: "node:fs/promises" });
    expect(parseSpec("bun:sqlite")).toEqual({ kind: "builtin", name: "bun:sqlite" });
  });
});

describe("chooseVersion", () => {
  // Shaped like node-pty: latest is 1.1.0 while 1.2.0 betas are published under `beta`.
  const packument = {
    "dist-tags": { latest: "1.1.0", beta: "1.2.0-beta.16", next: "2.0.0-rc.1" },
    versions: Object.fromEntries(
      ["1.0.0", "1.1.0", "1.2.0-beta.14", "1.2.0-beta.15", "1.2.0-beta.16", "2.0.0-rc.1"].map(
        (v) => [v, { version: v }],
      ),
    ),
  };
  const choose = (requested: string | null, declared: string | null) =>
    chooseVersion(packument, "node-pty", requested, declared);

  it("uses an explicit range or dist-tag from the spec, even over a declared range", () => {
    expect(choose("^1.0.0", "^1.2.0-beta.15")).toEqual({
      version: "1.1.0",
      version_source: "requested",
      latest_version: "1.1.0",
    });
    expect(choose("next", null).version).toBe("2.0.0-rc.1");
    expect(() => choose("^3", null)).toThrow("no version of node-pty matches ^3");
  });

  it("resolves a declared prerelease range to the highest matching prerelease", () => {
    expect(choose(null, "^1.2.0-beta.15")).toEqual({
      version: "1.2.0-beta.16",
      version_source: "declared_range",
      latest_version: "1.1.0",
    });
    expect(choose(null, "npm:node-pty@^1.2.0-beta.15").version).toBe("1.2.0-beta.16");
  });

  it("resolves a declared stable range without prereleases", () => {
    expect(choose(null, "^1.0.0")).toMatchObject({
      version: "1.1.0",
      version_source: "declared_range",
    });
    expect(choose(null, "beta")).toMatchObject({
      version: "1.2.0-beta.16",
      version_source: "declared_range",
    });
  });

  it("falls back to latest when nothing is declared or the declared range is unusable", () => {
    for (const declared of [null, "workspace:*", "^5.0.0", "npm:@lydell/node-pty@^1.0.0"]) {
      expect(choose(null, declared)).toEqual({
        version: "1.1.0",
        version_source: "latest",
        latest_version: "1.1.0",
      });
    }
  });

  it("throws for a package without versions", () => {
    expect(() => chooseVersion({}, "nope", null, null)).toThrow("nope not found on npm");
  });
});

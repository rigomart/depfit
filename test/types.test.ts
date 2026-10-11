import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestDeclaresTypes, shipsTypes } from "../src/collect/types.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "depfit-types-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes the given files (path -> contents) under the temp package dir. */
async function files(entries: Record<string, string>) {
  for (const [path, contents] of Object.entries(entries)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), contents);
  }
}

describe("shipsTypes", () => {
  it("accepts a types or typings field", async () => {
    expect(await shipsTypes(dir, { types: "./lib/index.d.ts" })).toBe(true);
    expect(await shipsTypes(dir, { typings: "index.d.ts" })).toBe(true);
  });

  it("accepts a versioned types condition in exports", async () => {
    const manifest = {
      exports: {
        ".": {
          import: {
            "types@<5.4": "./dist/esm/index.d.ts",
            default: "./dist/esm/index.js",
          },
        },
      },
    };
    expect(manifestDeclaresTypes(manifest)).toBe(true);
    expect(await shipsTypes(dir, manifest)).toBe(true);
  });

  it("finds a declaration file next to the exports entry", async () => {
    await files({ "dist/index.js": "", "dist/index.d.ts": "" });
    const manifest = { type: "module", exports: { ".": "./dist/index.js" } };
    expect(manifestDeclaresTypes(manifest)).toBe(false);
    expect(await shipsTypes(dir, manifest)).toBe(true);
  });

  it("finds .d.mts and .d.cts siblings of the main and module entries", async () => {
    await files({ "lib/main.cjs": "", "lib/main.d.cts": "" });
    expect(await shipsTypes(dir, { main: "lib/main.cjs" })).toBe(true);
    await files({ "esm/index.mjs": "", "esm/index.d.mts": "" });
    expect(await shipsTypes(dir, { main: "nope.js", module: "./esm/index.mjs" })).toBe(true);
  });

  it("finds an index.d.ts at the package root", async () => {
    await files({ "index.js": "", "index.d.ts": "" });
    expect(await shipsTypes(dir, { main: "lib/other.js" })).toBe(true);
  });

  it("reports no types when nothing declares or ships them", async () => {
    await files({ "index.js": "", "dist/index.js": "", "README.md": "" });
    const manifest = {
      main: "index.js",
      exports: { ".": "./dist/index.js", "./*": "./dist/*.js" },
    };
    expect(manifestDeclaresTypes(manifest)).toBe(false);
    expect(await shipsTypes(dir, manifest)).toBe(false);
  });

  it("ignores declarations for subpath exports only", async () => {
    await files({ "dist/index.js": "", "dist/sub.js": "", "dist/sub.d.ts": "" });
    const manifest = { exports: { ".": "./dist/index.js", "./sub": "./dist/sub.js" } };
    expect(await shipsTypes(dir, manifest)).toBe(false);
  });
});

import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";
import {
  type BundleEntry,
  bundleEntries,
  entryModuleSource,
  normalizedSnippet,
} from "../src/collect/bundle-entry.ts";

const parse = (source: string) => parseAst(source, { lang: "js", sourceType: "module" });
const CANDIDATES = ["zod", "lodash", "@atlaskit/pragmatic-drag-and-drop", "core-js"];

function entry(snippet: string, candidates = CANDIDATES): BundleEntry {
  const result = bundleEntries([snippet], candidates, parse);
  if (!result.ok) throw new Error(result.message);
  const [first] = result.entries.values();
  if (!first) throw new Error("no entry");
  return first;
}

function usageError(snippets: string[], candidates = CANDIDATES): string {
  const result = bundleEntries(snippets, candidates, parse);
  if (result.ok) throw new Error(`accepted ${snippets.join(" | ")}`);
  return result.message;
}

describe("bundle entry snippets", () => {
  it("keeps only the listed members of a binding that has member statements", () => {
    const zod = entry('import { z } from "zod"; z.object; z.string');
    expect(zod.candidate).toBe("zod");
    expect(normalizedSnippet(zod)).toBe('import { z } from "zod"; z.object; z.string;');
    expect(entryModuleSource(zod)).toBe(
      'import { z as __depfit_0 } from "zod";\nglobalThis.__depfit = [__depfit_0.object, __depfit_0.string];\n',
    );
  });

  it("keeps bindings without member statements whole", () => {
    const lodash = entry("import _, { debounce as d } from 'lodash'");
    expect(normalizedSnippet(lodash)).toBe('import _, { debounce as d } from "lodash";');
    expect(entryModuleSource(lodash)).toBe(
      'import __depfit_0, { debounce as __depfit_1 } from "lodash";\nglobalThis.__depfit = [__depfit_0, __depfit_1];\n',
    );
    const namespace = entry('import * as ns from "zod"');
    expect(entryModuleSource(namespace)).toContain("globalThis.__depfit = [__depfit_0];");
  });

  it("gives imported bindings generated names, so none can shadow globalThis", () => {
    const shadow = entry('import { z as globalThis } from "zod"; globalThis.object');
    expect(normalizedSnippet(shadow)).toBe(
      'import { z as globalThis } from "zod"; globalThis.object;',
    );
    expect(entryModuleSource(shadow)).toBe(
      'import { z as __depfit_0 } from "zod";\nglobalThis.__depfit = [__depfit_0.object];\n',
    );
  });

  it("measures side-effect imports as written, keeping nothing else", () => {
    const polyfill = entry('import "core-js/stable";');
    expect(normalizedSnippet(polyfill)).toBe('import "core-js/stable";');
    expect(entryModuleSource(polyfill)).toBe('import "core-js/stable";\n');
  });

  it("accepts subpaths, scoped names, nested members, and repeated members once", () => {
    const pdnd = entry(
      'import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter"; draggable.x.y; draggable.x.y;',
    );
    expect(pdnd.candidate).toBe("@atlaskit/pragmatic-drag-and-drop");
    expect(pdnd.members).toEqual(["draggable.x.y"]);
  });

  it("rejects subpaths that could leave the package or name another one", () => {
    for (const source of [
      "lodash/../../package.json",
      "lodash/./fp",
      "lodash/",
      "lodash//fp",
      "lodash/fp/..",
      "lodash/%2e%2e/package.json",
      "lodash/..%2fpackage.json",
      "lodash/\\..\\package.json",
      "lodash/node_modules/zod",
      "lodash/fp?raw",
      "lodash/fp#x",
    ]) {
      expect(usageError([`import x from ${JSON.stringify(source)}`]), source).toMatch(
        /a subpath may not/,
      );
    }
    expect(entry('import fp from "lodash/fp/..x.js"').imports[0]?.source).toBe("lodash/fp/..x.js");
  });

  it("rejects a binding bound twice", () => {
    expect(usageError(['import x from "zod"; import x from "zod"'])).toMatch(/binds `x` more/);
  });

  it("matches a candidate by name, not by prefix", () => {
    expect(usageError(['import x from "zod-mini"'])).toMatch(
      /"zod-mini", which is not a candidate/,
    );
  });

  it("rejects anything but imports and plain member statements", () => {
    expect(usageError(['import { z } from "zod"; z.object()'])).toMatch(/not `z.object\(\)`/);
    expect(usageError(['import { z } from "zod"; const s = z.string'])).toMatch(/not `const s/);
    expect(usageError(['import { z } from "zod"; z["object"]'])).toMatch(/plain member/);
    expect(usageError(['import { z } from "zod"; z?.object'])).toMatch(/plain member/);
    expect(usageError(['import { z } from "zod"; z'])).toMatch(/plain member/);
    expect(usageError(['import { z } from "zod"; y.object'])).toMatch(/imported binding/);
    expect(usageError(['export { z } from "zod"'])).toMatch(/only import declarations/);
    expect(usageError(['import data from "zod/package.json" with { type: "json" }'])).toMatch(
      /attributes/,
    );
  });

  it("rejects imports of anything but one candidate", () => {
    expect(usageError(['import fs from "node:fs"'])).toMatch(/not a candidate/);
    expect(usageError(['import { z } from "zod"; import _ from "lodash"'])).toMatch(
      /more than one candidate \(zod, lodash\)/,
    );
    expect(usageError(["z.object"])).toMatch(/no import declaration/);
  });

  it("allows one snippet per candidate", () => {
    const result = bundleEntries(
      ['import { z } from "zod"', 'import _ from "lodash"'],
      CANDIDATES,
      parse,
    );
    expect(result.ok && [...result.entries.keys()]).toEqual(["zod", "lodash"]);
    expect(usageError(['import { z } from "zod"', 'import * as m from "zod/mini"'])).toMatch(
      /given twice for zod/,
    );
  });

  it("reports syntax errors as usage errors", () => {
    expect(usageError(['import { z from "zod"'])).toMatch(/^--bundle-entry is not valid JS: /);
  });
});

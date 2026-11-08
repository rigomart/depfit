import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";
import { compareContract } from "../eval/bundle/contract.ts";
import { parseReason } from "../eval/bundle/reasons.ts";
import { auditChunk, type ParseModule } from "../eval/bundle/wild-audit.ts";

// The bundle eval's own checks: gate E's flake rule and gate W's auditor. The auditor parses with
// webpack's acorn in the eval; any ESTree parser with node offsets exercises the same logic here.
const parse: ParseModule = (code) => parseAst(code, { lang: "js", sourceType: "module" });

describe("gate E contract comparison", () => {
  const report = () => ({
    schema_version: 5,
    generated_at: "t",
    packages: [
      {
        name: "p",
        unavailable: [] as string[],
        cost: { new_install_bytes: 10 } as Record<string, unknown> | null,
        compatibility: { engines: { node: ">=18" }, types_source: "bundled", types_package: null },
        maintenance: { weekly_downloads: 5, archived: false, last_commit_at: "t" } as Record<
          string,
          unknown
        >,
        security: { advisories: [], dependency_vulnerabilities: [] } as unknown,
        bundle: null,
      },
    ],
  });
  const compare = (mutate: (pkg: ReturnType<typeof report>["packages"][number]) => void) => {
    const changed = report();
    const pkg = changed.packages[0];
    if (pkg) mutate(pkg);
    return compareContract(report(), changed);
  };

  it("excuses only the fields a failed source feeds", () => {
    expect(
      compare((p) => {
        p.unavailable.push("github: HTTP 429");
        Object.assign(p.maintenance, { archived: null, last_commit_at: null });
      }).network,
    ).toBe(true);
    expect(
      compare((p) => {
        p.unavailable.push("osv: HTTP 503");
        p.security = null;
      }).network,
    ).toBe(true);
  });

  it("fails an unrelated change, a missing key or a nulled section next to a failed source", () => {
    const cost = compare((p) => {
      p.unavailable.push("downloads: HTTP 429");
      p.cost = null;
    });
    expect(cost).toMatchObject({ network: false, diff: { path: "packages[0].cost" } });
    const missing = compare((p) => {
      p.unavailable.push("github: HTTP 503");
      delete p.maintenance.archived;
    });
    expect(missing.network).toBe(false);
    expect(compare((p) => delete p.maintenance.weekly_downloads).diff).not.toBeNull();
    const nested = compare((p) => {
      p.unavailable.push("osv: HTTP 503");
      p.security = { dependency_vulnerabilities: [] };
    });
    expect(nested.network).toBe(false);
  });
});

describe("gate W auditor", () => {
  const fetches = (code: string, chunks = ["entry.js", "chunk-x.js"]) =>
    [parse, undefined].map((mode) =>
      auditChunk(code, chunks[0] ?? "", chunks, [], mode).some((hit) => hit.strength === "fetch"),
    );
  const loader = 'r.u=e=>e+".js";';

  it("finds code fetched from outside the bundle in both parse and text modes", () => {
    for (const code of [
      'const a = () => import("https://cdn.example/entry.js");',
      'const a = () => import("./" + globalThis.remote);',
      'self["importScripts"]("https://cdn.example/x.js");',
      'const l = (id) => import("https://cdn/" + app.u(id));',
      `${loader}const l = (id) => import("https://cdn/" + r.u(id));`,
      `${loader}const l = (id) => import("./" + r.u(id) + "https://cdn/");`,
      `${loader}const l = (id) => import("./" + app.u(id));`,
      'r.u = (id) => "https://cdn.example/" + id; const l = (id) => import("" + r.u(id));',
      'r.u = "x"; const l = (id) => import("./" + r.u(id));',
      'r.u = (id) => id; const l = () => import("./" + r.u("missing.js"));',
      `${loader}r.u = globalThis.other; const l = (id) => import("./" + r.u(id));`,
      `${loader}const l = (id) => import("/not-emitted/" + r.u(id));`,
      `${loader}const l = (id) => import("./not-emitted/" + r.u(id));`,
      `${loader}({ u: r.u } = globalThis.other); const l = (id) => import("./" + r.u(id));`,
      `${loader}for (r.u of [globalThis.f]) {} const l = (id) => import("./" + r.u(id));`,
      'const r = { u: globalThis.f }; r.u ||= (e) => e + ".js"; const l = (id) => import("./" + r.u(id));',
      `${loader}r.u = (id) => "https://cdn/" + id; const l = (id) => import("./" + r.u(id));`,
      'const a = () => import("../chunk-x.js");',
    ]) {
      expect(fetches(code), code).toEqual([true, true]);
    }
  });

  it("ignores the build's own chunks, webpack's loader, and words inside strings", () => {
    expect(fetches('const a = () => import("./chunk-x.js");')).toEqual([false, false]);
    // Text mode cannot tie a loader to its filename function, so it reports it.
    expect(fetches(`${loader}const l = (e) => import("./" + r.u(e));`)).toEqual([false, true]);
    // Only the exact `"<dir>" + r.u(id)` form is exempt; a public path in between is reported.
    expect(fetches(`${loader}const l = (e) => import("./" + r.p + r.u(e));`)).toEqual([true, true]);
    expect(
      fetches('const a = () => import("./axe.js");', ["assets/i.js", "assets/axe.js"]),
    ).toEqual([false, false]);
    // The loader's directory is resolved from the importing chunk: a nested importer's "./" is
    // its own directory, which holds no chunk here; "../" reaches the root's chunks.
    const nested = ["nested/entry.js", "chunk.js"];
    expect(fetches(`${loader}const l = (e) => import("./" + r.u(e));`, nested)[0]).toBe(true);
    expect(fetches(`${loader}const l = (e) => import("../" + r.u(e));`, nested)[0]).toBe(false);
    // Text mode cannot tell a string from a call; it errs toward reporting.
    expect(fetches('const s = "import(";')).toEqual([false, true]);
  });
});

describe("parseReason (iteration 2 unavailable format)", () => {
  const errors = (entry: string) => parseReason(entry).errors;

  it("parses an entry of its own and a group appended to a root entry", () => {
    expect(parseReason('bundle: UNRESOLVED_IMPORT in subpaths ["./a","./b"]')).toEqual({
      free: "",
      groups: [{ code: "UNRESOLVED_IMPORT", keys: ["./a", "./b"] }],
      errors: [],
    });
    const appended = parseReason(
      'bundle: NON_JS_IMPORT x.css; NON_JS_IMPORT in subpaths ["./a,./b","./q\\"]"]',
    );
    expect(appended.groups).toEqual([{ code: "NON_JS_IMPORT", keys: ["./a,./b", './q"]'] }]);
    expect(appended.errors).toEqual([]);
    expect(
      errors('bundle: 2 exports unmeasurable (A_CODE, B_CODE); B_CODE in subpaths ["./x"]'),
    ).toEqual([]);
  });

  it("rejects text that breaks the framing rule", () => {
    expect(errors("bundle: UNRESOLVED_IMPORT a;b")).toContain(
      'unencoded ; or [ in "bundle: UNRESOLVED_IMPORT a;b"',
    );
    expect(errors("bundle: UNRESOLVED_IMPORT 50%.js").join()).toMatch(/unencoded %/);
    expect(errors("bundle: UNRESOLVED_IMPORT 50%25.js, a%3Bb%5B")).toEqual([]);
    expect(errors('bundle: CODE in subpaths ["./a"')).toEqual(["unterminated array for CODE"]);
    expect(errors("bundle: CODE in subpaths [1]").join()).toMatch(/non-string keys/);
    expect(errors('bundle: CODE in subpaths ["./b","./a"]').join()).toMatch(/code-point order/);
    expect(errors('bundle: CODE in subpaths ["./a"] extra').join()).toMatch(/text after/);
    expect(errors("bundle: UNRESOLVED_IMPORT fs; ").join()).toMatch(/separator with no group/);
    expect(
      errors('bundle: UNRESOLVED_IMPORT fs; NON_JS_IMPORT in subpaths ["./x"]').join(),
    ).toMatch(/does not report that code/);
    expect(
      errors('bundle: B_CODE x; B_CODE in subpaths ["./a"]; A_CODE in subpaths ["./b"]').join(),
    ).toMatch(/out of code-point order|does not report/);
  });
});

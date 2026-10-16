import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";
import { compareContract } from "../eval/bundle/contract.ts";
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
    // Text mode cannot tell a string from a call; it errs toward reporting.
    expect(fetches('const s = "import(";')).toEqual([false, true]);
  });
});

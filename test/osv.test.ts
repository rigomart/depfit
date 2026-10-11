import { describe, expect, it } from "vitest";
import { toAdvisory } from "../src/collect/osv.ts";

function record(id: string, affected: unknown[], severity: string | null = "HIGH") {
  return {
    id,
    summary: `${id} summary`,
    database_specific: severity ? { severity } : {},
    affected,
  };
}

const npmRange = (name: string, events: unknown[], versions?: string[]) => ({
  package: { name, ecosystem: "npm" },
  ranges: [{ type: "SEMVER", events }],
  ...(versions ? { versions } : {}),
});

describe("toAdvisory", () => {
  it("maps an introduced/fixed pair and evaluates every installed version", () => {
    const advisory = toAdvisory(
      record("GHSA-5v2h-r2cx-5xgj", [
        npmRange("marked", [{ introduced: "0" }, { fixed: "4.0.10" }]),
      ]),
      "marked",
      "18.1.0",
      ["4.0.9", "4.0.10", "12.0.0"],
    );
    expect(advisory).toEqual({
      id: "GHSA-5v2h-r2cx-5xgj",
      summary: "GHSA-5v2h-r2cx-5xgj summary",
      severity: "HIGH",
      affected_ranges: [">=0 <4.0.10"],
      fixed_in: ["4.0.10"],
      affects_version: false,
      affects_installed_versions: ["4.0.9"],
    });
  });

  it("splits several intervals and handles last_affected and open ranges", () => {
    const advisory = toAdvisory(
      record(
        "GHSA-multi",
        [
          npmRange("pkg", [
            { introduced: "1.0.0" },
            { fixed: "1.4.2" },
            { introduced: "2.0.0" },
            { last_affected: "2.3.0" },
            { introduced: "3.0.0-beta.1" },
          ]),
        ],
        null,
      ),
      "pkg",
      "2.3.0",
      [],
    );
    expect(advisory.severity).toBeNull();
    expect(advisory.affected_ranges).toEqual([
      ">=1.0.0 <1.4.2",
      ">=2.0.0 <=2.3.0",
      ">=3.0.0-beta.1",
    ]);
    expect(advisory.fixed_in).toEqual(["1.4.2"]);
    expect(advisory.affects_version).toBe(true);
    expect(advisory.affects_installed_versions).toEqual([]);

    const prerelease = toAdvisory(
      record("GHSA-open", [
        npmRange("pkg", [
          { introduced: "1.0.0" },
          { fixed: "1.4.2" },
          { introduced: "3.0.0-beta.1" },
        ]),
      ]),
      "pkg",
      "3.1.0-rc.0",
      ["1.4.2", "3.0.0"],
    );
    expect(prerelease.affects_version).toBe(true);
    expect(prerelease.affects_installed_versions).toEqual(["3.0.0"]);
  });

  it("only reads ranges for this package and falls back to explicit versions", () => {
    const advisory = toAdvisory(
      record("MAL-2025-1", [
        npmRange("other", [{ introduced: "0" }]),
        { package: { name: "pkg", ecosystem: "npm" }, versions: ["1.0.1", "1.0.2"] },
      ]),
      "pkg",
      "1.0.2",
      ["1.0.0", "1.0.1"],
    );
    expect(advisory.affected_ranges).toEqual(["=1.0.1", "=1.0.2"]);
    expect(advisory.affects_version).toBe(true);
    expect(advisory.affects_installed_versions).toEqual(["1.0.1"]);
  });
});

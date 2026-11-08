import { describe, expect, it } from "vitest";
import { BUNDLE_SKIPPED, kindsOf, structureProblems, unavailableProblems } from "../ci/contract.ts";
import type { PackageReport } from "../src/report.ts";
import { FIELD_DESCRIPTIONS } from "../src/schema-docs.ts";
import { browserProject, report, sonnerInBrowser, yupWithoutGithub, zod } from "./reports.ts";

// Live CLI output lists the skipped bundle outside a browser workspace; the fixtures omit it.
const skipped = (pkg: PackageReport) => ({
  ...pkg,
  unavailable: [...pkg.unavailable, BUNDLE_SKIPPED],
});
const fresh = () => structuredClone(report([skipped(zod)]));
const kinds = kindsOf(
  [report([zod]), report([sonnerInBrowser], browserProject)],
  FIELD_DESCRIPTIONS,
);
const structure = (value: unknown) => structureProblems(value, FIELD_DESCRIPTIONS, kinds);
const nulls = (value: unknown) => unavailableProblems(value, FIELD_DESCRIPTIONS);

describe("CI contract check (ci/e2e.ts)", () => {
  it("passes a complete report", () => {
    expect(structure(fresh())).toEqual([]);
    expect(nulls(fresh())).toEqual([]);
  });

  it("names a missing field", () => {
    const changed = fresh();
    const { new_install_bytes: _, ...cost } = changed.packages[0]?.cost ?? {};
    Object.assign(changed.packages[0] ?? {}, { cost });
    expect(structure(changed)).toEqual([
      "packages[0].cost: missing packages[].cost.new_install_bytes",
    ]);
  });

  it("names a field --schema does not document", () => {
    const changed = { ...fresh(), extra: 1 };
    expect(structure(changed)).toEqual(["report: extra is not documented in --schema"]);
  });

  it("names a value of the wrong kind", () => {
    const changed = fresh();
    Object.assign(changed.packages[0]?.maintenance ?? {}, { weekly_downloads: "many" });
    expect(structure(changed)).toEqual([
      "packages[0].maintenance.weekly_downloads is string, expected number",
    ]);
  });

  it("accepts null only where --schema allows it", () => {
    const changed = fresh();
    Object.assign(changed.packages[0]?.maintenance ?? {}, { weekly_downloads: null });
    expect(structure(changed)).toEqual([]);
    Object.assign(changed.packages[0] ?? {}, { requested: null, keywords: null });
    expect(structure(changed)).toEqual([
      "packages[0].requested is null, which --schema does not allow",
      "packages[0].keywords is null, which --schema does not allow",
    ]);
  });

  it("wants a null from a failed source listed in unavailable", () => {
    const changed = fresh();
    Object.assign(changed.packages[0]?.maintenance ?? {}, { weekly_downloads: null });
    expect(nulls(changed)).toEqual([
      "packages[0] (zod): weekly_downloads is null and no downloads entry",
    ]);
    expect(nulls(report([skipped(yupWithoutGithub)]))).toEqual([]);
  });

  it("wants GitHub fields null when github is listed", () => {
    const changed = fresh();
    changed.packages[0]?.unavailable.push("github: no token");
    expect(nulls(changed)).toEqual([
      "packages[0] (zod): github entry listed but archived, last_commit_at, commits_last_year set",
    ]);
  });

  it("wants bundle skipped and listed outside a browser workspace", () => {
    const changed = fresh();
    if (changed.packages[0]) changed.packages[0].unavailable = [];
    expect(nulls(changed)).toEqual([
      'packages[0] (zod): no "bundle: skipped, no browser signal in workspace" entry',
    ]);
  });
});

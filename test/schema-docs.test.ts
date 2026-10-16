import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/report.ts";
import { FIELD_DESCRIPTIONS, schemaDocument } from "../src/schema-docs.ts";
import {
  betterSqlite3,
  bunProject,
  missing,
  nodeProject,
  nodePty,
  nodePtyUnmeasurable,
  nodeSqlite,
  noProjectReport,
  report,
  sharp,
  sonner,
  sonnerBundled,
  valibot,
  workersProject,
  yup,
  yupWithoutGithub,
  zod,
  zodBundled,
} from "./reports.ts";

/** Objects whose keys are data (runtime names), not schema fields. */
const MAPS = new Set(["packages[].compatibility.engines"]);

type Paths = { all: Set<string>; leaves: Set<string> };

/**
 * Collects JSON paths with arrays collapsed to "[]". Arrays of primitives, empty arrays, null,
 * and maps are leaves; containers are recorded in `all` so their descriptions can be checked.
 */
function walk(value: unknown, path: string, paths: Paths): void {
  if (path) paths.all.add(path);
  if (Array.isArray(value)) {
    const objects = value.filter((item) => typeof item === "object" && item !== null);
    if (objects.length === 0) paths.leaves.add(path);
    for (const item of objects) walk(item, `${path}[]`, paths);
    return;
  }
  if (typeof value === "object" && value !== null && !MAPS.has(path)) {
    for (const [key, child] of Object.entries(value))
      walk(child, path ? `${path}.${key}` : key, paths);
    return;
  }
  paths.leaves.add(path);
}

const fixtures = [
  report([zod, valibot, yup, missing]),
  report([sharp, sonner, yupWithoutGithub], bunProject),
  report([nodeSqlite, betterSqlite3, nodePty], nodeProject),
  report([zod], workersProject),
  report([zodBundled, sonnerBundled, nodePtyUnmeasurable]),
  noProjectReport,
];

const paths: Paths = { all: new Set(), leaves: new Set() };
for (const fixture of fixtures) walk(fixture, "", paths);

describe("field descriptions", () => {
  it("cover every leaf of a full report", () => {
    const undocumented = [...paths.leaves].filter((path) => !(path in FIELD_DESCRIPTIONS));
    expect(undocumented).toEqual([]);
  });

  it("only describe paths that exist in a report", () => {
    const unknown = Object.keys(FIELD_DESCRIPTIONS).filter((path) => !paths.all.has(path));
    expect(unknown).toEqual([]);
  });

  it("describe every section that can be null", () => {
    for (const section of [
      "in_repo",
      "cost",
      "compatibility",
      "maintenance",
      "security",
      "bundle",
    ]) {
      expect(FIELD_DESCRIPTIONS[`packages[].${section}`]).toMatch(/null/);
    }
    expect(FIELD_DESCRIPTIONS.project).toMatch(/null/);
  });

  it("are single non-empty sentences", () => {
    for (const [path, text] of Object.entries(FIELD_DESCRIPTIONS)) {
      expect(text, path).toMatch(/^\S.*\.$/);
      expect(text, path).not.toMatch(/\.\s+[A-Z]/);
    }
  });

  it("name every bundle null code a reader can meet in unavailable", () => {
    for (const field of ["eager_js_min_bytes", "lazy_js_gzip9_bytes"]) {
      const text = FIELD_DESCRIPTIONS[`packages[].bundle.${field}`] ?? "";
      for (const code of [
        "UNRESOLVED_IMPORT",
        "MISSING_EXPORT",
        "IMPORT_OUTSIDE_BUNDLE",
        "NO_ENTRY",
        "NON_JS_IMPORT",
      ]) {
        expect(text, field).toContain(code);
      }
    }
  });

  it("ship with the schema version", () => {
    const doc = schemaDocument();
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(doc.fields).toBe(FIELD_DESCRIPTIONS);
  });
});

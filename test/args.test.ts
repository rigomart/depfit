import { describe, expect, it } from "vitest";
import { parseCliArgs, resolveOutput, USAGE, useColor } from "../src/args.ts";

describe("parseCliArgs", () => {
  it("collects package specs and options", () => {
    expect(parseCliArgs(["zod", "valibot@^1", "--cwd", "../app", "--json"])).toEqual({
      kind: "run",
      specs: ["zod", "valibot@^1"],
      cwd: "../app",
      output: "json",
    });
  });

  it("leaves the output mode to the terminal by default", () => {
    expect(parseCliArgs(["zod"])).toMatchObject({ kind: "run", cwd: null, output: "auto" });
    expect(parseCliArgs(["zod", "--table"])).toMatchObject({ output: "table" });
  });

  it("handles help and version before anything else", () => {
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["zod", "--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("prints the schema without needing packages", () => {
    expect(parseCliArgs(["--schema"])).toEqual({ kind: "schema" });
    expect(parseCliArgs(["zod", "--schema", "--json"])).toEqual({ kind: "schema" });
    expect(parseCliArgs(["--schema", "--help"])).toEqual({ kind: "help" });
  });

  it("mentions --schema in the help", () => {
    expect(USAGE).toMatch(/^ {2}--schema /m);
  });

  it("rejects bad usage", () => {
    expect(parseCliArgs([])).toEqual({ kind: "usage-error", message: "no packages given" });
    expect(parseCliArgs(["zod", "--json", "--table"])).toMatchObject({ kind: "usage-error" });
    expect(parseCliArgs(["zod", "--cwd"])).toMatchObject({ kind: "usage-error" });
    const unknown = parseCliArgs(["zod", "--frobnicate"]);
    expect(unknown).toMatchObject({ kind: "usage-error" });
    expect(unknown.kind === "usage-error" && unknown.message).toContain("--frobnicate");
  });
});

describe("resolveOutput", () => {
  it("prints JSON to pipes and the table to terminals unless forced", () => {
    expect(resolveOutput("auto", false)).toBe("json");
    expect(resolveOutput("auto", true)).toBe("table");
    expect(resolveOutput("table", false)).toBe("table");
    expect(resolveOutput("json", true)).toBe("json");
  });
});

describe("useColor", () => {
  it("colors only terminals without NO_COLOR", () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(false, {})).toBe(false);
    expect(useColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(useColor(true, { NO_COLOR: "" })).toBe(true);
  });
});

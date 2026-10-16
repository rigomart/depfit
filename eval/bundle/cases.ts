/**
 * Loads and validates eval/bundle/cases.json (format: eval/bundle/README.md), and holds what the
 * CLI-facing scripts share: the CLI path and how a case's imports become `--bundle-entry` args.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asArray, asRecord, asString, asStringArray } from "../../src/collect/util.ts";

export type Target = "browser" | "workerd";

/** One `import` statement; `members` are `<binding>.<prop>` accesses kept alive instead of the binding. */
export type ImportStatement = {
  from: string;
  named: string[];
  default: boolean;
  namespace: boolean;
  members: string[];
};

export type Step = "1" | "workers" | "non-js";

export type Case = {
  id: string;
  package: string;
  version: string;
  imports: ImportStatement[];
  target: Target;
  /** Which feature step scores the case; "1" is browser, JS only. */
  step: Step;
  expect: "measure" | "null";
  /** Error code depfit must put in `unavailable` (`bundle: <code>`); only for expect "null". */
  code: string | null;
  /** Specifier that must follow the code in that entry, when the case pins one. */
  specifier: string | null;
  /** Must be in band (or return `code`); it cannot be one of the tolerated misses. */
  mandatory: boolean;
  reason: string | null;
};

/** DEPFIT_CLI points the harness at another build of the CLI. */
export const CLI = process.env.DEPFIT_CLI ?? join(import.meta.dirname, "../../src/cli.ts");

/** The cases whose full `--json` output gate H0 (comprehension.ts) shows to a blind reader. */
export const COMPREHENSION_CASES = [
  "sonner-named",
  "shiki-codeToHtml",
  "node-pty-named",
  "simple-git-default",
];

const CASES_FILE = join(import.meta.dirname, "cases.json");
export const WILD_FILE = join(import.meta.dirname, "wild.json");

function parseStatement(value: unknown, caseId: string): ImportStatement {
  const raw = asRecord(value);
  const from = asString(raw.from);
  if (!from) throw new Error(`${caseId}: import without "from"`);
  return {
    from,
    named: asStringArray(raw.named),
    default: raw.default === true,
    namespace: raw.namespace === true,
    members: asStringArray(raw.members),
  };
}

function parseCase(value: unknown): Case {
  const raw = asRecord(value);
  const id = asString(raw.id) ?? "?";
  const pkg = asString(raw.package);
  const version = asString(raw.version);
  const { target, expect } = raw;
  if (!pkg || !version) throw new Error(`${id}: package and version are required`);
  if (target !== "browser" && target !== "workerd") throw new Error(`${id}: bad target`);
  if (expect !== "measure" && expect !== "null") throw new Error(`${id}: bad expect`);
  const imports = asArray(raw.imports).map((entry) => parseStatement(entry, id));
  if (!imports.length) throw new Error(`${id}: imports is empty`);
  const step = raw.step ?? "1";
  if (step !== "1" && step !== "workers" && step !== "non-js") throw new Error(`${id}: bad step`);
  const code = asString(raw.code);
  if (expect === "null" && !code) throw new Error(`${id}: null cases need a code`);
  return {
    id,
    package: pkg,
    version,
    imports,
    target,
    step,
    expect,
    code,
    specifier: asString(raw.specifier),
    mandatory: raw.mandatory === true,
    reason: asString(raw.reason),
  };
}

/** All cases, or only the given ids (an unknown id is an error). */
export async function loadCases(only: string[] = []): Promise<Case[]> {
  const parsed: unknown = JSON.parse(await readFile(CASES_FILE, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("cases.json must be an array");
  const cases = parsed.map(parseCase);
  const unknown = only.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown case id: ${unknown.join(", ")}`);
  return only.length ? cases.filter((c) => only.includes(c.id)) : cases;
}

/**
 * The JS a snippet is made of. `declarations` are import statements. `members` are
 * `binding.prop` expressions to keep alive; every other imported binding is kept whole, and a
 * binding with members is kept only through them.
 */
export function snippetParts(imports: ImportStatement[]): {
  declarations: string[];
  members: string[];
  wholeBindings: string[];
} {
  const declarations: string[] = [];
  const members: string[] = [];
  const wholeBindings: string[] = [];
  imports.forEach((statement, index) => {
    const bindings: string[] = [];
    const clauses: string[] = [];
    if (statement.default) {
      bindings.push(`def${index}`);
      clauses.push(`def${index}`);
    }
    if (statement.namespace) {
      bindings.push(`ns${index}`);
      clauses.push(`* as ns${index}`);
    }
    if (statement.named.length) clauses.push(`{ ${statement.named.join(", ")} }`);
    const from = JSON.stringify(statement.from);
    declarations.push(
      clauses.length ? `import ${clauses.join(", ")} from ${from};` : `import ${from};`,
    );

    // Members name their binding as `default`, `*` or the imported name.
    const alias = new Map([
      ["default", `def${index}`],
      ["*", `ns${index}`],
    ]);
    const used = new Set<string>();
    for (const member of statement.members) {
      const dot = member.indexOf(".");
      const key = member.slice(0, dot);
      const binding = alias.get(key) ?? (statement.named.includes(key) ? key : undefined);
      if (dot < 0 || !binding) throw new Error(`member ${member} matches no binding of ${from}`);
      used.add(binding);
      members.push(`${binding}${member.slice(dot)}`);
    }
    wholeBindings.push(...[...bindings, ...statement.named].filter((b) => !used.has(b)));
  });
  return { declarations, members, wholeBindings };
}

/**
 * The one place that turns a case's imports into `--bundle-entry` arguments: a single snippet for
 * the candidate (SPEC: one snippet per candidate), imports first, then the member statements.
 */
export function entryArgs(imports: ImportStatement[]): string[] {
  const { declarations, members } = snippetParts(imports);
  return ["--bundle-entry", [...declarations, ...members.map((member) => `${member};`)].join(" ")];
}

/** One package of the wild corpus (wild.json, rule in README.md "Gate W"). */
export type WildPackage = { name: string; version: string; downloads_last_month: number };

/** File-name-safe id of a wild package: `@scope/name` becomes `scope__name`. */
export const wildId = (name: string) => name.replace(/^@/, "").replace("/", "__");

export async function loadWildPackages(): Promise<WildPackage[]> {
  const parsed = asRecord(JSON.parse(await readFile(WILD_FILE, "utf8")));
  return asArray(parsed.packages).map((value) => {
    const raw = asRecord(value);
    const name = asString(raw.name);
    const version = asString(raw.version);
    const downloads = typeof raw.downloads_last_month === "number" ? raw.downloads_last_month : 0;
    if (!name || !version) throw new Error("wild.json: package without name or version");
    return { name, version, downloads_last_month: downloads };
  });
}

/** The wild corpus as cases: `import * as m from "<name>"`, namespace kept whole, browser target. */
export async function loadWild(): Promise<Case[]> {
  return (await loadWildPackages()).map((pkg) => ({
    id: wildId(pkg.name),
    package: pkg.name,
    version: pkg.version,
    imports: [{ from: pkg.name, named: [], default: false, namespace: true, members: [] }],
    target: "browser",
    step: "1",
    expect: "measure",
    code: null,
    specifier: null,
    mandatory: false,
    reason: null,
  }));
}

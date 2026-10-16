/**
 * `--bundle-entry` snippets: validation, the normalized form shown in the report, and the entry
 * module that is bundled. A snippet may only hold import declarations from one candidate (or its
 * subpaths) and bare member-expression statements on the imported bindings, e.g.
 * `import { z } from "zod"; z.object; z.string`.
 */
import type { ESTree } from "rolldown/utils";

export type ImportClause =
  | { kind: "default"; local: string }
  | { kind: "namespace"; local: string }
  | { kind: "named"; imported: string; local: string };

export type SnippetImport = { source: string; clauses: ImportClause[] };

export type BundleEntry = {
  /** npm name of the candidate every import comes from. */
  candidate: string;
  imports: SnippetImport[];
  /** Member accesses to keep alive, e.g. "z.object"; each starts with an imported binding. */
  members: string[];
};

export type Validated = { ok: true; entry: BundleEntry } | { ok: false; message: string };

/** The import source belongs to `name`: the package itself or one of its subpaths. */
export function isCandidateSource(source: string, name: string): boolean {
  return source === name || source.startsWith(`${name}/`);
}

/**
 * A subpath segment that could leave the package or name another one: empty, `.`, `..`,
 * `node_modules`, or one holding a backslash, `%` (encoded characters), `?`, `#`, or a control
 * character.
 */
function isUnsafeSegment(segment: string): boolean {
  if (["", ".", "..", "node_modules"].includes(segment)) return true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected.
  return /[\\%?#\u0000-\u001f]/.test(segment);
}

/** The `globalThis` property the generated entry stores kept values in; prefix of its locals. */
const KEEP_ALIVE = "__depfit";
/** Local name of the i-th imported binding in the generated entry module. */
const generatedLocal = (index: number) => `${KEEP_ALIVE}_${index}`;

function exportName(name: ESTree.ModuleExportName): string {
  return name.type === "Literal" ? name.value : name.name;
}

function clauseOf(specifier: ESTree.ImportDeclarationSpecifier): ImportClause {
  switch (specifier.type) {
    case "ImportDefaultSpecifier":
      return { kind: "default", local: specifier.local.name };
    case "ImportNamespaceSpecifier":
      return { kind: "namespace", local: specifier.local.name };
    case "ImportSpecifier":
      return {
        kind: "named",
        imported: exportName(specifier.imported),
        local: specifier.local.name,
      };
  }
}

/** "z.object.shape" for a chain of plain `.name` accesses on an identifier, else null. */
function memberPath(expression: ESTree.Expression): string | null {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type !== "MemberExpression" || expression.computed || expression.optional) {
    return null;
  }
  if (expression.property.type !== "Identifier") return null;
  const object = memberPath(expression.object);
  return object === null ? null : `${object}.${expression.property.name}`;
}

/**
 * Checks a parsed snippet against the candidates' npm names. Returns the entry, or a usage error
 * message naming what is not allowed.
 */
export function validateSnippet(
  program: ESTree.Program,
  source: string,
  candidates: string[],
): Validated {
  const fail = (message: string): Validated => ({ ok: false, message });
  const quoted = (node: { start: number; end: number }) =>
    `\`${source.slice(node.start, node.end).trim()}\``;
  const imports: SnippetImport[] = [];
  const statements: Array<ESTree.ExpressionStatement | ESTree.Directive> = [];
  const used = new Set<string>();

  for (const statement of program.body) {
    if (statement.type === "EmptyStatement") continue;
    if (statement.type === "ExpressionStatement") {
      statements.push(statement);
      continue;
    }
    if (statement.type !== "ImportDeclaration") {
      return fail(
        `--bundle-entry allows only import declarations and member statements like \`z.object;\`, not ${quoted(statement)}`,
      );
    }
    if (statement.phase !== null || statement.attributes.length > 0) {
      return fail(
        `--bundle-entry does not support import phases or attributes: ${quoted(statement)}`,
      );
    }
    const from = statement.source.value;
    const candidate = candidates.find((name) => isCandidateSource(from, name));
    if (candidate === undefined) {
      return fail(
        `--bundle-entry imports "${from}", which is not a candidate or a subpath of one (candidates: ${candidates.join(", ") || "none"})`,
      );
    }
    const subpath = from.slice(candidate.length);
    if (subpath !== "" && subpath.slice(1).split("/").some(isUnsafeSegment)) {
      return fail(
        `--bundle-entry imports "${from}"; a subpath may not have empty, ".", "..", or "node_modules" segments, or contain \\, %, ?, or #`,
      );
    }
    used.add(candidate);
    imports.push({ source: from, clauses: statement.specifiers.map(clauseOf) });
  }

  const [candidate, ...others] = [...used];
  if (candidate === undefined) return fail("--bundle-entry has no import declaration");
  if (others.length > 0) {
    return fail(
      `--bundle-entry imports more than one candidate (${[...used].join(", ")}); give one snippet per candidate`,
    );
  }

  const locals = imports.flatMap((i) => i.clauses.map((clause) => clause.local));
  const bindings = new Set(locals);
  const twice = locals.find((local, index) => locals.indexOf(local) !== index);
  if (twice !== undefined) return fail(`--bundle-entry binds \`${twice}\` more than once`);
  const members: string[] = [];
  for (const statement of statements) {
    const path = memberPath(statement.expression);
    if (path === null || !path.includes(".")) {
      return fail(
        `--bundle-entry allows only plain member statements like \`z.object;\` after the imports, not ${quoted(statement)}`,
      );
    }
    const root = path.slice(0, path.indexOf("."));
    if (!bindings.has(root)) {
      return fail(`--bundle-entry: ${quoted(statement)} does not start with an imported binding`);
    }
    if (!members.includes(path)) members.push(path);
  }
  return { ok: true, entry: { candidate, imports, members } };
}

function renderClause(clause: ImportClause): string {
  if (clause.kind === "default") return clause.local;
  if (clause.kind === "namespace") return `* as ${clause.local}`;
  const imported = /^[A-Za-z_$][\w$]*$/.test(clause.imported)
    ? clause.imported
    : JSON.stringify(clause.imported);
  return imported === clause.local ? imported : `${imported} as ${clause.local}`;
}

function renderImport({ source, clauses }: SnippetImport): string {
  const from = JSON.stringify(source);
  if (clauses.length === 0) return `import ${from};`;
  const head = clauses.filter((clause) => clause.kind !== "named").map(renderClause);
  const named = clauses.filter((clause) => clause.kind === "named").map(renderClause);
  const parts = [...head, ...(named.length ? [`{ ${named.join(", ")} }`] : [])];
  return `import ${parts.join(", ")} from ${from};`;
}

/** The snippet in one canonical form, e.g. `import { z } from "zod"; z.object; z.string;`. */
export function normalizedSnippet(entry: BundleEntry): string {
  return [...entry.imports.map(renderImport), ...entry.members.map((m) => `${m};`)].join(" ");
}

/**
 * Bindings and members the bundle must keep: a binding with member statements is kept only
 * through them; every other binding is kept whole. Side-effect imports keep nothing extra.
 */
export function keptValues(entry: BundleEntry): string[] {
  const viaMembers = new Set(entry.members.map((m) => m.slice(0, m.indexOf("."))));
  const whole = entry.imports
    .flatMap((i) => i.clauses.map((clause) => clause.local))
    .filter((local) => !viaMembers.has(local));
  return [...whole, ...entry.members];
}

/**
 * Source of the module that is bundled: the imports, then one assignment to
 * `globalThis.__depfit` that keeps values live. Imported bindings get generated names, so a
 * snippet binding such as `globalThis` cannot shadow the global the assignment uses.
 */
export function entryModuleSource(entry: BundleEntry): string {
  const locals = new Map<string, string>();
  const rename = (local: string) => {
    const name = locals.get(local) ?? generatedLocal(locals.size);
    locals.set(local, name);
    return name;
  };
  const imports = entry.imports.map(({ source, clauses }) =>
    renderImport({ source, clauses: clauses.map((c) => ({ ...c, local: rename(c.local) })) }),
  );
  const kept = keptValues(entry).map((value) => {
    const dot = value.indexOf(".");
    return dot < 0 ? rename(value) : `${rename(value.slice(0, dot))}${value.slice(dot)}`;
  });
  const keep = kept.length ? [`globalThis.${KEEP_ALIVE} = [${kept.join(", ")}];`] : [];
  return `${[...imports, ...keep].join("\n")}\n`;
}

/** Parses a snippet; throws with the parser's message on a syntax error. */
export type ParseSnippet = (source: string) => ESTree.Program;

/**
 * Validates every snippet against the requested specs' npm names: one snippet per candidate.
 * Keys of the result are npm names.
 */
export function bundleEntries(
  snippets: string[],
  candidates: string[],
  parse: ParseSnippet,
): { ok: true; entries: Map<string, BundleEntry> } | { ok: false; message: string } {
  const entries = new Map<string, BundleEntry>();
  for (const snippet of snippets) {
    let program: ESTree.Program;
    try {
      program = parse(snippet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.split("\n").find((line) => line.trim() && !/^Parse failed/.test(line));
      return { ok: false, message: `--bundle-entry is not valid JS: ${detail?.trim() ?? message}` };
    }
    const validated = validateSnippet(program, snippet, candidates);
    if (!validated.ok) return validated;
    const { candidate } = validated.entry;
    if (entries.has(candidate)) {
      return {
        ok: false,
        message: `--bundle-entry was given twice for ${candidate}; give one snippet per candidate`,
      };
    }
    entries.set(candidate, validated.entry);
  }
  return { ok: true, entries };
}

/** Loads rolldown's parser (only when --bundle-entry is used) and validates the snippets. */
export async function prepareBundleEntries(snippets: string[], candidates: string[]) {
  const { parseAst } = await import("rolldown/parseAst");
  return bundleEntries(snippets, candidates, (source) =>
    parseAst(source, { lang: "js", sourceType: "module", preserveParens: false }),
  );
}

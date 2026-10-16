/**
 * The gate W auditor: finds hidden runtime loads in bundler output. It is deliberately independent
 * of depfit's detector (src/collect/bundle.ts walks rolldown's chunk graph with oxc; this imports
 * nothing from src/). `fetch` hits come from an acorn AST (webpack's parser, passed in), so a word
 * inside a string or comment is not a call; without a parse they fall back to text patterns.
 * `load` and `mention` hits are text patterns: they look for the spellings of a load.
 *
 * Three strengths, fixed here before any wild result was seen:
 * - `fetch`: code fetched from outside the bundle, which the emitted bytes understate: `import()`
 *   whose target is not an emitted chunk, `importScripts`. Gate W (i) counts only these.
 * - `load`: other ways to run code the bundle does not hold: `require(...)` in any form,
 *   `eval(...)`, `Function(...)`, `createRequire`, `dlopen`. Information only (SPEC: the number
 *   is emitted bytes, with no claim the code runs).
 * - `mention`: any other occurrence of the same words (`typeof require`, a property named
 *   `require`, `x instanceof Function`). Information only.
 */

import { posix } from "node:path";

export type Hit = {
  pattern: string;
  strength: "fetch" | "load" | "mention";
  snippet: string;
  /** Total occurrences of this pattern in the output (only the first snippet is kept). */
  count: number;
};

/** Identifier boundaries for minified code, where `$` and `_` are ordinary identifier characters. */
const B = "(?<![\\w$])";
const E = "(?![\\w$])";

const LOAD_PATTERNS: [string, RegExp][] = [
  ["require()", new RegExp(`${B}require\\s*\\)?\\s*\\(`, "g")],
  ["member.require()", /\.\s*require\s*[(`]/g],
  ["['require']", /\[\s*["'`]require["'`]\s*\]/g],
  ["__non_webpack_require__", new RegExp(`${B}__non_webpack_require__${E}`, "g")],
  ["createRequire", new RegExp(`${B}createRequire${E}`, "g")],
  ["dlopen", /dlopen/g],
  ["process.binding", /process\s*\.\s*binding\s*\(/g],
  ["eval()", new RegExp(`${B}eval\\s*\\)?\\s*\\(`, "g")],
  [".eval()", /\.\s*eval\s*\(/g],
  ["['eval']", /\[\s*["'`]eval["'`]\s*\]/g],
  ["Function()", new RegExp(`${B}Function\\s*\\)?\\s*\\(`, "g")],
  [".Function()", /\.\s*Function\s*\(/g],
  ["['Function']", /\[\s*["'`]Function["'`]\s*\]/g],
  [".constructor('return ...')", /\.\s*constructor\s*\(\s*["'`]\s*return\b/g],
  ["dynamic-require stub", /dynamic(?:ally)?\s+require/gi],
  ["MODULE_NOT_FOUND", /MODULE_NOT_FOUND/g],
];

const FETCH_PATTERNS: [string, RegExp][] = [
  // The call only: `"importScripts" in self` is an environment check, not a fetch.
  ["importScripts", new RegExp(`${B}importScripts\\s*\\(`, "g")],
  ["importScripts", /\[\s*["'`]importScripts["'`]\s*\]\s*\(/g],
];

/** Words that may appear without being a load. */
const MENTION_PATTERNS: [string, RegExp][] = [
  ["require", new RegExp(`${B}require${E}`, "g")],
  ["eval", new RegExp(`${B}eval${E}`, "g")],
  ["Function", new RegExp(`${B}Function${E}`, "g")],
];

/**
 * What webpack itself injects whenever a module reads `global`: not the package's code. The same
 * text written by a package would still show in the rollup output, which has no such helper.
 */
const WEBPACK_GLOBAL_HELPER = /try\{return this\|\|new Function\("return this"\)\(\)\}/g;

const IMPORT_CALL = new RegExp(`${B}import\\s*\\(`, "g");
/** A URL with a scheme, or protocol-relative: never webpack's own (relative) chunk directory. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const CONTEXT = 40;

/** Parses a chunk as an ES module (acorn's `parse` in practice); throws on a syntax error. */
export type ParseModule = (code: string) => unknown;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string" &&
  "start" in value &&
  typeof value.start === "number";

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value])
      if (isNode(child)) walk(child, visit);
  }
}

/** A string literal, or a template literal without expressions, as its value. */
function literalValue(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.expressions)) return null;
  if (node.expressions.length || !Array.isArray(node.quasis)) return null;
  const quasi: unknown = node.quasis[0];
  if (!isNode(quasi) || typeof quasi.value !== "object" || quasi.value === null) return null;
  return "cooked" in quasi.value && typeof quasi.value.cooked === "string"
    ? quasi.value.cooked
    : null;
}

/** An `import()` call site: its literal target (or null), where it starts, and its argument. */
type ImportSite = { literal: string | null; at: number; source: number; webpackLoader: boolean };

/** The name a member expression reads, `x.name` or `x["name"]`, or null when computed otherwise. */
function memberName(node: Node): string | null {
  if (node.type !== "MemberExpression" || !isNode(node.property)) return null;
  if (!node.computed) return typeof node.property.name === "string" ? node.property.name : null;
  return literalValue(node.property);
}

/**
 * webpack's ESM chunk loader: `"<dir>" + ... + r.u(id)`, a string concatenation that starts with a
 * relative literal and ends in a call to `r.u()`, where the chunk assigns `r.u` a function whose
 * every string literal is part of an emitted chunk's file name (webpack's chunk-filename function,
 * `e => e + ".js"`). `chunkFilenameOwners` are those binding names. Bindings are matched by name,
 * not scope: a function parameter shadowing `r` is not told apart (a known limit).
 */
function isWebpackChunkLoader(source: Node, chunkFilenameOwners: Set<string>): boolean {
  // Exactly `"<relative dir>" + r.u(id)`, the form webpack emits for these builds.
  if (source.type !== "BinaryExpression" || source.operator !== "+") return false;
  const last = source.right;
  if (!isNode(last) || last.type !== "CallExpression" || !isNode(last.callee)) return false;
  const callee = last.callee;
  if (memberName(callee) !== "u" || !isNode(callee.object)) return false;
  const owner = callee.object.type === "Identifier" ? callee.object.name : null;
  if (typeof owner !== "string" || !chunkFilenameOwners.has(owner)) return false;
  // The chunk id, not a file name passed in.
  const [argument] = Array.isArray(last.arguments) ? last.arguments : [];
  if (literalValue(argument) !== null) return false;
  const prefix = literalValue(source.left);
  return prefix !== null && !REMOTE.test(prefix);
}

/**
 * `import()` calls and `importScripts(...)` calls (also `self.importScripts`, `self["importScripts"]`)
 * in the AST, or null when the chunk does not parse.
 */
function fetchSites(
  code: string,
  parse: ParseModule,
  chunkNames: Set<string>,
): { imports: ImportSite[]; scripts: number[] } | null {
  let program: unknown;
  try {
    program = parse(code);
  } catch {
    return null;
  }
  if (!isNode(program)) return null;
  const scripts: number[] = [];
  const importNodes: Node[] = [];
  // Bindings `r` with `r.u = function` / `r.u = () => ...` that build emitted file names only.
  const chunkFilenameOwners = new Set<string>();
  const fileNames = [...chunkNames].map((name) => name.replace(/^.*\//, ""));
  const buildsChunkNames = (fn: Node) => {
    const literals: string[] = [];
    walk(fn, (inner) => {
      const value = literalValue(inner);
      if (value) literals.push(value);
    });
    return (
      literals.length > 0 &&
      literals.every(
        (value) => !REMOTE.test(value) && fileNames.some((file) => file.includes(value)),
      )
    );
  };
  // An owner assigned `.u` more than once is not trusted: the loader may call either.
  const assignments = new Map<string, number>();
  walk(program, (node) => {
    if (node.type === "ImportExpression" && isNode(node.source)) {
      importNodes.push(node);
    } else if (node.type === "CallExpression" && isNode(node.callee)) {
      const callee = node.callee;
      const name = callee.type === "Identifier" ? callee.name : memberName(callee);
      if (name === "importScripts") scripts.push(node.start);
    } else if (node.type === "AssignmentExpression" && isNode(node.left) && isNode(node.right)) {
      const target = node.left;
      const isFunction =
        node.right.type === "FunctionExpression" || node.right.type === "ArrowFunctionExpression";
      if (isFunction && memberName(target) === "u" && isNode(target.object)) {
        const owner = target.object.type === "Identifier" ? target.object.name : null;
        if (typeof owner === "string") {
          assignments.set(owner, (assignments.get(owner) ?? 0) + 1);
          if (buildsChunkNames(node.right)) chunkFilenameOwners.add(owner);
        }
      }
    }
  });
  for (const [owner, count] of assignments) if (count > 1) chunkFilenameOwners.delete(owner);
  const imports = importNodes.flatMap((node): ImportSite[] =>
    isNode(node.source)
      ? [
          {
            literal: literalValue(node.source),
            at: node.start,
            source: node.source.start,
            webpackLoader: isWebpackChunkLoader(node.source, chunkFilenameOwners),
          },
        ]
      : [],
  );
  return { imports, scripts };
}

function snippetAt(code: string, index: number, length: number): string {
  const from = Math.max(0, index - CONTEXT);
  const text = code.slice(from, index + length + CONTEXT).replace(/\s+/g, " ");
  return `${from > 0 ? "…" : ""}${text}…`;
}

function collect(
  code: string,
  patterns: [string, RegExp][],
  strength: Hit["strength"],
  taken: Array<[number, number]> = [],
): Hit[] {
  const hits: Hit[] = [];
  for (const [pattern, re] of patterns) {
    const found = [...code.matchAll(re)].filter((match) => {
      const start = match.index ?? 0;
      return !taken.some(([from, to]) => start >= from && start < to);
    });
    if (!found.length) continue;
    const first = found[0];
    hits.push({
      pattern,
      strength,
      snippet: first ? snippetAt(code, first.index ?? 0, first[0].length) : "",
      count: found.length,
    });
    for (const match of found) taken.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  return hits;
}

/** The literal first argument of an `import(` starting at `from`, or the raw text up to 60 chars. */
function importTarget(code: string, from: number): { literal: string | null; raw: string } {
  const rest = code.slice(from, from + 120);
  const literal = /^\s*(["'`])((?:(?!\1).)*)\1\s*\)/.exec(rest);
  return { literal: literal?.[2] ?? null, raw: rest.slice(0, 60) };
}

/** `import()` sites by text: the fallback when a chunk does not parse. */
function textImportSites(code: string): ImportSite[] {
  return [...code.matchAll(IMPORT_CALL)].map((match) => {
    const at = match.index ?? 0;
    const source = at + match[0].length;
    const { literal } = importTarget(code, source);
    // Without a parse there is no way to tie a loader to its filename function: no exemption.
    return { literal, at, source, webpackLoader: false };
  });
}

/**
 * Is a literal `import()` target one of the build's own chunks? Only a relative path counts, resolved
 * against the importing chunk's path: a URL or absolute path is never a chunk, whatever its name.
 */
function isOwnChunk(literal: string, importer: string, chunkNames: Set<string>): boolean {
  if (!literal.startsWith("./") && !literal.startsWith("../")) return false;
  return chunkNames.has(posix.normalize(posix.join(posix.dirname(importer), literal)));
}

function importHits(
  code: string,
  sites: ImportSite[],
  importer: string,
  chunkNames: Set<string>,
  externals: string[],
): Hit[] {
  const outside: { snippet: string }[] = [];
  for (const { literal, at, source, webpackLoader } of sites) {
    if (literal !== null && isOwnChunk(literal, importer, chunkNames)) continue;
    // A peer the build left external is the importer's own dependency, not a fetch.
    if (literal !== null && externals.some((n) => literal === n || literal.startsWith(`${n}/`)))
      continue;
    if (webpackLoader) continue;
    outside.push({ snippet: snippetAt(code, at, source - at + 40) });
  }
  const first = outside[0];
  return first
    ? [
        {
          pattern: "import() to a non-chunk target",
          strength: "fetch",
          snippet: first.snippet,
          count: outside.length,
        },
      ]
    : [];
}

/**
 * Hits for one emitted chunk, named `name` (its path in the output). `chunkNames` are the paths of
 * every chunk of the same build, so `import("./chunk-x.js")` is recognised as the bundler's own
 * split point. Without `parse`, or when the chunk does not parse, `fetch` hits come from text.
 */
export function auditChunk(
  code: string,
  name: string,
  chunkNames: string[],
  externals: string[] = [],
  parse?: ParseModule,
): Hit[] {
  const chunks = new Set(chunkNames.map((chunk) => posix.normalize(chunk)));
  const masked = code.replace(WEBPACK_GLOBAL_HELPER, "");
  const taken: Array<[number, number]> = [];
  const parsed = parse ? fetchSites(code, parse, chunks) : null;
  const fetches = parsed
    ? parsed.scripts.length
      ? [
          {
            pattern: "importScripts",
            strength: "fetch" as const,
            snippet: snippetAt(code, parsed.scripts[0] ?? 0, "importScripts(".length),
            count: parsed.scripts.length,
          },
        ]
      : []
    : collect(masked, FETCH_PATTERNS, "fetch", taken);
  const imports = importHits(
    parsed ? code : masked,
    parsed ? parsed.imports : textImportSites(masked),
    name,
    chunks,
    externals,
  );
  const loads = collect(masked, LOAD_PATTERNS, "load", taken);
  const mentions = collect(masked, MENTION_PATTERNS, "mention", taken);
  return [...fetches, ...imports, ...loads, ...mentions];
}

/** Merge the hits of several chunks: counts add up, the first snippet stays. */
export function auditBuild(
  chunks: { name: string; code: string }[],
  externals: string[] = [],
  parse?: ParseModule,
): Hit[] {
  const names = chunks.map((chunk) => chunk.name);
  const merged = new Map<string, Hit>();
  for (const chunk of chunks) {
    for (const hit of auditChunk(chunk.code, chunk.name, names, externals, parse)) {
      const key = `${hit.strength}:${hit.pattern}`;
      const previous = merged.get(key);
      if (previous) previous.count += hit.count;
      else merged.set(key, { ...hit });
    }
  }
  return [...merged.values()].sort(
    (a, b) => a.strength.localeCompare(b.strength) || a.pattern.localeCompare(b.pattern),
  );
}

export const hasFetch = (hits: Hit[]) => hits.some((hit) => hit.strength === "fetch");

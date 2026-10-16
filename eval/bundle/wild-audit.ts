/**
 * The gate W auditor: finds hidden runtime loads in bundler output by text patterns. It is
 * deliberately independent of depfit's detector (src/collect/bundle.ts parses and resolves scopes;
 * this does not, and imports nothing from src/). Where depfit reasons about bindings, this looks
 * for the spellings of a load, so a mistake in one is unlikely to be the same mistake in the other.
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
/** webpack's chunk loader for ESM output: `import("./"+chunkFileName)`. */
const WEBPACK_CHUNK_LOADER = /^\s*["']\.\/["']\s*\+/;

const CONTEXT = 40;

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

function importHits(code: string, chunkNames: string[], externals: string[]): Hit[] {
  const outside: { snippet: string }[] = [];
  const known = new Set(chunkNames.map((name) => name.replace(/^.*\//, "")));
  for (const match of code.matchAll(IMPORT_CALL)) {
    const end = (match.index ?? 0) + match[0].length;
    const { literal, raw } = importTarget(code, end);
    if (literal !== null && known.has(literal.replace(/^.*\//, ""))) continue;
    // A peer the build left external is the importer's own dependency, not a fetch.
    if (literal !== null && externals.some((n) => literal === n || literal.startsWith(`${n}/`)))
      continue;
    if (literal === null && WEBPACK_CHUNK_LOADER.test(raw)) continue;
    outside.push({ snippet: snippetAt(code, match.index ?? 0, match[0].length + 40) });
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
 * Hits for one emitted chunk. `chunkNames` are the file names of every chunk of the same build,
 * so `import("./chunk-x.js")` is recognised as the bundler's own split point.
 */
export function auditChunk(code: string, chunkNames: string[], externals: string[] = []): Hit[] {
  const masked = code.replace(WEBPACK_GLOBAL_HELPER, "");
  const taken: Array<[number, number]> = [];
  const fetches = collect(masked, FETCH_PATTERNS, "fetch", taken);
  const loads = collect(masked, LOAD_PATTERNS, "load", taken);
  const mentions = collect(masked, MENTION_PATTERNS, "mention", taken);
  return [...fetches, ...importHits(masked, chunkNames, externals), ...loads, ...mentions];
}

/** Merge the hits of several chunks: counts add up, the first snippet stays. */
export function auditBuild(
  chunks: { name: string; code: string }[],
  externals: string[] = [],
): Hit[] {
  const names = chunks.map((chunk) => chunk.name);
  const merged = new Map<string, Hit>();
  for (const chunk of chunks) {
    for (const hit of auditChunk(chunk.code, names, externals)) {
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

import { byCodePoint } from "../../src/collect/subpaths.ts";
import { asStringArray } from "../../src/collect/util.ts";

/** A % that does not start one of the escapes `reasonText` writes (%25, %3B, %5B). */
const UNESCAPED_PERCENT = /%(?!25|3B|5B)/;

export type Group = { code: string; keys: string[] };
export type ParsedReason = { free: string; groups: Group[]; errors: string[] };

/**
 * One `bundle:` entry under SPEC.md's framing rule (iteration 2): free text, with `%`, `;` and `[`
 * percent-encoded, then groups `<CODE> in subpaths <JSON array>`, either as the whole entry or
 * appended after `; `. Each array is parsed as JSON from its `[` to the matching `]`, respecting
 * strings and escapes, and scanning resumes after it. `errors` lists every break of the rule:
 * unencoded framing characters, an unterminated or invalid array, non-string keys, keys or codes
 * out of code-point order, and text after a group.
 */
export function parseReason(entry: string): ParsedReason {
  const errors: string[] = [];
  const groups: Group[] = [];
  const own = /^bundle: (?=[A-Z][A-Z_]* in subpaths \[)/.exec(entry);
  let at: number;
  let free: string;
  if (own) {
    free = "";
    at = own[0].length;
  } else {
    const split = entry.indexOf("; ");
    free = split < 0 ? entry : entry.slice(0, split);
    at = split < 0 ? entry.length : split + 2;
    if (split >= 0 && at >= entry.length) errors.push("a separator with no group after it");
  }
  if (/[;[]/.test(free)) errors.push(`unencoded ; or [ in "${free}"`);
  if (UNESCAPED_PERCENT.test(free)) errors.push(`unencoded % in "${free}"`);
  const ownCodes = new Set<string>();
  const leading = /^bundle: ([A-Z][A-Z_]*)\b/.exec(free)?.[1];
  if (leading) ownCodes.add(leading);
  const summary = /^bundle: \d+ exports unmeasurable \(([^)]*)\)/.exec(free)?.[1];
  for (const code of summary?.split(", ") ?? []) ownCodes.add(code);
  while (at < entry.length) {
    const head = /^([A-Z][A-Z_]*) in subpaths \[/.exec(entry.slice(at));
    if (!head) {
      errors.push(`no group at "${entry.slice(at, at + 40)}"`);
      break;
    }
    const start = at + head[0].length - 1;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < entry.length; i++) {
      const char = entry[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "[") depth++;
      else if (char === "]" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) {
      errors.push(`unterminated array for ${head[1]}`);
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.slice(start, end + 1));
    } catch {
      errors.push(`invalid JSON array for ${head[1]}`);
      break;
    }
    const keys = Array.isArray(parsed) ? parsed : [];
    if (!Array.isArray(parsed) || !keys.every((key) => typeof key === "string")) {
      errors.push(`non-string keys for ${head[1]}`);
    }
    const strings = asStringArray(keys);
    const sorted = [...new Set(strings)].sort(byCodePoint);
    if (JSON.stringify(sorted) !== JSON.stringify(strings)) {
      errors.push(`keys of ${head[1]} not unique and in code-point order`);
    }
    const previous = groups.at(-1);
    if (previous && byCodePoint(previous.code, head[1] ?? "") >= 0) {
      errors.push(`group ${head[1]} out of code-point order`);
    }
    if (!own && !ownCodes.has(head[1] ?? "")) {
      errors.push(`group ${head[1]} appended to an entry that does not report that code`);
    }
    groups.push({ code: head[1] ?? "", keys: strings });
    at = end + 1;
    if (at < entry.length) {
      if (!entry.startsWith("; ", at)) {
        errors.push(`text after the ${head[1]} group`);
        break;
      }
      at += 2;
      if (at >= entry.length) errors.push("a separator with no group after it");
    }
  }
  return { free, groups, errors };
}

/**
 * Reviewed exceptions (exceptions.json, SPEC "Reviewed exceptions"): a size discrepancy between
 * depfit and the references that was explained in writing and reviewed. It waives that case's
 * gross error (gates A and W) and out-of-band result (gate B) only while everything it was reviewed
 * on is unchanged: package version, snippet, frozen lock, toolchain, depfit's four byte fields and
 * both references' four byte fields. It never waives an expected null code or an honesty check.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asNumber, asRecord, asString } from "../../src/collect/util.ts";
import { BYTE_FIELDS, type ByteField } from "./harness.ts";

const HERE = import.meta.dirname;

export type ExceptionSet = "corpus" | "wild";

type Bytes = Record<ByteField, number | null>;

export type ReviewedException = {
  set: ExceptionSet;
  id: string;
  version: string;
  entry: string;
  lock_sha256: string;
  bundler: string;
  bytes: Bytes;
  rollup: Bytes;
  webpack: Bytes;
  cause: string;
};

const bytesOf = (value: unknown): Bytes => {
  const raw = asRecord(value);
  return {
    min_bytes: asNumber(raw.min_bytes),
    gzip_bytes: asNumber(raw.gzip_bytes),
    lazy_min_bytes: asNumber(raw.lazy_min_bytes),
    lazy_gzip_bytes: asNumber(raw.lazy_gzip_bytes),
  };
};

export async function loadExceptions(): Promise<ReviewedException[]> {
  const raw = asRecord(JSON.parse(await readFile(join(HERE, "exceptions.json"), "utf8")));
  const items: unknown[] = Array.isArray(raw.exceptions) ? raw.exceptions : [];
  return items.map((item) => {
    const entry = asRecord(item);
    return {
      set: entry.set === "wild" ? "wild" : "corpus",
      id: asString(entry.id) ?? "",
      version: asString(entry.version) ?? "",
      entry: asString(entry.entry) ?? "",
      lock_sha256: asString(entry.lock_sha256) ?? "",
      bundler: asString(entry.bundler) ?? "",
      bytes: bytesOf(entry.bytes),
      rollup: bytesOf(entry.rollup),
      webpack: bytesOf(entry.webpack),
      cause: asString(entry.cause) ?? "",
    };
  });
}

/** sha256 of the frozen lock a case is built from (locks/<id>.json or locks/wild/<id>.json). */
export async function lockSha256(set: ExceptionSet, id: string): Promise<string> {
  const path = join(HERE, "locks", ...(set === "wild" ? ["wild"] : []), `${id}.json`);
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export type Observed = {
  version: string;
  entry: string;
  lock: string;
  bundler: string;
  bytes: Bytes;
  /** The case's entry in reference.json or wild-reference.json. */
  reference: Record<string, unknown>;
};

/** Why an exception does not cover what was observed, or null when it does. */
export function exceptionMismatch(exception: ReviewedException, now: Observed): string | null {
  if (exception.version !== now.version)
    return `version ${now.version}, reviewed ${exception.version}`;
  if (exception.entry !== now.entry) return "snippet changed since review";
  if (exception.lock_sha256 !== now.lock) return "lock changed since review";
  if (exception.bundler !== now.bundler)
    return `bundler ${now.bundler}, reviewed ${exception.bundler}`;
  for (const field of BYTE_FIELDS) {
    if (now.bytes[field] !== exception.bytes[field]) return `depfit ${field} changed since review`;
    for (const side of ["rollup", "webpack"] as const) {
      const value = asNumber(asRecord(now.reference[side])[field]);
      if (value !== exception[side][field]) return `${side} ${field} changed since review`;
    }
  }
  return null;
}

/**
 * Builds eval/bundle/wild.json by the selection rule in eval/bundle/README.md ("Gate W"). The rule
 * is fixed; never change this script to move the corpus after seeing depfit's results.
 *   bun eval/bundle/wild-select.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asNumber, asRecord, asString } from "../../src/collect/util.ts";
import { loadCases } from "./cases.ts";

const KEYWORDS = ["react", "browser", "dom", "frontend", "ui"];
const PAGE = 250;
const PAGES = 2;
const WANTED = 200;
const BULK = 100;
const PAUSE_MS = 1000;
/** Downloads already fetched by an earlier, interrupted run (same rule, same month). */
const CACHE_FILE = join(tmpdir(), "depfit-wild-downloads-cache.json");

const pause = () => new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

async function getJson(url: string): Promise<unknown> {
  // npm's APIs answer 429 to bursts; back off and retry, so rate limiting never drops a package.
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    if (response.status === 404) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2000 * (attempt + 1))));
  }
  throw new Error(`GET ${url} kept failing`);
}

async function candidates(): Promise<string[]> {
  const names = new Set<string>();
  for (const keyword of KEYWORDS) {
    for (let page = 0; page < PAGES; page++) {
      const url = `https://registry.npmjs.org/-/v1/search?text=keywords:${keyword}&size=${PAGE}&from=${page * PAGE}`;
      const body = asRecord(await getJson(url));
      const found = Array.isArray(body.objects) ? body.objects : [];
      for (const object of found) {
        const name = asString(asRecord(asRecord(object).package).name);
        if (name) names.add(name);
      }
      console.log(`search ${keyword} page ${page}: ${found.length} results`);
      await pause();
    }
  }
  return [...names];
}

async function downloads(names: string[]): Promise<Map<string, number>> {
  const cached = asRecord(JSON.parse(await readFile(CACHE_FILE, "utf8").catch(() => "{}")));
  const counts = new Map<string, number>();
  for (const [name, value] of Object.entries(cached)) {
    const count = asNumber(value);
    if (count !== null) counts.set(name, count);
  }
  const save = () => writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(counts)));
  const unscoped = names.filter((name) => !name.startsWith("@") && !counts.has(name));
  const scoped = names.filter((name) => name.startsWith("@") && !counts.has(name));
  const base = "https://api.npmjs.org/downloads/point/last-month/";
  for (let i = 0; i < unscoped.length; i += BULK) {
    const batch = unscoped.slice(i, i + BULK);
    const body = asRecord(await getJson(base + batch.join(",")));
    // A single-name request returns the point record itself, not a map.
    const records = batch.length === 1 ? { [batch[0] ?? ""]: body } : body;
    for (const name of batch) {
      const count = asNumber(asRecord(records[name]).downloads);
      if (count !== null) counts.set(name, count);
    }
    console.log(`downloads ${Math.min(i + BULK, unscoped.length)}/${unscoped.length} unscoped`);
    await save();
    await pause();
  }
  for (const [i, name] of scoped.entries()) {
    const count = asNumber(asRecord(await getJson(base + name)).downloads);
    if (count !== null) counts.set(name, count);
    if (i % 50 === 0) {
      console.log(`downloads ${i}/${scoped.length} scoped`);
      await save();
    }
    await pause();
  }
  await save();
  return counts;
}

/** Why the package is excluded by rule 3, or null when it is kept. */
function exclusion(manifest: Record<string, unknown>): string | null {
  if (asString(manifest.deprecated) !== null || manifest.deprecated === true) return "deprecated";
  const hasEntry = ["main", "module", "exports", "browser"].some(
    (field) => manifest[field] !== undefined && manifest[field] !== null,
  );
  return hasEntry ? null : "no JS entry";
}

const own = new Set((await loadCases()).map((c) => c.package));
const names = await candidates();
console.log(`${names.length} candidates`);
const counts = await downloads(names);
const ranked = names
  .filter((name) => counts.has(name))
  .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));

const kept: { name: string; version: string; downloads_last_month: number }[] = [];
const skipped: Record<string, number> = {};
const skip = (why: string) => {
  skipped[why] = (skipped[why] ?? 0) + 1;
};
for (const name of ranked) {
  if (kept.length >= WANTED) break;
  if (name.startsWith("@types/")) {
    skip("@types");
    continue;
  }
  if (own.has(name)) {
    skip("in cases.json");
    continue;
  }
  const manifest = asRecord(
    await getJson(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`),
  );
  await pause();
  const version = asString(manifest.version);
  if (!version) {
    skip("no latest manifest");
    continue;
  }
  const why = exclusion(manifest);
  if (why) {
    skip(why);
    continue;
  }
  kept.push({ name, version, downloads_last_month: counts.get(name) ?? 0 });
}
console.log("skipped", skipped);
const last = kept.at(-1);
await writeFile(
  join(import.meta.dirname, "wild.json"),
  `${JSON.stringify(
    {
      selected_at: new Date().toISOString(),
      candidates: names.length,
      skipped_while_ranking: skipped,
      packages: kept,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `wrote wild.json: ${kept.length} packages, last ${last?.name} ${last?.downloads_last_month}`,
);

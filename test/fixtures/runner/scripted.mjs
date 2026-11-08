// A stand-in for vite-build.mjs driven by `<root>/runner-rules.json` (pool and measurement tests).
// Every build is logged to `<root>/runner-log.txt` (its entry source on one line, then its worker's
// PID). Each rule applies to a build whose entry source contains `match`: `delayMs` waits first;
// `crash` writes the text to stderr and exits 1; `hang` never answers; `unreadable` prints a line
// that is not a result. Otherwise it answers with one tiny chunk on the evaluated Vite and rolldown
// versions, and with `exports` (from the rules file) for a listing build.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { rolldownVersion, version } from "vite";

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const source = readFileSync(request.entry, "utf8");
  let rules = { exports: [], rules: [] };
  try {
    rules = JSON.parse(readFileSync(join(request.root, "runner-rules.json"), "utf8"));
  } catch {}
  appendFileSync(join(request.root, "runner-log.txt"), `${JSON.stringify(source)} ${process.pid}\n`);
  const rule = rules.rules.find((r) => source.includes(r.match)) ?? {};
  if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
  if (rule.crash) {
    process.stderr.write(`${rule.crash}\n`, () => process.exit(1));
    await new Promise(() => {});
  }
  if (rule.hang) await new Promise(() => {});
  if (rule.unreadable) {
    process.stdout.write("not a result\n");
    continue;
  }
  const chunk = {
    fileName: "index.js",
    isEntry: true,
    imports: [],
    dynamicImports: [],
    moduleIds: [],
    code: "globalThis.x=1;",
    gzip9Bytes: 35,
  };
  const result = {
    vite: version,
    rolldown: rolldownVersion,
    resolutions: [],
    logs: [],
    chunks: [chunk],
    assets: [],
    workers: [],
    exports: request.exports ? rules.exports : null,
    errors: null,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

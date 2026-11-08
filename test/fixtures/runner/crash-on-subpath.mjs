// A stand-in for vite-build.mjs: answers every root build with one tiny chunk (on the evaluated
// Vite and rolldown versions) and exits as soon as a build imports a subpath of `with-subpaths`.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { rolldownVersion, version } from "vite";

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (readFileSync(request.entry, "utf8").includes('"with-subpaths/')) process.exit(1);
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
    exports: request.exports ? ["core"] : null,
    errors: null,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

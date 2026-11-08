// A stand-in for vite-build.mjs that answers every build as if it ran on a Vite and rolldown other
// than the evaluated pins (TOOLCHAIN_MISMATCH tests).
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
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
    vite: "0.0.0",
    rolldown: "0.0.0",
    resolutions: [],
    logs: [],
    chunks: [chunk],
    assets: [],
    workers: [],
    exports: null,
    errors: null,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// A stand-in for vite-build.mjs that answers one request and exits (runner error handling tests).
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const result = { vite: "8.3.4", rolldown: "1.2.14", resolutions: [], logs: [], chunks: [], assets: [], workers: [], exports: null, errors: null };
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  break;
}

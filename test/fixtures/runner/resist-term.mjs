// A stand-in for vite-build.mjs that ignores SIGTERM and never exits on its own; it answers builds
// like answer-once.mjs, so a caller knows the handler is in place once a build is answered (signal
// tests).
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const result = { vite: "8.3.4", rolldown: "1.2.14", resolutions: [], logs: [], chunks: [], assets: [], workers: [], exports: null, errors: null };
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) process.stdout.write(`${JSON.stringify(result)}\n`);
}

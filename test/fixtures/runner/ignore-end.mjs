// A stand-in for vite-build.mjs that answers every build like answer-once.mjs and never exits on
// its own, not even when its input ends (pool shutdown tests).
import { createInterface } from "node:readline";

const result = { vite: "8.3.4", rolldown: "1.2.14", resolutions: [], logs: [], chunks: [], assets: [], workers: [], exports: null, errors: null };
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) process.stdout.write(`${JSON.stringify(result)}\n`);
}
setInterval(() => {}, 1000);

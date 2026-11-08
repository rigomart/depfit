// A stand-in for vite-build.mjs that answers every build like answer-once.mjs, and once its input
// ends keeps running for 500 ms before it exits (pool recycling tests).
import { createInterface } from "node:readline";

const result = { vite: "8.3.4", rolldown: "1.2.14", resolutions: [], logs: [], chunks: [], assets: [], workers: [], exports: null, errors: null };
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) process.stdout.write(`${JSON.stringify(result)}\n`);
}
setTimeout(() => process.exit(0), 500);

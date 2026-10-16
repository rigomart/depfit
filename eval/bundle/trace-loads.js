// Bun preload for score.ts gate F: logs every module specifier containing "rolldown" or "vite"
// that gets resolved, to the file named by DEPFIT_TRACE_LOADS.
import { appendFileSync } from "node:fs";

const file = process.env.DEPFIT_TRACE_LOADS;
Bun.plugin({
  name: "trace-rolldown",
  setup(build) {
    build.onResolve({ filter: /rolldown|vite/ }, (args) => {
      if (file) appendFileSync(file, `${args.path}\n`);
      return undefined;
    });
  },
});

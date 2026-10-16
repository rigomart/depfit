// Bun preload for score.ts gate F: logs every module specifier containing "rolldown" that gets
// resolved, to the file named by DEPFIT_TRACE_LOADS.
import { appendFileSync } from "node:fs";

const file = process.env.DEPFIT_TRACE_LOADS;
Bun.plugin({
  name: "trace-rolldown",
  setup(build) {
    build.onResolve({ filter: /rolldown/ }, (args) => {
      if (file) appendFileSync(file, `${args.path}\n`);
      return undefined;
    });
  },
});

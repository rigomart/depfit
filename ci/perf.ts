/**
 * Compares the times CI measured (ci/e2e.ts and ci/bundle-accuracy.ts `--timings` files) with the
 * recorded baseline in ci/perf-baseline.json, and fails at 2x the baseline or more on a gated
 * metric. Every time is listed in the job summary. Gated: every total, and each package's bundle
 * measurement (local CPU, no network) whose baseline is at least 2 s. The rest are reported only:
 * single CLI runs are mostly network time, and a time under 2 s can double from runner noise alone.
 *
 *   bun ci/perf.ts compare <timings-dir>     # table to stdout and $GITHUB_STEP_SUMMARY
 *   bun ci/perf.ts record <timings-dir>...   # rewrites the baseline: each metric's slowest run
 */
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asNumber, asRecord } from "../src/collect/util.ts";

const BASELINE = join(import.meta.dirname, "perf-baseline.json");
const FAIL_RATIO   =   2;
const GATED_MIN_MS = 2000;

const gated = (metric: string, baseline: number) =>
  metric.endsWith(".total") || (metric.startsWith("bundle.measure.") && baseline >= GATED_MIN_MS);

async function readTimings(dir: string): Promise<Record<string, number>> {
  const timings: Record<string, number> = {};
  for (const file of (await readdir(dir, { recursive: true }))
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    for (const [metric, value] of Object.entries(
      asRecord(JSON.parse(await readFile(join(dir, file), "utf8"))),
    )) {
      const ms = asNumber(value);
      if (ms !== null) timings[metric] = ms;
    }
  }
  return timings;
}

const seconds = (ms: number | undefined) =>
  ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`;

const [command, ...dirs] = process.argv.slice(2);
if (command === "record" && dirs.length) {
  const metrics: Record<string, number> = {};
  for (const dir of dirs) {
    for (const [metric, ms] of Object.entries(await readTimings(dir))) {
      metrics[metric] = Math.max(metrics[metric] ?? 0, ms);
    }
  }
  const sorted = Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(BASELINE, `${JSON.stringify({ runs: dirs.length, metrics: sorted }, null, 2)}\n`);
  console.log(
    `Recorded ${Object.keys(sorted).length} metrics from ${dirs.length} runs in ${BASELINE}`,
  );
} else if (command === "compare" && dirs.length === 1 && dirs[0]) {
  const baseline: Record<string, number> = {};
  for (const [metric, value] of Object.entries(
    asRecord(asRecord(JSON.parse(await readFile(BASELINE, "utf8"))).metrics),
  )) {
    const ms = asNumber(value);
    if (ms !== null) baseline[metric] = ms;
  }
  const measured = await readTimings(dirs[0]);
  const failures: string[] = [];
  const rows = [...new Set([...Object.keys(baseline), ...Object.keys(measured)])]
    .sort()
    .map((metric) => {
      const base = baseline[metric];
      const now = measured[metric];
      const ratio = base !== undefined && now !== undefined && base > 0 ? now / base : null;
      const isGated = base !== undefined && gated(metric, base);
      let status = isGated ? "gated" : "reported";
      if (base === undefined) status = "new, no baseline";
      else if (now === undefined) {
        status = isGated ? "**FAIL** (not measured)" : "not measured";
        if (isGated) failures.push(`${metric}: not measured`);
      } else if (isGated && ratio !== null && ratio >= FAIL_RATIO) {
        status = `**FAIL** (${FAIL_RATIO}x or more)`;
        failures.push(
          `${metric}: ${seconds(now)}, baseline ${seconds(base)} (${ratio.toFixed(2)}x)`,
        );
      }
      return `| ${metric} | ${seconds(base)} | ${seconds(now)} | ${ratio === null ? "–" : `${ratio.toFixed(2)}x`} | ${status} |`;
    });
  const lines = [
    "## Performance",
    "",
    `Fails when a gated time is ${FAIL_RATIO}x its baseline or more (\`ci/perf-baseline.json\`). Gated: totals, and bundle measurements with a baseline of ${GATED_MIN_MS / 1000} s or more.`,
    "",
    "| Metric | Baseline | Measured | Ratio | Status |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    failures.length
      ? `**${failures.length} gated times at ${FAIL_RATIO}x or more**`
      : "No gated time is at 2x its baseline.",
    ...failures.map((f) => `- ${f}`),
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  process.exitCode = failures.length ? 1 : 0;
} else {
  console.error("usage: bun ci/perf.ts compare <timings-dir> | record <timings-dir>...");
  process.exitCode = 2;
}

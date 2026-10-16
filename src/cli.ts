#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCliArgs, resolveOutput, USAGE, useColor } from "./args.ts";
import { type BundleEntry, prepareBundleEntries } from "./collect/bundle-entry.ts";
import { collect } from "./collect/index.ts";
import { parseSpec } from "./collect/registry.ts";
import { renderTable } from "./render/table.ts";
import type { Report } from "./report.ts";
import { schemaDocument } from "./schema-docs.ts";

function packageVersion(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
    return String(pkg.version);
  }
  return "unknown";
}

/** One-line status on stderr while collecting; only on a terminal. */
function progress(specs: string[]): () => void {
  if (!process.stderr.isTTY) return () => {};
  const text = `depfit: collecting ${specs.join(", ")}…`;
  process.stderr.write(text.slice(0, (process.stderr.columns || 80) - 1));
  return () => process.stderr.write("\r\x1b[2K");
}

async function main(argv: string[]): Promise<number> {
  const command = parseCliArgs(argv);
  switch (command.kind) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    case "schema":
      process.stdout.write(`${JSON.stringify(schemaDocument(), null, 2)}\n`);
      return 0;
    case "usage-error":
      process.stderr.write(`depfit: ${command.message}\n\n${USAGE}\n`);
      return 2;
  }

  let bundleEntries = new Map<string, BundleEntry>();
  if (command.bundleEntries.length > 0) {
    const npmNames = command.specs
      .map(parseSpec)
      .flatMap((spec) => (spec.kind === "npm" ? [spec.name] : []));
    const prepared = await prepareBundleEntries(command.bundleEntries, [...new Set(npmNames)]);
    if (!prepared.ok) {
      process.stderr.write(`depfit: ${prepared.message}\n\n${USAGE}\n`);
      return 2;
    }
    bundleEntries = prepared.entries;
  }

  const stdoutIsTTY = process.stdout.isTTY === true;
  const clear = progress(command.specs);
  let report: Report;
  try {
    report = await collect(command.specs, {
      cwd: resolve(command.cwd ?? process.cwd()),
      bundleEntries,
    });
  } catch (error) {
    clear();
    process.stderr.write(`depfit: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  clear();

  if (resolveOutput(command.output, stdoutIsTTY) === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const width = process.stdout.columns || Number(process.env.COLUMNS) || 120;
    const color = useColor(stdoutIsTTY, process.env);
    process.stdout.write(renderTable(report, { width, color }));
  }
  const allFailed = report.packages.length > 0 && report.packages.every((p) => p.error !== null);
  return allFailed ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));

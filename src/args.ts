import { parseArgs } from "node:util";

export type OutputMode = "json" | "table";

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "schema" }
  | {
      kind: "run";
      specs: string[];
      cwd: string | null;
      output: OutputMode | "auto";
      /** `--bundle-entry` snippets as typed, validated later against the specs. */
      bundleEntries: string[];
    }
  | { kind: "usage-error"; message: string };

export const USAGE = `Usage: depfit <spec>... [options]

Compare npm packages by what they would cost this repo and how they are maintained.
A spec is an npm package with an optional range (zod, zod@^3) or a runtime builtin
(node:sqlite, bun:sqlite).

Options:
  --cwd <dir>             Project to compare against (default: current directory)
  --bundle-entry <js>     Measure the browser bundle of an import of one candidate, e.g.
                          'import { z } from "zod"; z.object; z.string'. Only imports from that
                          candidate (or its subpaths) and member statements on the imported
                          names; bindings without members are kept whole. Repeat once per
                          candidate.
  --json                  Print the report as JSON (default when stdout is not a TTY)
  --table                 Print a table (default when stdout is a TTY)
  --schema                Print a one-sentence description of every JSON field, then exit
  -h, --help              Show this help
  -v, --version           Show the version`;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Node appends a long hint about "--" to unknown-option errors; keep the first sentence.
  return message.split(". ")[0] ?? message;
}

/** Parses argv (without the node/script entries). Never throws. */
export function parseCliArgs(argv: string[]): Command {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return { kind: "usage-error", message: errorMessage(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  if (values.schema) return { kind: "schema" };
  if (values.json && values.table) {
    return { kind: "usage-error", message: "--json and --table are mutually exclusive" };
  }
  if (positionals.length === 0) {
    return { kind: "usage-error", message: "no packages given" };
  }
  return {
    kind: "run",
    specs: positionals,
    cwd: values.cwd ?? null,
    output: values.json ? "json" : values.table ? "table" : "auto",
    bundleEntries: values["bundle-entry"] ?? [],
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      "bundle-entry": { type: "string", multiple: true },
      json: { type: "boolean" },
      table: { type: "boolean" },
      schema: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

/** JSON for agents (stdout piped), the table for humans (stdout is a terminal). */
export function resolveOutput(output: OutputMode | "auto", stdoutIsTTY: boolean): OutputMode {
  if (output !== "auto") return output;
  return stdoutIsTTY ? "table" : "json";
}

/** Color only on a terminal, and never when NO_COLOR is set to a non-empty value. */
export function useColor(stdoutIsTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return stdoutIsTTY && !env.NO_COLOR;
}

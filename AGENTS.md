# AGENTS.md

depfit compares npm packages by what they would cost *this* repo (lockfile, source, engines)
and how they are maintained. Its main users are coding agents deciding which dependency to add.

## Commands

```bash
bun src/cli.ts zod valibot@^1 node:sqlite [--cwd dir] [--json|--table]
bun src/cli.ts zod --bundle-entry 'import { z } from "zod"; z.object'   # browser bundle bytes
bun src/cli.ts --schema   # one sentence per JSON field
bun run check-types
bun run lint
bun run test:once
```

Collecting needs network access and `npm` on PATH. GitHub facts need `GITHUB_TOKEN`, `GH_TOKEN`,
or a logged-in `gh`; without one they are null and listed in `unavailable`.

## Layout

- `src/cli.ts`: entry point; parses args (`src/args.ts`), collects, prints JSON or the table.
- `src/report.ts`: the `Report` type, i.e. the output contract.
- `src/schema-docs.ts`: one sentence per JSON path, printed by `--schema`.
- `src/collect/`: builds the `Report`. `facts.ts` and `lockfile.ts` are pure; the rest read the
  project or call npm, OSV, and GitHub. `bundle-entry.ts` validates `--bundle-entry` snippets;
  `bundle.ts` measures them with a real `vite build`, run as a separate process
  (`vite-build.mjs`, on Node) only when a snippet is given (settings and acceptance bar:
  `eval/bundle/SPEC.md`).
- `src/render/`: the human table, a view of the `Report`.
- `test/fixtures/`: small projects for lockfile and workspace tests (see its README).
- `eval/`: the evaluation harness (see Evaluation).

## Output rules

`src/report.ts` is the contract. JSON output is `Report` as-is; the table is a view of it.

- Facts only: no scores, verdicts, warning symbols, or prose notes. Choosing what to highlight
  biases agents, especially small models. The reader interprets.
- Every package has every field. Unknown is `null`, never a missing key.
- Units and caveats go in field names (`new_install_bytes`), not commentary.
- Failed data sources are listed in `unavailable`, never silently dropped.
- A field change also updates `src/schema-docs.ts` (a test checks the paths), and bumps
  `SCHEMA_VERSION` when a field is renamed, removed, or changes meaning.

## Code

- The `depfit` bin needs Bun for now (it runs `src/cli.ts` directly). Keep the code Node-compatible: use `node:` APIs, not `Bun.*`, so it can ship as built JS later.
- Network calls are not unit-tested. Their pure parts (version choice, OSV mapping), lockfile
  parsing, project facts, and rendering are.
- Avoid `any` and type assertions where a type guard works.
- Test behavior, not implementation.

## Evaluation

`eval/` holds the blind-evaluation harness. Probes (`eval/probes.json`, format in
`probes.example.json`) point at local projects, so they, their results (`eval/results/`), and
reviews (`eval/reviews/`) stay gitignored. `bun eval/run.ts [project...]` runs them. Write
findings in `eval/FINDINGS.md`, describing projects by characteristics (stack, lockfile, size),
never by name or path.

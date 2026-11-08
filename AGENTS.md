# AGENTS.md

depfit compares npm packages by what they would cost *this* repo (lockfile, source, engines)
and how they are maintained. Its main users are coding agents deciding which dependency to add.

## Commands

```bash
bun src/cli.ts zod valibot@^1 node:sqlite [--cwd dir] [--json|--table]
bun src/cli.ts --schema   # one sentence per JSON field
bun run check-types
bun run lint
bun run test:once
bun ci/e2e.ts              # CLI on test/fixtures against the output contract (CI runs it on Node too)
bun ci/bundle-accuracy.ts  # the bundle eval's frozen reference cases, exact
```

Collecting needs network access and `npm` on PATH. Three environment switches exist for the eval and CI only:
`DEPFIT_BUNDLE=0` turns bundle facts off, `DEPFIT_LOCK_DIR=<dir>` records each isolated install's
lockfile there, or replays it with `npm ci` when one exists, and `DEPFIT_BUNDLE_WORKERS=<1-4>` sets
how many Vite workers build bundle measurements. GitHub facts need `GITHUB_TOKEN`, `GH_TOKEN`,
or a logged-in `gh`; without one they are null and listed in `unavailable`.

## Layout

- `src/cli.ts`: entry point; parses args (`src/args.ts`), collects, prints JSON or the table.
- `src/report.ts`: the `Report` type, i.e. the output contract.
- `src/schema-docs.ts`: one sentence per JSON path, printed by `--schema`.
- `src/collect/`: builds the `Report`. `facts.ts` and `lockfile.ts` are pure; the rest read the
  project or call npm, OSV, and GitHub. `bundle.ts` builds with a real `vite build` in a separate
  Node process (`vite-build.mjs`, one build per request). `vite-pool.ts` runs those processes as a
  pool shared by every candidate of a run, and `children.ts` stops every child process depfit
  started when it is signalled. `root-entry.ts` measures the root entry point whole, each export
  alone and each subpath whole, all at once on the pool; `index.ts` imports it only in a browser
  workspace (`project.browser_signals`), so Vite is never loaded otherwise.
  The eval also measures import snippets (`bundle-entry.ts`) as real-usage ground truth.
  Acceptance bar: `eval/bundle/SPEC.md`.
- `src/render/`: the human table, a view of the `Report`.
- `test/fixtures/`: small projects for lockfile and workspace tests (see its README).
- `ci/`: what `.github/workflows/ci.yml` runs on every pull request, and the performance baseline
  (see its README).
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
reviews (`eval/reviews/`) stay gitignored. `bun eval/run.ts [--set <name>] [project...]` runs
them. Write findings in `eval/FINDINGS.md`, describing projects by characteristics (stack,
lockfile, size), never by name or path.

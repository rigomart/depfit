# AGENTS.md

depfit compares npm packages by what they would cost *this* repo (lockfile, source, engines)
and how they are maintained. Its main users are coding agents deciding which dependency to add.

## Commands

```bash
bun src/cli.ts zod valibot yup [--cwd dir] [--json|--table]
bun run check-types
bun run lint
bun run test:once
```

## Output rules

`src/report.ts` is the contract. JSON output is `Report` as-is; the table is a view of it.

- Facts only: no scores, verdicts, warning symbols, or prose notes. Choosing what to highlight
  biases agents, especially small models. The reader interprets.
- Every package has every field. Unknown is `null`, never a missing key.
- Units and caveats go in field names (`new_install_bytes`), not commentary.
- Failed data sources are listed in `unavailable`, never silently dropped.

## Code

- Runs on Node (Bun is the dev runner). Use `node:` APIs, not `Bun.*`.
- Network collectors are not unit-tested; lockfile parsing, project facts, and rendering are.
- Avoid `any` and type assertions where a type guard works.
- Test behavior, not implementation.

## Evaluation

`eval/` holds the blind-evaluation harness. Probes (`eval/probes.json`, format in
`probes.example.json`) point at local projects, so they, their results, and reviews stay
gitignored. `bun eval/run.ts [project...]` runs them. Write findings in `eval/FINDINGS.md`,
describing projects by characteristics (stack, lockfile, size), never by name or path.

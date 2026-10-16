# Bundle size: status and handoff (2026-10-16)

Work in progress on branch `t3/b368aecf`, saved as a WIP commit. Read SPEC.md first: it is the bar,
the decisions, and the stop conditions.

## Where things stand

**Step 1** (`--bundle-entry '<js>'`, browser, JS only, opt-in) is implemented in
`src/collect/bundle.ts` and `src/collect/bundle-entry.ts`, with schema v5 and rolldown ~1.2.14.

Last corpus scorecard (`score.ts --runs 2`, 33 step-1 cases):

| Gate | Result |
|---|---|
| A | Pass |
| B | 24/25. node-pty is out of band (see open decisions) |
| C | 10/11 (node-pty) |
| D | Pass |
| E | Failed only on npm 429 flakes. The scorer fix that retries and classifies them is in progress |
| F | Pass |

**H0 (comprehension):** passed 3/3 on the original 5 questions. Question 6 (node-pty's number
doesn't mean it runs) was added after the claim was narrowed, and has not been run yet.

**Gate W (wild corpus):** 200 packages selected (`wild.json`, rule in README.md), with locks and
references built. The depfit run (`score.ts --wild`) was stopped at 144/200. Its per-package results are in
`results/wild-run/` (gitignored); the eval agent was stopped before reporting. Unverified: whether
the gate-E 429 fix and the H0 question 6 landed. Check `score.ts` and `comprehension.ts` first.

## Decisions made with the user

1. **Structural rule:** the opaque-load pattern list was replaced by a structural rule after a
   Codex review bypassed it (stop condition 1).
2. **Narrowed claim:** the structural rule nulled 13 of 27 real cases on harmless environment checks,
   so the claim was narrowed (stop condition, second time). The number is emitted bytes, never "it
   runs". The only runtime-load null is `IMPORT_OUTSIDE_BUNDLE`. As a result node-pty, moment and
   ajv are measure cases, and webpack references that build context modules are excluded from a
   case's band.

## Open decisions (for Codex review round 3, then the user)

- **node-pty JSON:** depfit 1184 B gzip, rollup 894, Vite 1591. The difference is how each bundler
  handles `require("./package.json")`. Should depfit adopt rolldown's `viteJsonPlugin` (it matches the
  "like Vite's client build" rule written earlier, but was found through one case)? Even then, a band
  from rollup alone fails. Possible answers: keep the case failing, rethink single-reference bands,
  or rethink node-pty's mandatory flag, which no longer has its original purpose.
- **Bar changes in this step, for review:** gross-error slack (+100 B), the Vite-lazy normalization
  that replaced the blanket exclusion, ajv/node-pty/moment moving to measure, and the webpack
  context-module exclusion.
- **Watch items:**
  - Code size: `bundle.ts` 403 lines plus `bundle-entry.ts` 255, vs 292 in the removed v3 module
    (stop condition 4).
  - Single-reference bands.

## To resume

1. Check the wild run. Either rerun `bun eval/bundle/score.ts --wild`, or read the latest file in
   `results/`.
2. Rerun `bun eval/bundle/score.ts --runs 2`, then `bun eval/bundle/comprehension.ts`, and run 3
   blind readers on the prompt.
3. Run Codex review round 3 (gpt-6.1-sol, high) on the diff and the bar changes above. Include the
   history of both earlier rounds (findings in `results/research/review1`, `review2`).
4. Before step 2, stop and review with the user.

Research is copied to `results/research/` (gitignored): `catalog.md` (post-mortem and corpus) and
`method.md` (bundler study).

# Bundle size: status and handoff (2026-10-16)

Work in progress on branch `t3/b368aecf`, saved as a WIP commit. Read SPEC.md first: it is the bar,
the decisions, and the stop conditions.

## Where things stand

**Step 1** (`--bundle-entry '<js>'`, browser, JS only, opt-in) is implemented in
`src/collect/bundle.ts` and `src/collect/bundle-entry.ts`, with schema v5 and rolldown 1.2.14 (pinned
exactly; the JSON plugin comes from `rolldown/experimental`). All Codex round 3 fixes are applied.
Then the user chose to raise the band's absolute slack from 100 B to 1000 B (SPEC "Band", with the
evidence); **Codex round 4 rejected it** (see below).

Scorecards, 2026-10-16 15:13 (corpus) and 15:22 (wild):

| Gate | Result |
|---|---|
| A | Pass |
| B | **Fail**: 24/25, node-pty-named min bytes 3,424 vs band max 3,119 (rollup only; gzip passes) |
| C | Pass, 11/11 |
| D, E, F | Pass |
| W | Pass: (i) 0, (ii) 0 with 1 reviewed exception (tldts), (iii) 0 |
| H0 | Pass: 3/3 blind readers, all six questions |

**What the 1000 B slack absorbed** (all match Vite): ws-default in the corpus (708 B vs 271-274;
rolldown's CommonJS interop helper), and in the wild corpus server-only (its exception was
removed), brorand (1,507 vs 1,820-1,986), and constants-browserify (7,733 vs 4,711-6,779; that one
is Vite's JSON handling, not wrapper code).

**node-pty:** depfit 3,424 / 1,600 B, Vite 3,432 / 1,591. Its band is rollup only (webpack built a
context module). Codex round 3 said to keep it mandatory and failing. It is still open.

**Other observations:** the one wild package that was null with `JSON_PARSE` is now null with a bare
`PLUGIN_ERROR` (the JSON plugin's error has no file name); it also nulls on Node built-ins.

## Codex review round 4 (2026-10-16): still unfinished

Findings (lead reproduced 1):

1. **Blocking, a silent wrong number in depfit:** `import.meta.env.DEV/PROD` is not replaced, so
   development-only branches stay in the bundle. Vite replaces them in a production build. Lead's
   repro: a package with `import.meta.env.DEV ? (dev warning) : "prod"` gives 108 B in depfit vs
   29 B in Vite. Codex: 910 vs 29 B, and +16.7% on a mid-sized variant. Fix: apply Vite's
   production `import.meta.env` substitutions and add a mandatory case.
2. **The 1000 B slack is rejected**: it hid finding 1 (a 16.7% error stayed in band). Codex: keep
   the gross slack at 100 B and handle explained differences as reviewed exceptions (ws, node-pty,
   server-only, tldts). constants-browserify is a legitimate difference (JSON) but needs its own
   explanation. **The code still has 1000 B (`harness.ts` SLACK_BYTES); revert it.**
3. `wild-score.ts --resume` reuses cached verdicts without rechecking exceptions, ranges or audits,
   and exceptions do not compare `vite_anchor`.
4. The auditor's webpack exemption accepts any `.u()` call (`import("https://cdn/" + app.u(id))`).
5. Gate E: deleting source-fed fields before comparing excuses a missing key (`maintenance.archived`
   removed plus `github: HTTP 503` gives network true).
6. Removing Vite's `native:import-analysis-build` plugin also removes its import-attribute cleanup
   (44 vs 61 B on a `with {type: "json"}` peer import). Keep the plugin and disable only
   `insertPreload`.
7. Nit: the JSON fixtures pass without the JSON plugin too (225 / 33 B vs 922 / 33 B).

Codex agreed with: the `.mjs` entry, the JSON plugin and exact pin, the `native_binaries` wording
and H0 key, a bare `PLUGIN_ERROR` (could add the plugin name), and a narrowly reviewed exception for
node-pty (that needs a B policy change). It counts 8 surviving bar changes.

**Lead's assessment, given to the user:** four review rounds, and each found something. depfit's
silent wrong numbers come from one cause: it copies Vite's settings by hand onto rolldown, and every
setting missed (JSON, `import.meta.env`) is a wrong number. That is close to stop condition 4 (fixes
land in the same place each round; the eval harness is about 2,800 lines for a 670-line feature).
Proposed instead of round 5: have depfit run Vite itself (`vite build`, app mode, runtime
`insertPreload` off), so "matches Vite" holds by construction and the Vite-parity machinery can go.
Costs: Vite is a larger dependency than rolldown (run depfit on it first), builds are somewhat slower,
and `bundle.ts` and the parity parts of the harness get rewritten. **The user chose to commit this
state and pause** (2026-10-16).

## Codex review round 3 (2026-10-16): step 1 is unfinished

Codex: "ready to present as unfinished, not as passing". The stop-and-reassess condition is
reached, so the bar is not adjusted further until the user decides. Findings (lead verified 1b and 4):

1. **Blocking: the Vite anchor measures something else.**
   a. `reference.ts` treats equal stock and no-preload sizes as "no helper injected". For
      @storybook/addon-a11y both builds contain the helper (9,206 B vs rolldown 7,511 B), so the
      18% gap is mostly faulty normalization. The constant gzip subtraction is also off for
      small entries (more than 4%).
   b. The reference entry is `.js` and depfit's is `.mjs`, and CommonJS interop differs between
      them (isarray: 668 B from `.mjs`, 753 B from `.js` in the lead's build). This is the
      43 B offset.
   Fix: same entry format everywhere; detect and remove the actual helper text before compression.
2. **Blocking: the blanket Vite waiver in W (ii) is not approved.** It removes the independent check
   exactly when it finds something, and a shared engine bug would pass. Approved instead: only
   reviewed exceptions tied to the pinned package, entry, tree and full byte comparison, with a
   written cause. tldts (oxc string duplication) and server-only (reference runtime overhead) qualify.
3. **Blocking: adopt `viteJsonPlugin`** (a general Vite setting; pin the version and add JSON
   fixtures). Keep node-pty mandatory and B failing under the current bar, with no Vite arbiter for B.
4. **Should-fix: gate E's flake rule is too broad.** `firstDiff(..., skipNulled)` ignores every
   null-vs-value difference once any network entry appears. Fix: ignore only the fields that
   the failed source feeds.
5. **Should-fix: auditor false negatives** (pre-existing, both modes): it matches chunks by basename
   (`import("https://cdn/entry.js")` passes when a chunk is named entry.js), exempts any
   `import("./" + x)`, and misses `self["importScripts"](...)`.
6. **Should-fix: the H0 key overstates `native_binaries`.** A package can ship native files and a
   separate browser build, and `binding.gyp` is not a binary. Add to the docs: "Browser JavaScript
   cannot directly load native addons or shared libraries; a listed package may also provide a
   separate browser implementation." Then fix the key and rerun H0.

Also approved: the AST auditor (no in-scope regression found), the +100 B slack, the narrowed
claim and its case changes, the webpack context-module exclusion, and the schema-docs bundler note
(suggested wording: "can differ by a factor of two or more"). Codex counts 7 surviving bar changes
in step 1.

## Decisions made with the user

1. **Structural rule:** the opaque-load pattern list was replaced by a structural rule after a
   Codex review bypassed it (stop condition 1).
2. **Narrowed claim:** the structural rule nulled 13 of 27 real cases on harmless environment checks,
   so the claim was narrowed (stop condition, second time). The number is emitted bytes, never "it
   runs". The only runtime-load null is `IMPORT_OUTSIDE_BUNDLE`. As a result node-pty, moment and
   ajv are measure cases, and webpack references that build context modules are excluded from a
   case's band.
3. **Vite arbiter (gate W):** see above. Stop condition 3 tripped (bar changes after results) and
   the user chose this, pending Codex agreement.

## Open decisions (for Codex review round 3, then the user)

- **node-pty JSON:** depfit 1184 B gzip, rollup 894, Vite 1591. Vite runs rolldown's
  `viteJsonPlugin` (`namedExports: true`, `stringify: "auto"`, `minify: true`) on every `.json`
  import, so `require("./package.json")` becomes an ES module with named exports and interop
  helpers. With that plugin added, depfit's build gives 3,424 / 1,588 B against Vite's 3,432 / 1,591
  (C passes). It is a general "like Vite's client build" setting, not case-shaped, but was found
  through one case, and the plugin is exported from `rolldown/experimental`. B still fails, since
  the band comes from rollup alone (webpack excluded for its context module), unless B gets the same
  Vite arbiter rule as W. That would be another bar change.
- **`native_binaries` doc:** add that a browser cannot load native binaries (a fact)? Changing it
  means rerunning H0.
- **Bar changes in this step, for review:** gross-error slack (+100 B, Codex agreed), Vite-lazy
  normalization for C (Codex asked for it), ajv/node-pty/moment to measure (user), webpack
  context-module exclusion, the gate W Vite arbiter, and the AST auditor.
- **Watch items:**
  - Code size: `bundle.ts` 403 lines plus `bundle-entry.ts` 255, vs 292 in the removed v3 module
    (stop condition 4).
  - Single-reference bands.

## To resume

Paused by the user after round 4, then the user chose to switch depfit to running `vite build` itself
(after a depfit comparison of bundlers). The plan, revised after a Codex review of it, is
`PLAN-vite.md`. Next: the user confirms its two decisions (count Vite's preload helper; replace gate C
with a small conformance check), then the spike (step 1 of the plan). Reproductions for rounds 3-5 are
in `results/research/review3/`, `review4/` and `review5/` (gitignored).

Research is copied to `results/research/` (gitignored): `catalog.md` (post-mortem and corpus) and
`method.md` (bundler study).

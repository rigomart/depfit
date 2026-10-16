# Bundle size: status and handoff (2026-10-16)

Work in progress on branch `t3/b368aecf`, saved as a WIP commit. Read SPEC.md first: it is the bar,
the decisions, and the stop conditions.

## Where things stand (2026-10-16, end of step 1)

**Step 1 passes**, with the known limits in SPEC.md ("Known limits (step 1)"). depfit measures a
snippet with a real `vite build` (Vite 8.3.4 on rolldown 1.2.14, in a clean Node child process), and
every honesty check reads only what Vite resolved, logged and emitted.

| Gate | Result |
|---|---|
| A | Pass (8/8 null codes, 0 gross errors) |
| B | Pass: 24/26 in band, 2 reviewed exceptions (ws-default, node-pty-named) |
| C | Pass: 12/12 equal a stock `vite build` (min bytes exact) |
| D, E, F | Pass |
| W | Pass: (i) 0, (ii) 0 with 2 reviewed exceptions (tldts, server-only), (iii) 0 |
| H0 | Pass: 3/3 blind readers, all six questions |

Review rounds after the switch to Vite each found a gap, and all were fixed: an alias to a Node
built-in; source-syntax URL checks (replaced by the Vite-only rule); inline workers (every worker is
now step 4); a peer bundled through an alias, then a nested peer copy (`PEER_IN_BUNDLE`, by owning
package). The last findings were constructed packages and changed no wild result, so the user chose
to fix them, write the remaining limits down, and stop the review rounds. Code size grew to about 700
lines (`bundle.ts` plus `vite-build.mjs`), against 403 before.

Earlier history follows.

## Earlier state

**depfit now measures with a real `vite build`** (PLAN-vite.md, implemented 2026-10-16):
`src/collect/vite-build.mjs` runs Vite 8.3.4 on rolldown 1.2.14 (pinned, with `overrides`) in a
clean Node child process; `src/collect/bundle.ts` turns its output into bytes or reasons
(`problemsFromBuild`). Settings: SETTINGS.md (the old hand-copied rolldown setup is in
SETTINGS-rolldown-v1.md).

Scorecards, 2026-10-16 (corpus 17:3x, wild 17:30):

| Gate | Result |
|---|---|
| A | Pass (8/8 null codes, 0 gross errors) |
| B | Pass: 24/26 in band, 2 reviewed exceptions (ws-default, node-pty-named) |
| C | Pass: 12/12 mandatory cases equal a stock `vite build` (min bytes exact) |
| D | Pass, 34/34 |
| E | Pass, 34/34 (zustand-devtools has no v4 key baseline; noted, not failed) |
| F | Pass: neither Vite nor rolldown loaded without bundling; median overhead 4 ms |
| W | Pass: (i) 0, (ii) 0 with 2 reviewed exceptions (tldts, server-only), (iii) 0 |
| H0 | Pass: 3/3 blind Haiku readers correct on all six questions (Vite-based output, new docs) |

**Codex review of the implementation (2026-10-16): not passing, then fixed.** Two blocking
bypasses, each reproduced by a fixture, now null: a Node built-in behind a package `imports` alias
(`#crypto`), because every `__vite-browser-external` stub is unmeasurable unless the importing package
maps that import to false in its `browser` field (matched with Vite's extensions); and asset URLs in
other spellings (`new URL(("./x"), ...)`, `new URL(f(), ...)`, `import.meta["url"]`, comments), because
the child now reads `new URL(x, import.meta.url)` and Workers from a literal URL from the syntax
tree (text only when a module does not parse; words in strings no longer count). Also: workers from
a literal file or URL are NON_JS_IMPORT again (a Blob worker is still measured);
`TOOLCHAIN_MISMATCH` when the installed Vite or rolldown is not the evaluated pin (npm ignores
`overrides` inside installed dependencies); the auditor's webpack exemption needs every string of
its `.u` function in an emitted chunk name and is never granted in text mode; gate E rejects a
surviving `security` section with a missing key; the wild cache key covers all of `src/`, the lockfile
and the runtime, and W now detects drift (a locked package missing from depfit's install). Codex
accepted the ws and node-pty exceptions (numbers reproduced). Not done: Codex's suggested
restructure (moving interpretation into the child), and a chunk-graph comparison in gate C (the CLI
output does not expose chunks).
Rerun after the fixes: corpus A-F pass (2 exceptions), W passes (2 exceptions; 1 number set aside
as drifted: @testing-library/jest-dom's aria-query moved).

**Codex final checks of the Vite-only rule (2026-10-16).** First check: inline workers are built
outside the main build's plugins, so a worker's Node stubs, outside imports and peers reached the
number. Fixed by deferring every worker to step 4: any Vite worker build, inline or not, is
`NON_JS_IMPORT worker <module>` (a recorder in `worker.plugins`; Codex then tried 20 worker forms,
including SharedWorker, nested, lazy-chunk and TypeScript workers, and all were null). Second
check: a peer imported through an alias (`#peer`, a relative path) was bundled despite the
name-based exclusion; now `PEER_IN_BUNDLE <peer>` whenever a peer's own files are in the output. The
auditor's webpack exemption also needs its prefix directory to hold emitted chunks, and counts every
write to `.u`, destructuring included.

**Codex re-check of the fixes (2026-10-16): still bypassable, then the rule changed.** It found more
spellings that the source-syntax URL/Worker checks missed (`import . meta.url`, `` import.meta[`url`] ``,
`new globalThis["URL"]`, `\u0057orker`, a TypeScript `as`), and a `#crypto` alias with a `browser`
entry Vite ignores. That is the first attempt's pattern-list loop again, so the user chose to rely on
Vite only: depfit reads no package source. `NON_JS_IMPORT` now means Vite emitted a non-JS file (CSS, a
large asset, a worker, wasm). What Vite inlines into the JS is counted. Files loaded by a path at
runtime are outside the claim, like `fetch`. A `#` import alias never gets the `browser` exemption.
Also: the auditor exempts only webpack's exact `"<dir>" + r.u(id)` form with a single trusted `.u`
definition, and the wild cache key includes the child Node's versions. Rerun: corpus A-F pass, W
passes; references and audits unchanged; only vite and @vitest/browser lost a secondary
NON_JS_IMPORT (still null for Node built-ins).

**Found and fixed during the implementation, by the gates:**
- D: a MISSING_EXPORT reason held the temp install path (different every run); log paths are
  now labeled `pkg/file.js`.
- C: under Bun, Vite emits a different preload helper (it is built from function source text) and
  shiki was 2 B off a stock build; the child now runs on Node, as Vite users do.
- W: `new Worker(...)` from in-bundle code (fflate, a Blob URL) was wrongly NON_JS_IMPORT; only
  `new URL(..., import.meta.url)` and asset queries count. brorand maps the built-in name `crypto`
  to false in its `browser` field; that mapping is now honored like `./file.js: false`. Resolver
  errors (storybook) are recorded as unresolved, so NO_ENTRY is back.
- E: the round-4 key fix had changed the v4 shape comparison; shapes are computed as recorded.

**Watch item, missed target:** code size. The plan aimed below the old module's 403 lines;
`bundle.ts` is 510 and `vite-build.mjs` 191 (about 700). The growth is the runner protocol (types
and guards for its JSON), one structural check per quiet Vite success, and the child process.

**Reviewed exceptions** (`exceptions.json`, causes written there): ws-default (rolldown's CJS
interop helper), node-pty-named (Vite's JSON namespace; rollup-only band), tldts (oxc string
duplication), server-only (reference wrapper code). The two corpus ones need Codex's review.

**Other changes:** reference builds define Vite's production `import.meta.env` for rollup and
webpack; a new mandatory case zustand-devtools (`import.meta.env.MODE`); the band slack is back to
100 B; round-4 harness fixes (resume cache keyed by inputs with verdicts recomputed; webpack loader
tied to its `.u` definition and a relative prefix; gate E keeps keys); tests for gate E and the
auditor in `test/eval-bundle.test.ts`.

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

## Open decisions at round 3 (historical, since resolved)

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

Step 1 is done. Next is step 2 (repo usage, `--bundle` derived from `in_repo.files_using`), which
starts with the user.

Research is copied to `results/research/` (gitignored): `catalog.md` (post-mortem and corpus) and
`method.md` (bundler study).

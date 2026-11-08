# Bundle size: acceptance bar (v2, no input)

`depfit zod valibot` reports browser bundle facts with no flags and no snippets (user constraint,
2026-10-19). The v1 bar, with the snippet API it replaces, is in
[SPEC-snippets-v1.md](SPEC-snippets-v1.md). The evidence for this design is in
`eval/FINDINGS.md`, round 4 and its follow-up.

Principle (unchanged): **depfit reports the bytes a real production bundler emits for an import it
names, or null with a reason code. Never a guess.** No number is a claim about the reader's own
usage. Each number says which import it measured.

Why two numbers and not one: a package's size depends on how much of it is imported. The whole
package matches real usage for one-piece libraries (fuse.js, marked, howler) and overstates
pay-per-use ones by up to 10x (valibot 14.3 KB whole, 1.4 KB in real use). The median single
export alone misleads the other way (motion 0.2 KB, 43 KB in real use). Together they bracketed
real usage in 31 of 35 cases, and in 23 of 24 pairs where both pointed the same way, real usage
agreed.

## What carries over from v1

- **Engine:** a real `vite build` (Vite 8.3.4 on rolldown 1.2.14, pinned) with the settings in
  [SETTINGS.md](SETTINGS.md), run on Node in a clean child process.
- **Honesty checks** (`problemsFromBuild`) and their null codes: `UNRESOLVED_IMPORT`,
  `MISSING_EXPORT`, `IMPORT_OUTSIDE_BUNDLE`, `NO_ENTRY`, `NON_JS_IMPORT`, `PEER_IN_BUNDLE`,
  `TOOLCHAIN_MISMATCH`, and pass-through bundler codes. Failed builds are never retried with
  failures marked external.
- **Peers:** installed for `cost` and left out of every bundle. `external_packages` lists only the
  peers the measured output still imports (amendment 5, 2026-11-05).
- **Eager vs lazy:** eager is the entry chunk plus its static-import closure; lazy is the rest of
  what `import()` reaches. Never summed.
- **Band, gross error, reviewed exceptions, references** (rollup 4 + terser, webpack 5), and every
  v1 settled question that does not concern snippets.
- **Stop conditions** (below), unchanged.

## Iterations, safest first

Each iteration is its own PR. Its acceptance bar is written into this file before its code, and
the next iteration starts only after the current one passes and its scorecard is in `STATUS.md`.

**Superseded after iteration 2 (2026-11-07).** Everything after iteration 2 follows the spec
"Overview + follow-ups: a compact default with drill-down on demand"
([#6](https://github.com/rigomart/depfit/issues/6)), not rows 3–6 of this table. Iteration 2
ships as that spec's first slice ([#9](https://github.com/rigomart/depfit/issues/9)). Rows 3–6 are
kept for history; no iteration is built from them. Framework-specific entry points (row 3) are
folded into the follow-up flags ([#10](https://github.com/rigomart/depfit/issues/10)).

| # | Ships | Bar |
|---|---|---|
| 0 | Remove `--bundle-entry` from the CLI and schema. Keep the engine, and keep snippet measurement as an eval-only library call for ground truth. | Below |
| 1 | Root entry point, measured two ways, for browser workspaces only. | Below |
| 2 | Each subpath in the package's `exports` map, measured whole. | Below |
| 3 | The entry point for the workspace's own framework (`motion/react` in a React workspace), and undeclared framework imports left out (auto-animate's `react`). | Written before iteration 3 |
| 4 | For candidates the workspace already imports: the imports in `in_repo.files_using`, measured as written. | Written before iteration 4 |
| 5 | `already_bundled_via`: the candidate already reaches this workspace's bundle through another dependency. | Written before iteration 5 |
| 6 | Marginal bytes on top of what the workspace already ships, only if 4 and 5 leave a gap. | Written before iteration 6 |

Out of scope until a later bar names them: Workers target, non-JS output (CSS, wasm, workers),
add-on modules outside the root that have no `exports` map (gsap's Flip, dayjs plugins, prism
languages), and caching.

## Iteration 0: remove the snippet API

- `--bundle-entry` and `entry` / `entry_source` are gone; `--help`, README and `schema-docs` say
  nothing about snippets. `SCHEMA_VERSION` becomes 6 (iteration 1 lands in the same version).
- The snippet parser, entry generator and `bundleEntry` stay, called only by `eval/`. `eval/run.ts`
  measures a probe's `bundle_entries` through them, so this round's ground truth stays reproducible.
- Pass: type check, lint and tests pass; the round-4 ground truth reproduces within 1% per
  candidate (the experiment reproduced it within 0.5%).

## Iteration 1: root entry point, two ways

### When it runs

Only when the workspace (`project.workspace`) shows a browser signal. The signals, checked in its
own package.json and directory only:

1. A UI runtime in `dependencies` or `devDependencies`: `react-dom`, `preact`, `vue`, `svelte`,
   `solid-js`, `@angular/core`, `lit`.
2. A web app framework there: `next`, `astro`, `nuxt`, `@sveltejs/kit`, `@remix-run/react`,
   `@tanstack/react-start`, `gatsby`.
3. An `index.html` in the workspace directory.
4. A `browser` field in its package.json.

Build tools (`vite`, `webpack`, `rollup`, `esbuild`, `parcel`) are not signals on their own: tools
and test setups depend on them too (depfit depends on `vite`).

`project.browser_signals` lists what matched (e.g. `["preact", "index.html"]`), empty when none
did. With no signal, every `packages[].bundle` is null and each package's `unavailable` has one
entry: `bundle: skipped, no browser signal in workspace`. Vite and rolldown are not loaded.

### What is measured

For each package, from its isolated install, only the root entry point (`"."`):

- **Whole:** `import * as m from "<name>"`, kept whole.
- **Each export alone:** the names the bundler resolves for `export * from "<name>"`, plus
  `default` when it resolves, each in its own build (`import { <name> as v } from ...`, kept). One
  multi-entry build is not allowed: a single-file package puts the union of all exports in one shared
  chunk (valibot: 14.0 KB median instead of 0.5 KB). Every export is built, no sampling.
- Each build passes the same honesty checks. An export whose build fails is left out of the
  median and counted.
- Builds run sequentially in one child process per package.
- **Cap:** more than 1000 exports makes the single-export fields null with
  `bundle: EXPORT_LIMIT <count>`. The whole-package fields are still reported.

### Contract (schema v6)

`packages[].bundle`, null when skipped or `error` is set:

| Field | Meaning |
|---|---|
| `bundler`, `target` | As v5 (`vite@8.3.4 (rolldown@1.2.14)`, `browser`) |
| `entry_point` | `"."`, the root entry point every number below measures |
| `whole_eager_js_min_bytes`, `whole_eager_js_gzip9_bytes` | Eager JS of the whole entry point, every export kept |
| `whole_lazy_js_min_bytes`, `whole_lazy_js_gzip9_bytes` | Its lazy chunks; 0 when none |
| `exports` | Number of exports the entry point has (`default` included) |
| `exports_measured` | How many of them built and passed the checks |
| `single_export_median_eager_js_gzip9_bytes` | Median over measured exports of one export's eager gzip bytes |
| `external_packages` | Peers the measured builds left out and still import, by package name (amended 2026-11-05, amendment 5) |

A whole-package null keeps its reason code in `unavailable`, as in v5. Unmeasured exports add
one entry: `bundle: <n> exports unmeasurable (<codes>)`, counting and listing only the exports and
codes the whole build does not already report, so one cause gives one entry per package (amended
2026-11-05, below). `schema-docs` says each number is a
standalone build of the named import, that neither is the reader's usage nor marginal cost, and
that real usage of a few exports usually lies between the two.

Deliberately left out: the heaviest export and its name, lazy bytes per export, and min/p90. Add
them in a later iteration only if gate H shows readers need them.

### Gates

| Gate | Pass condition |
|---|---|
| **A. Honesty** | Every v1 null case that measures the root entry point returns its expected code. 0 gross errors on whole or single-export numbers. |
| **B. Accuracy** | **Whole:** gate W's corpus (about 200 packages, `import * as m`, the exact whole-package build) passes W's conditions (i)–(iii) against its existing references. **Single export:** a fixed reference set of 20 wild-corpus packages with at least 10 exports, as counted by the rollup reference build, not by depfit (the first 20 in `wild.json` order) × 5 exports each (evenly spaced over sorted names) is in band against rollup + webpack, or covered by a reviewed exception; 0 gross errors. A single-export case that is an expected null (amendment 2) counts under A, not B (amended 2026-11-05). |
| **C. Vite conformance** | For the 20 × 5 set and 10 whole-package cases, depfit's bytes equal a stock `vite build` made by `reference.ts` without depfit's code: min bytes identical, gzip within 1%. Single-export cases that are expected nulls (amendment 2) count under A (amended 2026-11-05). |
| **D. Determinism** | Two runs give identical bytes, counts and reasons. |
| **E. Contract** | Every package has every bundle field (null when unknown). Every new field is in `schema-docs`. Every non-bundle field is identical with bundling on and off (an eval-only `DEPFIT_BUNDLE=0` switch). |
| **F. Cost** | Non-browser workspace: Vite and rolldown are never loaded (hard check). Browser workspace: median added time ≤ 1.5 s per package across all probe candidates; p90 and max are reported. |
| **S. Browser signal** | The classification table below matches exactly. |
| **R. Real usage** | Over the round-4 probes and the holdout probes: real usage (eval-only snippet measurement) lies within `[0.9 × single-export median, 1.1 × whole]` for at least 85% of candidates (round 4: 31/35). Among pairs in one probe where both numbers point the same way and real usage differs by at least 10%, real usage agrees in at least 90% (round 4: 23/24). Every miss must fall into a class named below; any other miss fails the gate. |
| **H0. Comprehension** | A blind Haiku reader with only JSON and `--schema` answers 5 fixed questions correctly in 3/3 runs: what `whole` includes; what the single-export median means; that neither is this app's usage or marginal cost; what `exports_measured < exports` means; why `bundle` is null in a workspace with no browser signal. |
| **H. Decisions** | The round-4 blind eval (control vs v6, Sonnet and Haiku) on every probe. 0 misreadings of what a number measures. Every decision that differs from the control is reviewed against the facts, and none is worse unless the cause is a known limit written below before the run. |

**Miss classes for gate R** (written before any v6 run):

1. Real usage imports a subpath other than the root: a lighter core (`highlight.js/lib/core`,
   `shiki/core`) or an add-on module (`gsap/Flip`, `dayjs/plugin/*`, prism languages). Iterations
   2 and 3.
2. Real usage keeps members of one namespace-like export (zod's `z.object` and the like), which
   per-export builds keep whole.
3. Real usage goes through a framework subpath (`motion/react`). Iteration 3.

**Known limits for gate H** (written before any v6 run):

- The numbers are standalone, not marginal: a candidate the workspace already ships through
  another dependency still shows its full size (shiki through `@pierre/diffs`, round 4).
  Iteration 5.
- Only the root entry point is measured until iteration 2.

**Classification table for gate S** (by the rule above; local projects described by stack):

| Workspace | Expected signals |
|---|---|
| Static Preact site, Vite | `preact` (its `index.html` is in `app/`; amended 2026-11-05) |
| Preact + CodeMirror notes app, Vite | `preact`, `index.html` |
| Next.js app | `next`, `react-dom` |
| Vite + React apps (4 workspaces) | `react-dom`, `index.html` where present |
| React application package (no app shell) | `react-dom` |
| Astro portfolio and Astro marketing site | `astro` |
| Next.js docs app in a UI-library monorepo | `next`, `react-dom` |
| Electron app with a React renderer | `react-dom` (renderer counts), `index.html` (amended 2026-11-05) |
| Expo app with `react-dom` | `react-dom` (known limit: a React Native bundle is not a browser bundle) |
| depfit itself (`vite` as a tool) | none |
| Bun TUI, Bun CLI, two Node servers, a Cloudflare Workers API, a Bun resume builder, a TypeScript-only package, an Electron main-process app | none |

Exact workspace paths are kept with the probes (local, gitignored).

### Bar amendments (2026-11-05, user-approved)

Decided by the user on 2026-11-05 after seeing iteration 1's results (`STATUS.md`), each reviewed
by an independent reviewer (verdict in `STATUS.md`). The original text is kept in git history; the
lines changed above say "amended 2026-11-05".

1. **Gate S table, two rows.** The rule checks `index.html` in the workspace directory only. The
   static Preact site keeps its `index.html` in `app/` (Vite `root`), so its expected signals are
   `preact`; the Electron app with a React renderer has an `index.html` in its workspace
   directory, so its expected signals are `react-dom`, `index.html`. The table had contradicted the
   rule it cites; the rule and the detector are unchanged.
2. **Gates B and C on expected nulls.** A single-export case of the reference set that depfit
   returns as null is judged for honesty under gate A, not as a B or C accuracy failure, when it is
   listed in `single-nulls.json` and its build gives exactly the listed code and only the listed
   kind of specifier (in iteration 1: every export of the Node-only @inquirer/core and
   @inquirer/prompts, `UNRESOLVED_IMPORT` of Node built-ins only; 6 react-router exports whose Vite
   output keeps a computed `import()`, `IMPORT_OUTSIDE_BUNDLE import(…)`). Any other null, or a
   listed one with another reason, fails gate A until it is reviewed and listed, and the list waives
   nothing while its review is pending. Every selected case stays in the set and is reported. B's
   band and C's comparison apply to the measured cases; whole-package builds are unchanged. The
   rule that chooses the set is unchanged. Also a reviewed exception for react-hook-form
   `FormProvider` (single-export set), with its emitted code in
   `evidence/react-hook-form-FormProvider.md`: only the Vite output keeps 395 B of code the export
   does not use (bare member reads and the objects they read, which rolldown treats as possible side
   effects); without it the output is 924 / 425 B, inside the band, against depfit's 1319 / 592 B.
   A reviewed exception applies only after its review; a pending one waives nothing.
3. **server-only's reviewed exception re-recorded.** Its depfit gzip moved from 117 to 115 B when
   gzip moved into the Node child that runs Vite (`STATUS.md`); min bytes, references and cause are
   unchanged.
4. **One `unavailable` entry per cause.** When a cause (a reason code) makes both the whole build
   and some exports unmeasurable, the package gets one entry for it: the whole build's. The
   per-export summary counts and lists only exports and codes the whole build does not already
   report, and a listing failure is likewise reported only for new codes. This changes the code and
   the contract wording above; stop condition 5 is unchanged.
5. **`external_packages` lists only the peers the output imports** (decided 2026-11-05 after seeing
   the round-5 reports). It listed every declared peer, optional ones included, so valibot showed
   `typescript`, an optional types-only peer its JS never imports, and a reader could take it as
   "14.6 KB plus typescript". It now lists the peers that a measured build (the whole entry point or
   an export alone) still imports, by package name (a subpath import counts as its package), and is
   null when no build was measured. Peers stay external in every build as before; only what is
   reported changes. Schema 6 is unreleased, so this meaning change stays in schema 6.

### Holdout probes

10 browser questions, frozen on 2026-10-19 before any iteration-1 code, in `eval/probes.json`
with `"set": "holdout-1"` (local, gitignored). Their sha256 is recorded in `STATUS.md`. Ground-truth
snippets for them are written blind by agents, validated, and used by the eval only, as in round 4.

## Iteration 2: subpaths of the `exports` map, measured whole

Drafted 2026-11-06 before any iteration-2 code, then revised after an independent review (verdict
in `STATUS.md`). The evidence is in `eval/FINDINGS.md`, "Round 5 follow-up: subpaths".

This iteration adds fields to `packages[].bundle` and does not change the meaning of any existing
field; a failure while measuring subpaths never changes a root field. Bar amendment 6
(2026-11-07, below) replaced the full `subpaths[]` list in the default report with a compact map.
Iteration 1's gates A–F and S are rerun as regression checks. Gates R, H0 and H below replace
iteration 1's for this iteration's scorecard. The new gate L checks which subpaths are listed.

### When it runs

The same as iteration 1: only in a browser workspace, in the same Node child per package, after the
root entry point's builds. Subpaths are built even when the root's whole build is null, because a
package whose code lives in subpaths may have an empty root or no root at all. A
`TOOLCHAIN_MISMATCH` on the root stops every build, as it does now.

### Which subpaths

Read from the measured version's `package.json` in its isolated install. Vite treats an `exports`
field that is null or absent as no map (`if (data.exports)`), and depfit does the same.

- **Listed and measured:** each key that names one module. That means a key other than `"."`, with
  no `*`, not ending in `/`, and not `./package.json`, whose target ends in `.js`, `.mjs`, `.cjs`
  or `.jsx` when it is resolved the way Vite 8.3.4 resolves a production browser import. Vite
  resolves it with its bundled `resolve.exports` 2.0.3 (`unsafe: true`), using the conditions
  `module`, `browser`, `production` and `import`, plus `default`, matched in the order the
  package's object lists them. No other condition is added (no `react-server`, `worker` or
  `node`), as for the root. A string or array `exports` (the root only) lists none.
- **Not listed:** keys whose browser target is null, matches no condition (types-only or
  Node-only keys), or is not a JS file (CSS, JSON, wasm, `.d.ts`). The census classified these
  with a hand-written resolver: 129 of 1,365 keys (109 `./package.json`, 9 CSS, 6 JSON, 3 with no
  JS target for these conditions, 1 wasm, 1 other).
- **Pattern keys:** every key that contains `*` is reported verbatim, in map order, in
  `subpath_patterns_unmeasured`, whatever its target. Pattern keys are not expanded or measured. Per
  package, the patterns of the census match up to 492 JS modules (highlight.js 386, shiki 440, gsap
  117); single patterns match 0 to 451.
- **No `exports` map:** nothing is listed, because any file in the package can be imported
  (dayjs plugins, prism languages, `ol/*`). `exports_map` is false.
- **Build:** each listed key is built alone and whole, as `import * as m from "<name>/<key without
  ./>"` kept whole, which is the root's whole entry with the subpath as its source. It passes the
  same honesty checks and gets the same null codes. A failed build is never retried. Keys that
  resolve to the same file are built once and report the same bytes.
- **Cap:** the measurement code builds nothing for more than 100 listed keys, and gives
  `bundle: SUBPATH_LIMIT <count>`. The patterns are still reported. The default report's own cap
  is 30 (amended 2026-11-07; see the contract). Among the 288 manifests the
  research classified (the census plus the holdout-2 candidates at their npm `latest` on
  2026-11-06), only date-fns has more than 100 (739). The most after it are echarts with 100 and
  @base-ui/react with 78. The cap limits how much JSON a reader gets, not time. It sits above every
  package in the corpus except date-fns, whose keys are one module per function; it is a chosen
  boundary, not a measured one.
- **Whole only, no numbers per export** (unchanged from the iteration table). Real usage of the
  non-framework subpaths in the evidence was close to their whole: photoswipe `lightbox` with the
  root came to 1.07x real usage, and shiki `core` with `engine/javascript` to 1.05x. Measuring
  each export of every subpath would multiply the builds: 766 more for motion and 1,579 more for
  zod, against 350 and 259 for their roots. The framework subpath that overstates (`motion/react`,
  1.6x) is the target of the follow-up flags (#10). Add per-export numbers for subpaths in a later iteration only if
  gate R's class 4 or gate H shows readers need them.

### Contract (schema 6, unreleased; fields added, none changed, no version bump; amended 2026-11-07)

The default report shows the subpaths compactly (bar amendment 6, below). The full detail per
subpath (its lazy bytes, peers and codes, and lists of more than 30) is kept by the measurement
code for the follow-up flags (#10: `--entries`, `--exports`, `--import`). They are a separate
slice, not built here.

Added to `packages[].bundle`:

| Field | Meaning |
|---|---|
| `exports_map` | true when the measured version's package.json has a non-null `exports` field, false when it has none; null when the manifest could not be read |
| `subpaths_listed` | How many keys the listing rule admits; 0 when there is no map or the map lists none; null when the manifest could not be read |
| `subpaths_whole_eager_js_gzip9_bytes` | A map from each listed key (e.g. `"./lib/core"`, imported as `highlight.js/lib/core`) to the eager gzip -9 bytes of that subpath alone, every export kept: the root's `whole_eager_js_gzip9_bytes` for this entry point instead of `"."`. The CLI serializes its members in code-point order of the keys; a reader finds an entry by its key, never by its position. A value is null when that subpath's build is unmeasurable, and `unavailable` names the key with its codes (below). The field is: a populated map when 1 to 30 keys are listed and were built; `{}` when the listing is known and lists no key; null when there is no map, more than 30 are listed, the listing is unknown, or the keys could not be built (see the states below) |
| `subpath_patterns_unmeasured` | Every key of the map that contains `*`, verbatim and in map order; `[]` when there are none or there is no map; null when the manifest could not be read |

**The pattern list stays a list.** The 288 manifests have at most 6 pattern keys per package
(react-native), so no count is needed. Long pattern lists are a known limit (below).

**States** (whenever `bundle` itself is non-null; revised 2026-11-07 after the amendment's review).
The listing and the builds are separate steps, and the first decides the metadata. depfit reads
the installed package.json before any build, in its own process, not in the Vite child. So
`exports_map`, `subpaths_listed` and `subpath_patterns_unmeasured` come from the listing alone,
whatever happens to the builds: the listing's values when it was read, and all three null when it
was not. The map follows the first row that applies, in this order:

| # | Condition | `subpaths_whole_eager_js_gzip9_bytes` | Entry it adds to `unavailable` |
|---|---|---|---|
| 1 | Listing unknown (manifest unreadable) | null | `bundle: SUBPATH_LIST_FAILED <file> <error code>` |
| 2 | No map (`exports_map` false) | null | none |
| 3 | The map lists no key (`subpaths_listed` 0) | `{}` | none |
| 4 | More than 30 listed keys | null | `bundle: SUBPATH_LIMIT <n>` |
| 5 | The root's builds failed: `TOOLCHAIN_MISMATCH`, or the child crashed during them | null | none of its own; the root's entry explains it |
| 6 | The child crashed during the subpath builds | null | `bundle: BUNDLER_ERROR <message>`; root fields keep what was measured before the crash |
| 7 | Otherwise | the map | one group per code of a null value (below) |

Every distinct cause keeps exactly one entry. An unreadable manifest together with a root crash
gives two entries: `SUBPATH_LIST_FAILED` and the root's `BUNDLER_ERROR`. More than 30 keys together
with a root crash gives two as well: `SUBPATH_LIMIT` and the root's `BUNDLER_ERROR`. In both cases
the codes differ.

- **Cap in the default report: 30 listed keys.** Over 30, nothing is built for the default report
  and the map is null. The measurement code keeps its cap of 100 for `--entries`, so gates L, B and
  C, which use it, are unchanged. Each gate names the call it reads (gates, below). In the 288 manifests, these packages have
  more than 30: date-fns (739), echarts (100), @base-ui/react (78), @mui/utils (62) and storybook
  (49).
- **Each null value is explained in `unavailable`, one entry per code, naming the keys** (format
  revised 2026-11-07 after the amendment's review).
  - **The group.** For each code of a null value, `unavailable` holds one group,
    `<CODE> in subpaths <keys>`. `<CODE>` is the reason code (`[A-Z][A-Z_]*`). `<keys>` is a
    compact JSON array of every key that failed with that code, in code-point order, e.g.
    `UNRESOLVED_IMPORT in subpaths ["./node","./tty"]`. JSON escaping keeps any key unambiguous.
  - **Where the group goes.** When no root entry reports the code, the group is a new entry,
    `bundle: <group>`. When a root entry already reports it, the group is appended to that entry
    as `; <group>`. A root entry is the whole build's `bundle: <CODE> ...` entry, a listing entry,
    or the `bundle: <n> exports unmeasurable (<codes>)` summary, which reports every code in its
    parentheses. A code belongs to an entry when it is that entry's leading code or one of the
    summary's listed codes. Matching is on whole codes, never on substrings.
  - **Framing** (added 2026-11-07 after the amendment's second review, worded after its third).
    Free text in a `bundle:` entry is every name or message outside a group's JSON array:
    specifiers, module labels, file names and error messages. depfit writes it with `%`, `;` and
    `[` percent-encoded (`%25`, `%3B`, `%5B`). Keys inside a group's JSON array are not encoded;
    JSON escaping keeps them exact. So outside the arrays, the first `; ` starts the appended
    groups and a `[` can only open a group's key array. A key may contain `;`, `[` or `]`, and only
    the JSON parse of its array decides where that array ends.
  - **Parsing.** Groups appended to one entry come in code-point order of their codes, each after
    `; `. An entry that is itself a group starts `bundle: <CODE> in subpaths [`. A reader scans the
    entry from the start. On finding `bundle: <CODE> in subpaths [` or `; <CODE> in subpaths [`
    outside an array, it parses the complete JSON array that begins at that `[`, respecting
    strings and escapes, then resumes scanning after the array's closing `]`. Delimiters count only
    outside the arrays.
  - **What each null value gets.** It appears once per code it failed with: one group per
    `(key, code)` pair. Each code appears in only one entry per package, so one cause still gives
    one entry (amendment 4). A value whose build recorded no code counts as `BUILD_ERROR`. At most
    30 keys can be named.
- **The package-level `external_packages`** keeps its meaning: the peers of the root's builds.
  `schema-docs` says "root" explicitly, and the description of `entry_point` no longer says that
  every number in the section measures `"."`. The peers each subpath leaves out are detail
  for the follow-up flags (#10).
- **`schema-docs`** replaces "subpaths ... are not measured" with what is listed and what is not.
  It also says that each value is a build of that subpath alone, not added to the root's; that two
  values can share code; and that a subpath's lazy chunks and peers are not in the default report.
  New codes: `SUBPATH_LIMIT` and `SUBPATH_LIST_FAILED`.
- **Table:** the bundle section shows "Exports map" as yes, no, or `unknown` when the manifest
  could not be read. It shows "Subpaths, whole eager gzip" as up to 8 entries in key order
  (`./core 35.9 KB`, or `./react -` for a null one), then `+<n> more (--json)`. When there is no
  map, it shows one of: `none`, `not listed (no exports map)`, `over 30 (<n>)`, or `not
  measured (<code>)` for `TOOLCHAIN_MISMATCH`, `SUBPATH_LIST_FAILED` or `BUNDLER_ERROR`. It also
  shows "Subpath patterns, not measured" verbatim, or `unknown`. Gates H0 and H read the JSON.

### Gates

| Gate | Pass condition |
|---|---|
| **A. Honesty** | The iteration-1 null cases and `single-nulls.json` still return their codes. **Two calls** (amended 2026-11-07). (i) The measurement call with its cap of 100, `measureRootEntry(..., { subpaths: true })`, which keeps per-subpath results for the follow-up flags (#10), run over the B set and over every probe package on its frozen tree: every listed subpath that is null gives exactly the code listed below, and its kind of specifier is checked against the build's problems, which the eval keeps. (ii) The default report, where its map has values: every null value's key is named, with each of its codes, in the `unavailable` group format above. Any other null fails A until it is reviewed and listed, and the list waives nothing while its review is pending (amendment 2's rule, written here in advance). Subpath numbers in the B set have 0 gross errors. Every distinct cause has exactly one `unavailable` entry. |
| **B. Accuracy** | **Reference set** (frozen here, chosen by rule): the first 20 packages in `wild.json` order whose map lists at least one subpath. Each contributes up to 3 subpaths: all of them when there are 3 or fewer, otherwise the first, the middle (index ⌊(n−1)/2⌋) and the last of the sorted keys. That gives the 51 cases in 20 packages listed below; 8 are listed nulls and 43 are measured. The coverage check asserts these exact package, version and key tuples. Gate L's listing must give the same 51; any difference stops the gate for review rather than changing the set. Each case is built whole with rollup + terser and webpack (`reference.ts`) from one tree per package, frozen as an npm lockfile on its first reference build, and depfit measures the same lockfile. Every measured case is in band on both gzip fields (iteration 1's band) or covered by a reviewed exception, with 0 gross errors. Listed nulls count under A. |
| **C. Vite conformance** | B's 43 measured cases equal a stock `vite build` of the same import, made by `reference.ts` without depfit's code from the same lockfile: gzip within 1%, and min bytes identical. The gate reads min bytes from the build even though the report omits them. |
| **D. Determinism** | Two runs on the same frozen installs give identical results (amended 2026-11-07). The default report is compared over every probe: `exports_map`, `subpaths_listed`, `subpaths_whole_eager_js_gzip9_bytes` (its serialized member order and bytes), `subpath_patterns_unmeasured`, and reasons. The measurement call with its cap of 100 is compared over every probe package and the B set: the per-subpath bytes, peers and codes. |
| **E. Contract** (amended 2026-11-07) | (i) Fields: every package has every bundle field, the new ones included, in every state of the table above, and the states' precedence holds. (ii) Order: the map's members are checked on the CLI's serialized JSON text; they are in code-point order of their keys and the keys are unique. (iii) Correspondence, for every probe package whose map is populated (state 7: 1 to 30 listed keys, all built): the map has exactly the keys the listing rule admits. Each value equals that key's `whole_eager_js_gzip9_bytes` from the measurement call (cap 100) on the same frozen tree, null where that build is null. A null *value* is one member of a populated map. For each null value, the `(key, code)` pairs named in `unavailable` equal the codes of its failed build. In states 1 to 6 the whole map is null or `{}`, and E (i) checks the state table's fields and reasons instead. No key is named in any group then. (iv) Every `(key, code)` pair is named exactly once, and every code appears in only one entry per package. (v) Every new path is in `schema-docs`. (vi) Every non-bundle field is identical with `DEPFIT_BUNDLE=0`. (vii) Unit tests cover each state and their precedence, including a crash in the subpath phase that leaves the root's fields as measured. |
| **L. Listing** | (i) Fixed manifests in unit tests: `exports` absent, null, a string, an array, root-only conditions; conditions in different orders; array targets; a null target; types-only and Node-only keys; CSS, JSON and wasm targets; a trailing-`/` key; `./package.json`; two keys aliasing one file; pattern keys with JS, non-JS and null targets; and 100 vs 101 listed keys. Each must give the listing, patterns and state this section defines. (ii) Corpus: depfit's listed keys and pattern keys, computed before the cap, equal an independent listing for each of the 288 manifests: the 59 probe packages and 200 wild packages at their frozen versions, and the 29 holdout-2 candidates at the versions frozen for them (holdout section). The gate makes that listing with `resolve.exports` 2.0.3, installed by the eval, under the rule above. 0 differences. |
| **F. Cost** | In a workspace with no browser signal, Vite is never loaded (unchanged). In a browser workspace, the call timed is the default report's (amended 2026-11-07): the CLI's own call, which builds at most 30 subpaths per package, and none when more are listed. Per package, on frozen installs, the subpath time is the sum of two intervals (boundary revised 2026-11-07 after the amendment's second review). The first is the one manifest read and listing the call makes, before any build. The second runs from the end of the root phase to the subpaths' final state. When the root phase aborts, only the first interval counts. It is timed even when no subpath is built (no map, an empty map, over the cap, or a listing failure). The population is every candidate of every probe at its frozen version, each counted per probe. The percentiles are taken on the sorted list, zero-based: the median at index ⌊n/2⌋, p90 at ⌊0.9n⌋. Budgets: median at most 250 ms and p90 at most 1 s; the max is reported. These are budgets, not measured limits. Round 5's 65 candidates measured a median of 0 ms (40 build no subpath), a p90 of 58 ms and a max of 0.95 s (shiki, 10 subpaths). The bundle step including subpaths stays within iteration 1's median of 1.5 s per package. No call builds more than 100 subpaths, and the default report builds at most 30 per package. |
| **S. Browser signal** | Unchanged; rerun. |
| **R. Real usage** | Scored by the algorithm below on the default report, over the round-4, holdout-1 and holdout-2 probes. Fresh scores, and the pair denominator, are reported overall and for each set. The round-5 figures quoted here (58/64 in range, 48/48 pairs) came from the research simulation under the full-list contract with a cap of 100: they are history, not a prediction (amended 2026-11-07). (a) Real usage lies in `[0.9 × L, 1.1 × U]` for at least 85% of candidates (85% as in iteration 1). (b) Take the pairs in one probe where L and U point the same way and real usage differs by at least 10%: real usage agrees in at least 90% of them; when no pair qualifies, (b) is reported as 0/0 and does not fail. (c) Listing coverage: every imported subpath that the listing rule admits, of a package with at most 30 listed keys, is a key of `subpaths_whole_eager_js_gzip9_bytes`, and a null one is a listed null under A. Imported subpaths of packages over 30 are counted and reported separately. This must hold for 100%. (d) Every miss falls into a class below, and any other miss fails the gate. |
| **H0. Comprehension** | A blind Haiku reader with only the JSON and `--schema` answers iteration 1's 5 questions and 6 new ones correctly in 3/3 runs (amended 2026-11-07). The new questions: (6) what a value of `subpaths_whole_eager_js_gzip9_bytes` includes, and that it is a build of that subpath alone, not added to the root's; (7) where the number for `highlight.js/lib/core` is, and that `highlight.js/lib/languages/typescript` has no number of its own, so its standalone size is unknown; (8) what `exports_map: false` means for importing `dayjs/plugin/relativeTime`; (9) why a value is null (`@formkit/auto-animate` `./react`, named in `unavailable`); (10) what adding two values gives: a figure that can count their shared code twice; (11) what a null map with `subpaths_listed: 739` means for date-fns: more than 30 subpaths, none measured in this report, not "no subpaths" (question 11 added 2026-11-07). The reports are iteration 1's three, plus a browser workspace with highlight.js, shiki, @formkit/auto-animate, dayjs and date-fns (over the cap). |
| **H. Decisions** | A blind eval on all 32 probes. The control is the iteration-1 CLI (`7b30612`) run on the same frozen installs, with its own `--schema`. Sonnet reads the control; Sonnet and Haiku read the iteration-2 report and schema. There are 0 misreadings of what a number measures. Misreadings include: taking a subpath value as added to the root's; taking a pattern subpath or an add-on with no map as measured; and taking a null map over 30 as "no subpaths" (the last added 2026-11-07). Every decision that differs from the control is reviewed against real usage and the facts. None is worse unless its cause is a known limit below. |

**Gate R algorithm.** For each candidate whose real usage has a number:

1. **Imported entry points:** the sources of the import declarations in its normalized
   ground-truth snippet that name the candidate or one of its subpaths, side-effect imports
   included, each counted once. Bytes are eager gzip on both sides, as in iteration 1.
2. **What each entry point gives:**
   - The root gives a lower number (the single-export median) and an upper one (the whole).
   - A key of `subpaths_whole_eager_js_gzip9_bytes` with a number gives that number as both
     (amended 2026-11-07).
   - Any other entry point gives nothing: a key whose value is null, a subpath of a package whose
     map is null (more than 30 listed keys), a pattern match, or a module of a package with no map.
     The entry point is recorded as uncovered.
3. **L and U:** L is the largest lower number and U the sum of the upper numbers, over the entry
   points that give numbers. When none gives numbers, the root's numbers apply, as in iteration 1.
   A null number, such as a root median that is null over iteration 1's export cap, makes the
   candidate a miss. That miss is classified like any other.
4. **Pairs** use only candidates whose L and U are both non-null, as in iteration 1.

Every candidate with a real-usage number is in the denominator of (a), covered or not.

**B reference set** (package@version from `wild.json`: keys):

| Package | Keys |
|---|---|
| vite@8.3.4 | `./internal`, `./module-runner` |
| react@19.3.1 | `./compiler-runtime`, `./jsx-dev-runtime`, `./jsx-runtime` |
| jose@6.2.12 | `./base64url`, `./jwt/decode`, `./key/import` |
| htmlparser2@12.0.0 | `./WebWritableStream`, `./WritableStream` |
| fflate@0.8.3 | `./browser`, `./node` |
| react-refresh@0.19.0 | `./babel`, `./runtime` |
| @opentelemetry/api@1.9.1 | `./experimental` |
| reflect.getprototypeof@1.0.10 | `./auto`, `./implementation`, `./shim` |
| dompurify@3.4.17 | `./dist/purify.js`, `./dist/purify.min.js`, `./purify.min.js` |
| @testing-library/jest-dom@7.0.1 | `./jest-globals`, `./matchers`, `./vitest` |
| react-router@8.4.0 | `./dom`, `./internal/react-server-client`, `./route-pattern` |
| framer-motion@14.3.0 | `./animate-view`, `./dom`, `./projection` |
| react-redux@9.3.0 | `./alternate-renderers` |
| postcss-js@5.1.0 | `./async`, `./parser`, `./sync` |
| preact@11.0.1 | `./compat`, `./compat/server.browser`, `./test-utils` |
| classnames@2.5.1 | `./bind`, `./dedupe`, `./index.js` |
| ua-parser-js@2.0.10 | `./bot-detection`, `./device-detection`, `./helpers` |
| hastscript@9.0.1 | `./jsx-dev-runtime`, `./jsx-runtime`, `./svg/jsx-runtime` |
| @reduxjs/toolkit@2.13.0 | `./query`, `./query/react`, `./react` |
| cheerio@1.2.0 | `./slim`, `./utils` |

**Expected nulls for gate A** (found with the current engine before any iteration-2 code; the B
set from fresh installs of its pinned versions, the probe packages from round 5's frozen trees):

| Package | Subpaths | Code, kind of specifier |
|---|---|---|
| vite | `./internal` | `UNRESOLVED_IMPORT`, Node built-ins |
| vite | `./module-runner` | `IMPORT_OUTSIDE_BUNDLE`, `import(…)` |
| htmlparser2 | `./WritableStream` | `UNRESOLVED_IMPORT`, Node built-ins |
| fflate | `./node` | `UNRESOLVED_IMPORT`, Node built-in (`module`) |
| react-refresh | `./babel` | `UNRESOLVED_IMPORT`, Node built-in (`crypto`) |
| @testing-library/jest-dom | `./jest-globals` | `UNRESOLVED_IMPORT`, an undeclared package (`@jest/globals`) |
| react-router | `./dom`, `./internal/react-server-client` | `IMPORT_OUTSIDE_BUNDLE`, `import(…)` |
| @formkit/auto-animate | `./angular`, `./nuxt`, `./preact`, `./react`, `./solid`, `./vue` | `UNRESOLVED_IMPORT`, its undeclared framework (`@angular/core`, `@nuxt/kit`, `preact/hooks`, `react`, `solid-js`, `vue`) |
| fuse.js | `./worker` | `NON_JS_IMPORT`, a worker |
| micromark | `./stream` | `UNRESOLVED_IMPORT`, Node built-in (`node:events`) |
| marked | `./bin/marked` | `UNRESOLVED_IMPORT`, Node built-ins |

**Miss classes for gate R** (written before any iteration-2 run). Each is assigned from the
ground-truth snippet's shape and the listing, checked in this order:

- **Class 3:** real usage goes through a framework subpath (`motion/react`,
  `@formkit/auto-animate/react`), matched by iteration 1's regex. Subpaths are measured whole, so
  these can miss, and an undeclared framework peer makes them null. Left to the follow-up flags (#10).
- **Class 1a:** real usage imports a module other than the root from a package with no `exports`
  map (dayjs plugins, `prismjs/components/*`, `@atlaskit/pragmatic-drag-and-drop/*`, `ol/*`). Out
  of scope.
- **Class 1b:** real usage imports a subpath that only a pattern key matches
  (`highlight.js/lib/languages/*`, `gsap/Flip` through gsap's `./*`, `three/addons/*`). Patterns
  are not expanded. gsap 3.15.1 does have an `exports` map, of pattern keys only, although the
  out-of-scope line above lists gsap's Flip as an add-on without one.
- **Class 1c:** real usage imports a subpath of a package with more than 30 listed keys (the
  default report's cap; amended 2026-11-07).
- **Class 4:** real usage keeps some named exports of a listed subpath and lies below 0.9 × L
  (one locale of `date-fns/locale`, a few chart types from `echarts/charts`). Subpaths are
  measured whole only.
- **Class 2:** real usage keeps members of one namespace-like export (zod). Unchanged.

Any other miss fails the gate. In particular, real usage above 1.1 × U fails it when every
imported entry point gives numbers.

**Known limits for gate H** (written before any iteration-2 run):

- The numbers are standalone, not marginal. Marginal bytes are parked in #6 as an idea.
- Subpaths are measured whole only, so a subpath used for a few of its exports shows its whole
  size.
- Framework subpaths are measured whole, and an undeclared framework peer makes them null
  (left to the follow-up flags, #10).
- Pattern keys are not expanded, and a package with no `exports` map lists no subpaths (gsap's
  Flip, highlight.js languages, dayjs plugins).
- Each entry point is its own build, so the sum of two entry points' numbers can count their
  shared code twice.
- A package with more than 30 listed subpaths shows none in the default report (date-fns, echarts;
  amended 2026-11-07).
- The default report gives each subpath's eager bytes only. Its lazy chunks, its peers and the codes
  of each null are detail for `--entries` (#10); `unavailable` names each null key with its code (added
  2026-11-07).
- Pattern keys are listed in full; a package with many of them would show a long list (added
  2026-11-07).

### Bar amendment 6 (2026-11-07, user-approved): a compact map in the default report

Decided by the user on 2026-11-07, after the product direction changed and before any
iteration-2 result existed. No iteration-2 number had been computed for the probes, the B set or
the holdout. The only runs were the holdout-2 freeze and the control run with the iteration-1 CLI.
The direction is the spec "Overview + follow-ups" ([#6](https://github.com/rigomart/depfit/issues/6)):
depfit's default report stays compact, and an agent gets detail through the follow-up flags
([#10](https://github.com/rigomart/depfit/issues/10): `--entries`, `--exports`, `--import`).
Iteration 2 is that spec's first slice
([#9](https://github.com/rigomart/depfit/issues/9)). An independent reviewer checked this
amendment before any iteration-2 result on the report gates (verdict in `STATUS.md`). Its first
review found five must-fix gaps, and they were fixed the same day. Those fixes are part of this
amendment: the states' precedence, the parseable `unavailable` format, correspondence in E, the
call each gate reads, and fresh R scores. A second review found two more must-fix gaps, also fixed
the same day: E's correspondence applies only to a populated map, and free text in `bundle:`
entries is percent-encoded so a root payload can never look like a group. It also asked for a
complete timing boundary for F. A third review approved with one wording change, now made:
percent-encoding applies to free text outside the group arrays, and parsing resumes after each
complete array. Between the first review and the fixes, gate L and gates
A, B, C and D on the B set had been scored, and all passed. The fixes changed A's report-format
check and named the call each gate reads, so those gates are rerun on the final code. No report
gate (E, R, H0, H) had run. The lines changed above say
"amended 2026-11-07"; the original text is in git history.

1. **The default report gets a compact map instead of `subpaths[]`.** The map is
   `subpaths_whole_eager_js_gzip9_bytes`, from entry point to whole eager gzip bytes, together with
   `subpaths_listed`. `exports_map` and `subpath_patterns_unmeasured` stay. Above 30 listed keys the
   map is null and `subpaths_listed` still gives the number. That is the default report's cap. The
   measurement code keeps its cap of 100, for `--entries`.
2. **Each null value is explained in `unavailable`, one entry per code, naming the keys.** Each
   group names the keys as a JSON array, and the parse rule is written down. This replaces the
   `bundle: <n> subpaths unmeasurable (<codes>)` summary. A code a root entry already reports is
   appended to that entry, so amendment 4 (one entry per cause) still holds.
3. **What leaves the default report:** each subpath's lazy bytes, peers and codes, and any list
   beyond 30. The measurement and listing code keep them for the follow-up flags (#10), which are not
   built here.
4. **Gates.**
   - Unchanged: L, B, C, F's budgets, S, and the frozen holdout-2.
   - A and D keep their coverage through the measurement call with its cap of 100, which runs
     over the B set and every probe package. They also check the default report wherever it has
     values. Each gate names the call it reads.
   - F times the default report's call, which builds at most 30 subpaths per package.
   - E checks the new fields, the states and their precedence, and the serialized order. It also
     checks that the report's map matches the measurement call exactly: its keys, its values, and
     the codes of each null.
   - R reads the map, and its coverage and class 1c use the cap of 30. Its round-5 figures are
     marked as history, and fresh scores are reported for each set.
   - H0's subpath questions read the map, and question 11 asks about a null map over 30.
   - H adds one misreading: a null map over 30 taken as "no subpaths".
   - Known limits gain the lazy bytes and peers that move to the follow-up flags (#10), and long pattern lists.
   - No gate was dropped.
5. **The iteration table is superseded after iteration 2** by #6 (note under the table).
6. **The single-export median stays in the default report** until #6's three-way eval decides it.

### Holdout probes (holdout-2)

**Questions, frozen 2026-11-06 before any iteration-2 code.** There are 10 browser questions in
`eval/probes.json` with `"set": "holdout-2"` (local, gitignored), appended after every earlier
probe. Their sha256 is in `STATUS.md`. A rule stated before any iteration-2 measurement chose
them:

- They come from 8 of the 9 local browser projects.
- Each names 2 or 3 candidates, 29 in all, and none was a candidate in an earlier probe.
- 8 of the 10 questions name a candidate whose map lists a subpath by the rule above, so the
  iteration's target is exercised. This was checked from npm metadata on 2026-11-06. The other 2
  test the root claims on fresh packages.

**Measurement inputs, frozen before the first iteration-2 measurement of these probes.** This is a
separate preparation step, done in this order:

1. For each project, record its git revision with the probes (local), and measure at that
   revision.
2. The ground-truth snippets are written blind: one agent per project reads the project's source
   and the question and sees no sizes. They are validated, then frozen in `eval/snippets.json`,
   with their sha256 in `STATUS.md`.
3. One collection run with the iteration-1 CLI (`7b30612`) and `--locks` records each candidate's
   resolved version and install tree. That run is also gate H's control. The lock files' sha256 go
   in `STATUS.md`.

Every iteration-2 gate that uses holdout-2 (L, R, D, E, F, H) uses these frozen versions and trees.
Iteration 1's ground-truth rules apply: side-effect `.css` imports are removed, and a candidate
whose real usage is null is listed and left out.

## Stop conditions

Unchanged from v1. If one shows up, stop and reassess with the user instead of patching forward:

1. **A silent wrong number** reaches the output: badly off and with no code.
2. **Case-shaped fixes:** a setting, special case or retry added to pass one case, without a general
   rule written down before seeing that case's numbers.
3. **The bar moves to fit:** a gate, band, case, threshold, miss class or known limit changed after
   seeing results, without an independent reviewer agreeing it was wrong. Two such changes in one
   iteration means stop.
4. **Code grows faster than scope.**
5. **Noise in `unavailable`:** more than one bundle entry per package for one cause.
6. **Readers misread a field** in gate H0 or H.

## Parallel builds (#7): acceptance bar

Drafted 2026-11-08, awaiting the user's approval. #7 makes a first overview in a browser workspace
faster and changes no number, field or reason. Measurements behind every target are in
`STATUS.md` ("Parallel builds (#7): measurements for the bar").

### What changes

- **One pool of Vite worker processes per depfit run, shared by every candidate.** Each worker is
  today's `vite-build.mjs` child on Node, with today's clean environment, and builds one request at
  a time. Every build of a candidate goes through the pool: the root's whole build, the two export
  listing builds, each export alone, and (once #9 merges) each subpath whole. Today each candidate
  has its own child and builds one after another in it, and candidates already run at the same time
  (one child each).
- **Workers start as soon as the workspace shows a browser signal**, while the registry lookups and
  installs run, so Vite's start-up (about 90 ms per worker) is off the critical path. Builds already
  start as soon as a candidate's install is done and already run alongside the OSV, GitHub and
  download lookups (measured: those lookups end by about 2.2 s, the builds at 4 to 10 s). So the
  speed-up comes from the pool; #7 does not claim more overlap than this.
- **The order of a candidate's phases stays a dependency, not a schedule.** The export builds use
  the names the listing builds give, and nothing after the whole build is reported when that build
  gives `TOOLCHAIN_MISMATCH`. A build may start earlier only if its result is discarded whenever
  today's code would not have made it.
- **No two builds in flight share an entry file.** Today one `__depfit_entry.mjs` per install is
  rewritten before each build, which concurrent builds would overwrite. The entry file keeps its
  name: a per-worker file name changed lazy bytes by 2 B (@storybook/addon-a11y, whose lazy chunks
  name the entry chunk), and an entry outside the install root changed biome's `NO_ENTRY` into
  `UNRESOLVED_IMPORT` (the check compares the importer with the entry's path). Same name in a
  per-worker directory gave identical results once the entry check knows that path.

### Worker count and memory

- **Workers:** `min(4, os.availableParallelism())`, at least 1. Measured on 12 cores: zod's builds
  took 2.9 s at 4 workers, 2.7 s at 6 and 3.0 s at 8; four candidates took 9.2 s at 4 and 8.7 s at
  6, for about 900 MB more. Rolldown already uses several threads per build.
- **An eval and CI switch `DEPFIT_BUNDLE_WORKERS=<n>`** sets the count (1 or more), like
  `DEPFIT_BUNDLE` and `DEPFIT_LOCK_DIR`, and AGENTS.md lists it with them. The gates below use it.
- **A worker is replaced after at most 100 builds.** A worker's memory grows with every build and is
  not given back (motion: 632 MB after 100 builds, 1.5 GB after 500, 2.3 GB after 1000; with a 384 MB
  heap cap it runs out at about build 570). One shared worker would otherwise do every build of every
  candidate, more than any process does today. Recycling at 100 builds cost about 5% (four
  candidates: 9.7 s against 9.2 s) and kept results identical.
- **Memory bar:** on the calls in gate P2, no worker's resident memory exceeds 1 GB, and the summed
  peak of all workers on the four-candidate call is at most today's peak for that call (measured
  today 3.0 to 3.1 GB; pool with recycling 2.6 GB). A single large candidate may use more than today
  (motion: 1.5 GB today, 2.5 GB with 4 workers), and that is accepted.

### Gates

"Today" is the sequential code at #7's parent commit (main after #9 merges), run on the same machine
on the same day. Times are taken with no other build running on the machine, as the median of 3
runs, on the frozen installs (`DEPFIT_LOCK_DIR`) and a warm npm cache.

| Gate | Pass condition |
|---|---|
| **P1. Same results** | (a) **Every build of every reference package:** for each package in `single-reference.json`, every export (not only the 5 listed), the whole build and the listing; every root null case in `cases.json`; and, after #9, every package in `subpath-reference.json`. Each outcome (bytes, the set of problems, `external_packages`, export names and counts, and the `unavailable` entries) is identical to today's, at `DEPFIT_BUNDLE_WORKERS` 1, 2 and 4, and once with the build queue in reverse order. (b) **Two cases the reference sets lack:** a package whose builds emit lazy chunks (@storybook/addon-a11y, frozen) and biome (`NO_ENTRY`), identical in the same way. (c) **Full reports:** in `test/fixtures/browser-app`, the calls `valibot`, `zod`, `date-fns`, `motion`, `zod valibot`, `valibot zod date-fns motion`, and one with a built-in and a name that does not exist, on frozen installs: today's CLI and #7's run alternately (today, #7, today, #7); each #7 report is identical to the today report run before it, apart from `generated_at`. If a field fed by the network differs, the pair is run again; the two today runs agreeing while #7 differs fails. (d) Gates C and D as CI runs them (`ci/bundle-accuracy.ts`, two runs) pass unchanged. |
| **P2. Speed, this machine** | Bundle step alone (the measurement call, no network), default worker count (4 here). **Per package:** valibot, zod, date-fns and motion each at most 0.6x today (measured 0.32x, 0.55x, 0.44x, 0.45x). **Several packages:** `zod valibot` at most 0.75x today (measured 0.66x); `valibot zod date-fns motion` at most 0.9x today (measured 0.79x to 0.84x), since today already gives each candidate its own process. **One worker:** each package at most 1.1x today (measured 1.00x to 1.05x). CLI wall time is reported, not gated; expected about 4.7 s for zod (today 7.1 to 7.7), 5.6 s for motion (10.7), 5 s for `zod valibot` (7.2), against 1.0 to 2.6 s without bundle facts. |
| **P3. Workers and memory** | The count rule and recycling above, each with a test. The memory bar above, measured on P2's calls. P1(a) passes at 1 and 2 workers. With 1 or 2 workers, several candidates can be slower than today (on 12 cores: `zod valibot` 9.0 s at 1 worker against 5.8 s; all four 13.8 s at 2 workers against 11.6 s). That is accepted: those counts are chosen only on machines reporting 1 or 2 CPUs, where today's one process per candidate shares the same CPUs (not measured). |
| **P4. Robustness** | Each with a test using a stand-in runner (as `test/fixtures/runner/` does today): (a) **Timeout:** the 5-minute limit counts from when a worker takes the build, not from when it was queued; a build over it ends its worker. (b) **Crash:** when a worker exits, hangs past the limit or prints an unreadable result mid-build, that build's candidate gets exactly what today's code gives for a crash in that phase (root phase: `bundle` all null and one `bundle: BUNDLER_ERROR <message>`; subpath phase: the root's results kept and the subpaths' `BUNDLER_ERROR`); its other builds in flight or queued are discarded; every other candidate's results are identical to a run without the crash; a new worker takes the remaining work. (c) **A worker that fails to start** gives `BUNDLER_ERROR` to the candidates that needed it, and the run ends. (d) **Every child stops:** after a normal run, a run where a candidate fails, a worker crash, and SIGINT or SIGTERM to depfit, no `vite-build.mjs` process is left and depfit exits without waiting on idle workers. (e) **No browser signal:** no worker is started, and Vite and rolldown are never loaded (iteration 1 gate F's tracer, plus no `vite-build.mjs` process). |
| **P5. Contract and CI** | No field, reason text or `SCHEMA_VERSION` changes; `schema-docs` unchanged. Type check, lint, unit tests, `ci/e2e.ts` on Bun and Node 22, and `ci/bundle-accuracy.ts` pass. A test fails if the pool stops running builds at the same time (a stand-in runner that waits per build: 8 builds on 4 workers finish in well under 8 waits), because CI's 2x gate alone would not catch losing the speed-up. |

### Earlier cost gates under the pool

- Iteration 1 gate F (median added time at most 1.5 s per package) is unchanged and is rerun.
- Iteration 2 gate F times the subpath phase "from the end of the root phase to the subpaths' final
  state". With a pool those phases overlap, so it is measured at `DEPFIT_BUNDLE_WORKERS=1`, where
  they run in today's order, with its budgets unchanged. Subpath builds keep their per-target dedupe
  (one build per target file per candidate) and their crash rule.

### CI's performance baseline

The 2x gate only catches a slowdown, so the speed-up needs a new baseline:

1. #7's pull request runs CI with the old baseline; the job summary shows the drop (expected on the
   gated `bundle.measure.framer-motion` and `bundle.measure.total`, from 36.0 s and 73.6 s). No CI
   target is set: CI's runners have 4 vCPUs and the speed-up was not measured there.
2. The agent that builds #7 re-records it as `ci/README.md` says, from two CI runs of the pull
   request's final commit (`gh run download`, `bun ci/perf.ts record runs/1 runs/2`), and commits it
   in the same pull request with the old and new value of each gated metric in its description.
3. The user approves the new baseline when approving the pull request.

### Out of scope

- Caching (#8), and any field, reason or schema change.
- Build settings, `EXPORT_LIMIT`, the subpath caps, and multi-entry builds (still not allowed:
  iteration 1).
- Making installs or lookups faster, or running a build in a worker thread instead of a process.

### Stop conditions

Iteration 1's, plus: any byte or reason that differs from today's in P1 stops the work. There is no
tolerance and no exception list for #7.

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

Drafted 2026-11-08 and approved by the user on 2026-11-08, after four independent reviews (Codex
gpt-6.1-sol, high effort; the last: approve with changes, applied). The user approved these
trade-offs explicitly: 4 workers where today runs one process per candidate above four candidates;
extra CPU up to about 1.23x, traded for speed; iteration 2's subpath cost gate re-measured with its
own bound for the default call; higher memory for a single package (zod 1.1 to 2.3 GiB) and lower
across several. #7 makes a first overview in a browser workspace
faster and changes no number, field or reason. Measurements behind every target are in
`STATUS.md` ("Parallel builds (#7): measurements for the bar"). They cover the default report's whole
operation as merged in #9 (c0e2a5d): the whole build, both listing builds, every export, and each
listed subpath (at most 30).

### What changes

- **One pool of Vite worker processes per depfit run, shared by every candidate.** Each worker is
  today's `vite-build.mjs` child on Node, with today's clean environment, and builds one request at
  a time. Every build of a candidate goes through the pool: the root's whole build, the two export
  listing builds, each export alone, and each listed subpath whole (#9). Today each candidate
  has its own child and builds one after another in it, and candidates already run at the same time
  (one child each, with no limit).
- **Workers start on demand.** The first starts when the first npm candidate begins its install, so
  Vite's start-up (about 90 ms) overlaps the install; another starts only when a build is queued and
  every running worker is busy, up to the worker count. A call that installs no npm candidate (only
  built-ins, or every name fails to resolve) starts none. A small package starts no more workers
  than it has builds waiting (clsx with four workers started at once used 0.64 s of CPU and 359 MB,
  against 0.26 s and 105 MB today).
- **No further overlap is claimed.** Builds already start as soon as a candidate's install is done
  and already run alongside the OSV, GitHub and download lookups (measured: those lookups end by
  about 2.2 s, the builds at 4 to 10 s). The speed-up comes from the pool.
- **No two builds in flight share an entry file, and the entry keeps its name.** Today one
  `__depfit_entry.mjs` per install is rewritten before each build, which concurrent builds would
  overwrite. A per-worker file name changed lazy bytes by 2 B (@storybook/addon-a11y, whose lazy
  chunks name the entry chunk). The same name in a per-worker directory under the install gave
  identical bytes, but turned biome's `NO_ENTRY` into `UNRESOLVED_IMPORT` until the entry check
  (which compares the importer with the entry's path) knows that path.

### Each candidate's result is today's result

Builds may run in any order and at the same time, but each candidate's result is defined by
today's order of its builds: the whole build; the two listing builds; each export in sorted order;
then each listed subpath in key order, once per target file (#9). Today's code stops at the
first build that fails to run (a worker that exits, times out or prints an unreadable result); so
does the result under the pool:

- **The first such failure in today's order decides the result, whatever finished first.** Two
  failures give the message of the earlier one in today's order, never the one that happened first.
- **A failure in the root phase** gives exactly today's crashed result: `rootEntryFacts` of an empty
  measurement (`bundler`, `target` and `entry_point` kept, every number null), on #9 with the
  subpath state `unbuiltSubpaths` gives (so `SUBPATH_LIST_FAILED` and `SUBPATH_LIMIT` keep their own
  entries), and `bundle: BUNDLER_ERROR <message>` first.
- **A failure in a subpath build** keeps every root result (root builds still in flight or queued are
  completed) and gives the subpaths iteration 2's `BUNDLER_ERROR`.
- **Builds that today's code would not have run** after the deciding failure, or after a whole build
  with `TOOLCHAIN_MISMATCH`, may have run early; their results are discarded and never reported.
- Other candidates are untouched: their results equal a run without the failure.

### Worker count, load and memory

These are provisional operating choices backed by the measurements below, not limits proven for
every machine; the preflight before code checks them again.

- **Workers: `min(4, max(floor(os.availableParallelism() / 3), candidates))`,** where `candidates`
  is the number of npm candidates in the call (at least 1; workers still start only on demand, so a
  candidate that fails to resolve starts none). 12 cores: 4. On 4 cores (CI's runners): 1 for one
  candidate, as today; 2 for two; at most 4. For up to 4 candidates the floor keeps today's
  concurrency, one process per candidate, so a small machine runs as many builds at once as today
  (its speed there is not measured); above that floor the pool adds at most one worker per three
  cores. Above 4 candidates the pool runs 4 workers where today runs one process per candidate: on
  12 cores six candidates took 0.88x today's time with less memory; on a small machine this was not
  measured, and the cap is a trade-off of speed for memory and load there. The rule budgets cores, not only speed, because depfit runs in agent loops, often
  on laptops:
  - A worker is not one core. Rolldown builds on several threads: one worker kept 2.9 (zod) to 4.0
    (motion) cores busy on average, and 4 workers 5.0 to 9.4 of 12. Dividing by 3 keeps the expected
    busy cores near the machine's count and leaves it usable during a call.
  - With as many workers as candidates the pool matched today on this machine (`zod valibot` at 2
    workers: 0.96x the time, 1.03x the CPU, less memory; zod at 1 worker: 1.03x the time, 1.02x the
    CPU). That stands in for a small machine, where it was not measured.
  - The pool does more computational work, a cost traded for speed, not noise: CPU time per call
    was 1.02x to 1.23x today's on calls of 250 builds or more (the most for valibot, whose builds are
    tiny and whose four workers each pay Vite's start-up; its runs vary by under 3%), and 0.47 s against
    0.23 s for clsx (6 builds, 3 workers started). CPU
    time is computational work, not temperature, which was not measured; the laptop did run hot
    during a 1 to 8 worker sweep.
  - Above 4 workers buys little and costs memory: zod's builds took 2.9 s at 4 workers, 2.7 s at 6
    and 3.0 s at 8; four candidates 9.2 s at 4, 8.7 s at 6 and 8.5 s at 8, for about 900 MB more per
    two workers (measured under load, without the listing builds, before this rule).
  - Repeated calls in an agent loop are what caching (#8) removes; until then every call rebuilds.
- **An eval and CI switch `DEPFIT_BUNDLE_WORKERS=<n>`** sets the count (1 to 4) in place of the
  rule, like `DEPFIT_BUNDLE` and `DEPFIT_LOCK_DIR`, and AGENTS.md lists it with them.
- **A worker is replaced after at most 100 builds.** A worker's memory grows with every build and is
  not given back (motion: 632 MB after 100 builds, 1.5 GB after 500, 2.3 GB after 1000; with a 384 MB
  heap cap it ran out at about build 570). One shared worker would otherwise do every build of every
  candidate, more than any process does today. A retiring worker counts toward the worker count until
  it has exited.

### Gates

"Today" is the sequential code at #7's parent commit (c0e2a5d, or the main it is rebased on), on the
same machine and day. Every performance gate (P2, P3) is at least 5 pairs of runs that
alternate today's code and #7's (today, #7, today, #7, ...), judged on the medians, with no other
build running on the machine, under `nice -n 10`, on frozen installs (`DEPFIT_LOCK_DIR`) and a warm
npm cache. Every individual run's time, CPU time, memory, versions, locks and output are kept with
the scorecard. CPU time is user plus system time of depfit and every child it waited for. Memory is
the peak of samples every 100 ms of depfit's own process and every process it started (recorded by
PID when started), per process and summed.

The prototype measurements in `STATUS.md` already run on c0e2a5d with subpath builds, start workers
on demand and wait for a retiring worker to exit before its replacement starts, but have 3 pairs
(2 for two calls). The scorecard repeats every P2 and P3 measurement on the implementation with at
least 5 pairs. If one misses its target, the work stops and goes back to the user; the targets are
not moved to fit. CI's check (P5 and the baseline below) is separate and follows its own protocol.

| Gate | Pass condition |
|---|---|
| **P1. Same results** | Compared in full, not by reference values: each candidate's complete measurement (whole outcome, export names, listing problems, every export's outcome, every subpath's outcome, and the subpath state: map, listed count, patterns and reason), with problem lists compared as sets because their order follows Vite's resolution order, and the serialized report. (a) **Every reference package:** every package in `single-reference.json` (every export, not only the 5 listed), every root case in `cases.json` (biome's `NO_ENTRY` among them, with its exact reason list), every package in `subpath-reference.json` (every listed subpath, not only the ones it lists, and the nulls in `subpath-nulls.json` with their exact reasons); plus @storybook/addon-a11y, frozen, the one case whose builds emit lazy chunks (no reference set has one). Today's measurement against #7's at `DEPFIT_BUNDLE_WORKERS` 1, 2 and 4, at 1 and 4 again with the build queue reversed, and twice at the default count. All identical. (b) **Full reports:** in `test/fixtures/browser-app`, the calls `clsx`, `valibot`, `zod`, `date-fns`, `motion`, `zod valibot`, `valibot zod date-fns motion`, `node:sqlite` alone, and one with a name that does not exist, on frozen installs, alternating today's CLI and #7's: each #7 report identical to the today report before it, apart from `generated_at`. If a field fed by the network differs, the pair is run again; two today runs agreeing while #7 differs fails. (c) Stock-Vite conformance as `ci/bundle-accuracy.ts` checks it, for the root and for subpaths (gate C), passes unchanged. (d) Iteration 1's and iteration 2's gate D are rerun at the default count with their full populations: two default reports over every probe (the subpath map in its serialized member order and bytes, `exports_map`, `subpaths_listed`, `subpath_patterns_unmeasured`, `external_packages`, codes and reasons), and two measurement calls with the cap of 100 over every probe package and the subpath reference set. |
| **P2. Speed** | On this machine (12 cores, default count 4), bundle step alone (no network), as the default report runs it (subpaths included). **Per package:** valibot, zod, date-fns and motion each at most 0.65x today (measured 0.38x with no subpaths, 0.56x with 9, 0.47x with 739 listed and none built over the cap, 0.46x with 10). **Several packages:** `zod valibot` at most 0.75x (measured 0.68x); `valibot zod date-fns motion` at most 0.95x (measured 0.89x), since today already gives each candidate its own process; those four plus react-hook-form and preact (six candidates, more than the 4 workers) at most 1.0x (measured 0.88x). **Small-machine counts:** with `DEPFIT_BUNDLE_WORKERS` set to the number of candidates (what the rule gives on 4 cores), each P2 call of up to 4 candidates at most 1.05x today (measured: zod at 1 worker 1.03x, `zod valibot` at 2 workers 0.96x). **Full CLI calls:** none of P1(b)'s calls slower than today, except `clsx`, which may be up to 0.3 s slower (measured +0.08 s on its bundle step); `node:sqlite` alone and the missing name start no worker. Expected, not gated: zod about 4.7 s, motion 5.5 s, `zod valibot` 5.2 s, against 7.1 to 7.7, 10.7 and 7.2 s measured before #9. |
| **P3. Load and memory** | On P2's calls, `W` being the worker count the rule gives for the call. **CPU time** at most 1.25x today's plus 0.1 s per allowed worker (`W`), and workers started at most `W` plus one per 100 builds (the replacement schedule), so starting more workers earns no allowance. A computational-cost trade-off for approval, not a noise margin: measured valibot 1.23x, motion 1.08x, zod 1.02x, all four 1.03x, six 1.03x; clsx 0.47 s against 0.23 s. Average busy cores reported. **Memory** (sampled peaks in GiB, depfit included): each call's summed peak at most today's plus 0.75 GiB for each allowed worker beyond today's number of processes (one per candidate), 0.75 GiB being above the largest worker measured (701 MiB). Measured (largest of the runs): valibot 1.22 (today 0.71), zod 2.32 (1.11), date-fns 2.44 (1.13), motion 2.76 (1.74), `zod valibot` 1.98 (1.55), all four 3.00 (3.35), six 3.02 (3.30), clsx 0.18 (0.18). No worker's sampled peak above 1 GiB. The count rule, on-demand start, recycling and the live-worker cap (a retiring worker counts until it has exited) each have a test. |
| **P4. Robustness** | Each with a test using a stand-in runner (as `test/fixtures/runner/` does): (a) **Timeout:** the 5-minute limit counts from when a worker takes the build, not from when it was queued; a build over it ends its worker. (b) **Failures:** a worker that exits, hangs past the limit or prints an unreadable result, in the root phase and in a subpath build, including a subpath build that fails while root builds are still running, two failures at once in either completion order, and a root failure together with `SUBPATH_LIST_FAILED` or `SUBPATH_LIMIT`: each gives the result "Each candidate's result is today's result" defines, and a new worker takes the remaining work. (c) **A worker that fails to start** gives `BUNDLER_ERROR` to the candidates that needed it, and the run ends. (d) **Every child stops:** depfit records the PID of every process it starts (workers, and npm through its installs), and a test checks that each one and its descendants have exited: after a normal run, a candidate failure, a worker failure, recycling, and SIGINT or SIGTERM during start-up, an install, builds and a recycle. A worker that ignores the end of its input is killed after at most 2 s. depfit exits without waiting on idle workers. (e) **No browser signal:** no worker is started, and Vite and rolldown are never loaded (iteration 1 gate F's tracer, plus no worker PID recorded). |
| **P5. Contract and CI** | No field, reason text or `SCHEMA_VERSION` change; `schema-docs` unchanged. Type check, lint, unit tests, `ci/e2e.ts` on Bun and Node 22, and `ci/bundle-accuracy.ts` pass. CI runs both counts: the end-to-end jobs and the bundle job's CLI step (`bundle.cli.*`, now with subpaths) at the default (1 worker for one candidate on its runners), and the bundle job's measurement steps (`bundle.measure.*`, `bundle.subpaths.*`) at `DEPFIT_BUNDLE_WORKERS=2`. `ci/perf.ts` gates `bundle.subpaths.<package>` times by the rule it applies to `bundle.measure.<package>` (a baseline of 2 s or more), so a slower package cannot hide in `bundle.subpaths.total`. A test fails if the pool stops running builds at the same time (a stand-in runner that waits per build: 8 builds on 4 workers finish in well under 8 waits), because CI's 2x gate alone would not catch losing the speed-up. |

### Earlier cost gates under the pool

- Iteration 1 gate F (median added time at most 1.5 s per package) is unchanged and is rerun.
- Iteration 2 gate F times the default report's subpath phase from the end of the root phase to the
  subpaths' final state, plus the manifest read. A pool overlaps those phases, and one worker alone
  does not keep today's order (a shared queue interleaves candidates). The serial measurement is kept
  for comparison, with its budgets: one worker, one candidate at a time, its builds in today's order,
  the manifest read where today's code does it. The default call itself gets its own bound on the
  same population (every candidate of every probe, frozen): each probe call's bundle step under the
  default pool at most 1.1x today's plus 0.2 s, and the median ratio over the probe calls at most
  1.0; each candidate's time to its subpaths' final state is reported. Measuring the default call
  this way instead of by gate F's interval is a change to an earlier bar, for the user to approve.

### CI's performance baseline

The 2x gate only catches a slowdown, so the speed-up needs a new baseline. CI's runners have 4 vCPUs
and the speed-up was not measured there, so no speed-up target is set on CI.

1. **Before re-recording**, a separate check on #7's pull request: two CI runs against the old
   baseline, and no `bundle.cli.*` time (one candidate each, so 1 worker by the rule on these runners)
   above 1.1x its old baseline in both runs. If one is, the work stops and goes back to the user
   before the baseline changes. This is a guard, not the paired evidence P2 and P3 require.
2. `bundle.subpaths.*` (added by #9) have no baseline yet: `ci/perf-baseline.json` predates #9, so
   they are only reported today. They are recorded for the first time with #7's, and the pull request
   lists their values from main's latest CI run beside #7's. From then on `bundle.subpaths.total` and
   each `bundle.subpaths.<package>` with a baseline of 2 s or more are gated (P5).
3. The agent that builds #7 re-records the baseline as `ci/README.md` says, from two CI runs of the
   pull request's final commit (`gh run download`, `bun ci/perf.ts record runs/1 runs/2`), and
   commits it in the same pull request with the old and new value of each gated metric in its
   description.
4. The user approves the new baseline when approving the pull request.

### Out of scope

- Caching (#8), and any field, reason or schema change.
- Build settings, `EXPORT_LIMIT`, the subpath caps, and multi-entry builds (still not allowed:
  iteration 1).
- Making installs or lookups faster, or running a build in a worker thread instead of a process.

### Stop conditions

Iteration 1's, plus: any byte, reason or field that differs from today's in P1 stops the work. There
is no tolerance and no exception list for #7.

## Cache (#8): acceptance bar

Drafted 2026-11-08 before any #8 code and revised after an independent review (verdict in
`STATUS.md`). The user decided its open choices on 2026-11-08 (below); a second independent review
follows. The measurements behind every target are in `STATUS.md` ("Cache (#8): measurements for the
bar"). #8 makes a repeat overview of a package version depfit has already measured, from any
project, skip the npm install and every build. Live facts are fetched again on every call. No
number, reason or existing field changes; one field is added.

### Settled in #8

- The cache key is the hash of the exact resolved install tree plus the build engine version and
  settings, not `name@version`, because a package's own dependency ranges float.
- Entries live in the user's cache directory, with a size limit, oldest entries evicted first.
- Recently used install directories are kept, so the follow-up flags (#10) need no npm install.
- `--no-cache` turns the cache off.
- The report says when a bundle number was measured.
- A hit gives byte-identical bundle facts to a fresh build, and a changed dependency tree is never
  served from the cache.

### Decided by the user (2026-11-08)

- **The tree is resolved by npm on every call** (`npm install --package-lock-only`), not checked
  through packument ETags. A hit is a lockfile whose hash is already cached.
- Install facts are cached in every workspace; the measurement in browser workspaces.
- Limits: 2 GiB of install directories and 128 MiB of entries, least recently used evicted first,
  no setting.
- Only measurements whose codes depend on the package alone are cached.
- Any change under `src/collect/` invalidates every entry.
- `measured_at` is the only new field.
- An unusable cache adds no `unavailable` entry.
- `$XDG_CACHE_HOME` is honored on every platform.

### What is cached

| Stored | Holds | Read by |
|---|---|---|
| **Measurement** | The candidate's `RootEntryMeasurement` as the default report measures it: the whole build, the export names (the export list), the listing problems, each export's outcome, each listed subpath's outcome (default cap of 30), and the subpath state. Plus `measured_at`. | The overview, which recomputes `bundle` and its `unavailable` entries from it with today's code (`rootEntryFacts`); #10 later. |
| **Install facts** | The tree as `readTree` gives it (path, version, edges, installed, disk bytes, install script, native files, license per package) and whether the package ships its own types (`shipsTypes`). | `cost` and `compatibility`, so a hit needs no install. |
| **Install directory** | npm's output for the tree, with depfit's build leftovers (`.depfit-w<n>/`, `.depfit-vite-cache`) removed before it is kept. | #10 only. No #8 run reads a kept install: a miss measures in its own staging directory before publishing, and a hit reads only the entry. |

- **Install facts are cached in every workspace,** and the measurement only in a browser
  workspace, where it is measured. A workspace with no browser signal reads and writes install
  facts only, and still never loads Vite.
- **A measurement is cached only when every code it reports depends on the package alone:**
  `UNRESOLVED_IMPORT`, `MISSING_EXPORT`, `IMPORT_OUTSIDE_BUNDLE`, `NO_ENTRY`, `NON_JS_IMPORT`,
  `PEER_IN_BUNDLE`, and the `EXPORT_LIMIT` and `SUBPATH_LIMIT` states. Any other code keeps it out
  of the cache, and the next call measures again: `BUNDLER_ERROR` (a worker that exited, timed out
  or printed an unreadable result), `BUILD_ERROR`, `SUBPATH_LIST_FAILED` (which a file read error
  also gives), `TOOLCHAIN_MISMATCH`, and every pass-through bundler code. A file system or machine
  failure can surface as any of those, and a rebuild costs only time. The scorecard counts the
  probe candidates this keeps out.
- **Nothing is cached from an incomplete install:** the install facts, the measurement and the kept
  install are published only when every lockfile package that npm did not install is excluded on
  this platform by its lockfile entry's `os`, `cpu` or `libc`, and every installed package's files
  were read. An optional dependency that failed to download leaves npm's install successful and the
  lockfile unchanged, but can change the build (an `UNRESOLVED_IMPORT`, or other output), so a
  measurement of such an install is never reused. Today `readTree` records an unreadable directory
  as not installed; #8 must tell the two apart.
- **Never cached:** live facts (the registry resolution and its dist-tags, downloads, GitHub, OSV
  advisories for the package and for every package in the tree), built-ins, and failed installs.

### Keys

- **Tree hash:** sha256 of the canonical JSON (keys sorted) of the whole lockfile npm wrote for the
  isolated install: `lockfileVersion` and every entry of `packages`, the root entry included.
- **npm settings:** sha256 of `npm config list --json`, run once per call in an empty directory. It
  covers npm's version, the registry, peer handling, `omit` and `include`, and every other public
  setting. It leaves out private settings such as registry credentials, which npm omits from that
  output. Credentials can only change which tree npm resolves, and the resolution runs on every
  call with the user's own npm, so they never need to be in the key.
- **Measurement identity:** the cache format version; sha256 of every file under depfit's
  `src/collect/` and its `package.json` (any edit there invalidates, so no change is ever missed,
  at the cost of rebuilding after unrelated edits); `name@version` of every package in the
  dependency closure of the Vite that depfit loads, read from the installed manifests (not only
  Vite and rolldown, since Vite's own dependencies have ranges); the version of the runtime running
  depfit; the Node and zlib versions of the `node` that runs the workers (gzip happens there), read
  once per call with `node -p`; platform, architecture and, on Linux, libc. `DEPFIT_BUNDLE_WORKERS`
  is not part of it: #7's P1 showed results do not depend on the count.
- **Entry key:** sha256 of the measurement identity, the npm settings hash, the tree hash, the name
  and the version. The npm settings are in it because one lockfile can install different packages:
  npm keeps omitted dependencies in the lockfile (`omit=optional`). A kept install's directory is
  named by the same key without the measurement identity.
- **Two parts per key, each its own file:** `<key>.facts.json` (install facts) and
  `<key>.bundle.json` (the measurement). Each is published and checked on its own. A call needs the
  facts, and in a browser workspace the measurement too; it is a hit only when every part it needs
  is valid. When the facts exist and the measurement does not (an earlier call in a workspace with
  no browser signal, or a measurement kept out of the cache), the call installs with `npm ci`,
  measures, and publishes the measurement alone.

### Finding the tree

For each npm candidate, after the live registry resolution gives its version:

1. **Nothing cached for `name@version`** (no entry directory for it): a cold call. Today's
   `npm install <name>@<version>` in a new staging directory. The tree hash comes from the lockfile
   it wrote. This keeps a first call at today's cost, with no extra npm run.
2. **Otherwise:** `npm install --package-lock-only <name>@<version>` in a new staging directory
   that holds only the minimal manifest (no lockfile, no `node_modules`, so npm cannot keep an old
   resolution), with the call's own npm settings. Its lockfile's hash, with the identity and the
   npm settings, gives the key.
3. **Every part the call needs exists for the key and is valid:** a hit, with no `npm install` or
   `npm ci`. Otherwise `npm ci` from that lockfile in its staging directory, so the installed tree
   is the hashed one by construction. Then measure and publish the missing parts.

With `DEPFIT_LOCK_DIR` replaying a frozen lockfile, that lockfile is the tree: step 2 is skipped,
and a miss replays it as today.

**Why a floating range is never served stale.** Step 2 runs the same npm, with the same settings
and local cache, that a fresh install would use at that moment, for the same single dependency. Its
lockfile is what that install would write: in every measured case the two were identical. A range
that floats gives a different lockfile, so a different key, so a miss. Like npm, depfit sees the
registry through npm's own cache and the registry's CDN: a publish younger than npm's cache
freshness (300 s on npmjs) is seen by neither. "A changed tree is never served" means: never a tree
other than the one `npm install` would install at that moment. Every registry, with or without
credentials, takes this same path.

**Deferred: an ETag fast path.** Checking the packuments npm read with conditional requests would
take 0.09 to 0.15 s against step 2's 0.65 to 2.9 s once npm's cache is stale (measured, `STATUS.md`).
It is left out because its correctness rests on recording validators that match what npm actually
read, and a mismatch would serve a stale tree: a silent wrong number. Add it later only if real use
shows that repeats across sessions, past npm's cache freshness, matter, under a bar of its own.

### Concurrency and failure

- **Layout:** `<cache dir>/v1/`, holding `entries/<name>@<version>/<key>.<part>.json`, `installs/` and
  `tmp/`. Every install and file is staged in `tmp/` of the same directory, so publishing is a
  rename on one filesystem (on Linux `/tmp` is often a separate one). Staging names start with the
  host name and the PID of the call. The cache directory is `$XDG_CACHE_HOME/depfit` when
  `XDG_CACHE_HOME` is set, on any platform, so tests and CI can isolate it; otherwise
  `~/Library/Caches/depfit` on macOS, `~/.cache/depfit` on Linux, `%LOCALAPPDATA%\depfit\Cache` on
  Windows.
- **Writes:** each part is written to `tmp/`, then hard-linked into place, and the first writer of
  that part wins (as `recordLock` does), so `measured_at` stays the first measurement's. An install
  directory gets its size record (`.depfit-size`, inside it) before it is renamed into `installs/`,
  so a published install always carries its size; when one is already there, the rename fails and
  the copy is deleted. An install found without its size record is deleted by the next eviction
  pass.
- **Reads:** a part counts only when its JSON parses, its format version matches, its stored key
  equals the computed key, and the sha256 of its body matches the one stored with it. Anything else
  is a miss: the file is moved to `tmp/` and deleted, and the measurement is rebuilt. An entry
  deleted between finding it and reading it is also a miss.
- **No locks.** Two calls that miss on the same package at once both install and build (with the
  same results), and one entry stands. No lock can be left stale by a crash.
- **A crashed call** leaves partial state only in `tmp/`. An eviction pass deletes a staging item
  when its call is no longer alive on this host, or when it is older than 24 hours. On SIGINT or
  SIGTERM, `children.ts` stops every child as today.
- **An unusable cache** (no permission, a full disk, a read-only directory, or any write, touch or
  eviction step that fails partway): the call measures whatever it could not read fresh, as with
  `--no-cache`, and exits normally. No `unavailable` entry is added,
  since no fact is missing.
- **A hit starts no Vite worker.** The pool starts only when some candidate misses.

### Size limit and eviction

- **Two limits:** install directories 2 GiB; everything in `entries/` 128 MiB. Measured sizes:
  install directories 0.1 MB (clsx) to 38.5 MB (@mui/material), 16 MB median over 9 packages, and
  337 MB for next (its native SWC binary). A measurement is 0.8 to 98.7 KB and install facts 0.2 to
  13.5 KB, so the two parts of a key are about 110 KB at most for the measured packages, and
  128 MiB holds more than 1,100 of the largest. Sizes are the sum of file lengths (not allocated
  blocks).
- **Least recently used first.** A part's last use is its mtime, touched on every hit; an
  install's is its publish time until #10 reads installs.
- **When:** at the end of every call that opened the cache. Victims are taken least recently used
  first until each part is under its limit; nothing published is exempt, since no #8 call reads an
  item after publishing it. Victims are renamed into `tmp/`, then deleted. An install larger than
  its limit on its own is not kept. Sizes are recorded at publish time, so eviction does not walk
  the trees.
- **The limits are soft only by work in flight:** a live call's staging directories, and leftovers
  waiting for the next eviction pass.
- **#10 must define how a call takes hold of a kept install before reading it,** so eviction cannot
  delete it under that call. #8 reads none, so it needs no such protocol.
- **No setting** for the limits. The README says where the cache is, and that deleting it is
  always safe.

### `--no-cache`

Reads nothing, writes nothing, evicts nothing. It is today's path: the install goes to the system
temp directory and is deleted afterwards. The report still has `measured_at`, from this call. The
help text gains one line for it.

### Contract: one new field

| Field | Meaning |
|---|---|
| `packages[].bundle.measured_at` | ISO 8601 UTC time at which the measurement behind this section finished; null when no build behind it completed |

- It is the stored measurement's time, whether the section was measured during this call or read
  from the cache. It makes no claim about its order relative to `generated_at`: a concurrent call
  can publish a measurement after this call starts.
- It is null when no build behind the section completed (a worker failure in the root phase, whose
  `BUNDLER_ERROR` entry explains it). A measurement whose subpath phase failed reports the time its
  last completed build finished. Neither is cached.
- **`--schema`:** "When the measurement behind this section's numbers finished, as an ISO 8601 UTC
  time. It can predate this run: depfit reuses a measurement from its local cache only for the
  identical resolved install tree, npm settings, build engine and settings. Null when no build
  behind this section completed."
- **Table:** the bundle section gains a "Measured at" line.
- `SCHEMA_VERSION` stays 6: a field is added, none renamed or changed, and schema 6 is unreleased.

### Gates

"Today" is main at #8's parent commit (573991c, or the main it is rebased on), run alternately with
#8 on the same machine and day, as in #7: at least 5 pairs, medians, `nice -n 10`, no other build
running, `test/fixtures/browser-app` unless a gate names another workspace. Every call's time,
report and cache state are kept with the scorecard. **Fresh npm cache** means npm resolved the same
packages less than 300 s earlier (a repeat a few minutes later, the agent-loop case); **stale** means
more than 300 s earlier, so npm revalidates every packument.

**Preflight on the first working code, as in #7.** K5's targets rest on the measured cost of each
step, not on a run of the cache, which does not exist yet: (a), (c) and (d) on measured step costs,
(b), (e) and (f) proposed without a direct measurement. A preflight measures all of K5 (a) to (f)
on the first working path, `zod valibot` included. If a target is not met, the work goes back to the
user, and targets are not moved to fit. For a stale npm cache, each call of a pair starts from the
same npm cache, restored from one snapshot taken more than 300 s before, so neither call refreshes
it for the other.

| Gate | Pass condition |
|---|---|
| **K1. Same results** | Three calls per case: `--no-cache`, cold with an empty cache, and a hit. In each, the serialized report's `bundle` (without `measured_at`), its `bundle:` entries in `unavailable`, `cost`, and the install-derived fields of `compatibility` (`types_source`, `types_package`, `licenses_in_tree`) are identical byte for byte. The hit's `measured_at` equals the cold call's. The hit ran no build and started no worker (pool stats), and its only npm runs were `npm config list` and `npm install --package-lock-only` (npm child arguments recorded): no materializing `npm install` and no `npm ci`. Cases: every reference package (`single-reference.json`, the root cases of `cases.json`, `subpath-reference.json`, @storybook/addon-a11y) on its frozen tree through `DEPFIT_LOCK_DIR`, and #7's P1 (b) calls, live. Live fields may differ only under P1 (b)'s re-run rule. In a workspace with no browser signal, the install facts are identical and Vite is never loaded. |
| **K2. A changed tree is never served** | (a) **Unit tests:** the tree hash changes with any entry's version, `resolved`, `integrity`, path or flags, the root entry's dependency, and a package added or removed; it ignores key order. The entry key changes with each identity input, with the npm settings hash, and with a package in Vite's closure changed while Vite's and rolldown's versions stay the same. (b) **A local test registry**, driving the tree step (steps 1 to 3) directly, with npm pointed at it through its settings, since the CLI's own version resolution reads npmjs. The registry sends `max-age=0`, so npm revalidates every resolution, and npm's cache is a test directory. `fixture-a@1.0.0` depends on `fixture-b@^1.0.0`. Each test asserts the exact tree and the hit or miss after each step. Sequence 1: a first call caches b@1.0.0; publishing `fixture-b@1.1.0` makes the next call miss and cache b@1.1.0; moving `latest` back to 1.0.0 (npm prefers `latest` when it satisfies the range) makes the next call hit the b@1.0.0 entry. Sequence 2, on a fresh cache: with 1.0.0 and 1.1.0 published, a call caches b@1.1.0; unpublishing 1.1.0 makes the next call miss and cache b@1.0.0. A change to the packument of an optional peer outside the tree is still a hit. An optional dependency that fails to download in a first call (the test registry returns 500 for its tarball) leaves nothing cached; once it downloads, the next call measures again with the same lockfile. The same lockfile with `omit=optional` gives another key and other install facts. Each test asserts which step ran. (d) **Parts:** a call in a workspace with no browser signal, then a browser call, on the same tree: the second installs, measures, and publishes only the measurement; a measurement kept out of the cache (a worker crash) is measured again and published by the next call; a browser and a non-browser call at once both pass K1. (c) **Real registry:** for every probe candidate and reference package, step 2's lockfile equals, whole file, the lockfile of a full `npm install` run right after it in a fresh directory, with 0 differences, so a cold call's key and a repeat's agree. |
| **K3. Concurrency and failure** | Tests: two CLI calls at once on the same cold package and cache directory both pass K1, and leave one entry and one install. SIGKILL during the install, the builds, between the write to `tmp/` and the link, or between an install's size record and its rename: the next call passes K1, and the next eviction pass removes the dead call's staging. An eviction pass running while another call publishes leaves every published item whole or gone, never partial. A failure injected into a write, a touch and an eviction step: the call exits 0 with a correct report. A truncated, garbage, wrong-key, wrong-version or wrong-checksum entry is a miss, rebuilt and replaced. An entry deleted between finding it and its read is a miss. A transient failure (an unreadable manifest that gives `SUBPATH_LIST_FAILED`, an unreadable package directory during `readTree`, a worker crash) is not cached, and the next call measures again and caches the result. An unwritable cache directory: exit 0, a correct report. #7's P4 (d) (every child stops) still passes, with a call that publishes. |
| **K4. Size and eviction** | Unit tests of the policy as a pure function (items with sizes and last use in, victims out): least recently used first, both limits, an install over its limit not kept. On the real file system, with test limits passed to the cache module: repeated publication leaves each part under its limit after every call; an oversized install is not kept; staging of a dead PID and of a 25-hour-old item is deleted and a live call's is not. The size recorded at publish equals the sum of the kept install's file lengths for the 9 measured packages. |
| **K5. Speed** (provisional until the preflight) | (a) **Hit, fresh npm cache:** `zod`, `valibot`, `motion`, `shiki` and `zod valibot`, each at most 1.5 s median, and no slower than today's same call with `DEPFIT_BUNDLE=0`: the hit's lock-only resolution (measured 0.12 to 0.53 s) replaces that call's install (0.14 to 2.2 s), so it does less work. (b) **Hit, stale npm cache:** each of (a)'s calls at most today's same call with bundle facts on, which installs and builds (measured 1.8 to 5.2 s), and its time reported; lock-only then took 0.65 to 2.9 s. The `DEPFIT_BUNDLE=0` comparison does not hold here: a stale cache costs that call's install the same revalidation, and which of the two pays it first decides the pair, so it is reported, not gated. (c) **Cold,** empty cache: each of #7's P1 (b) calls at most today's median + 0.15 s; with a cache at its install limit, so the call evicts at least one install of similar size, at most + 0.3 s; eviction time reported. (d) **Changed tree** (a lockfile not yet cached, for a version already cached): at most today's + 0.6 s (step 2 and `npm ci` against today's install: measured + 0.12 to 0.14 s on a fresh npm cache). (e) **depfit's own work for the cache on a hit:** depfit's own CPU time (`process.cpuUsage`) in the cache code (hashing, the parts' read and checks, the eviction pass's bookkeeping), divided by the call's candidates, at most 50 ms per candidate. The two per-call probes (`npm config list`, `node -p`) run alongside the registry resolution; their elapsed time is reported separately (measured 67 to 77 ms and 25 ms). (f) A workspace with no browser signal, on a hit: no slower than today. |
| **K6. Contract and CI** | `measured_at` is in `report.ts`, `schema-docs` and the typed fixtures, and `ci/contract.ts` checks it. Type check, lint, unit tests, `ci/e2e.ts` on Bun and Node 22, and `ci/bundle-accuracy.ts` pass. CI: every `ci/e2e.ts` scenario runs with its own empty `XDG_CACHE_HOME`, and a new scenario runs the browser workspace twice and then with `--no-cache` (the second keeps the first's `measured_at`, passes K1 and runs no materializing npm install; the third has a new `measured_at`). `ci/bundle-accuracy.ts` runs its CLI step with `--no-cache` and an empty `XDG_CACHE_HOME`, so `bundle.cli.*` keeps timing builds; its measurement steps call `measureRootEntry` directly and never touch the cache. No `actions/cache` step includes depfit's cache directory. `eval/run.ts` and the gate scripts pass `--no-cache` unless a gate tests the cache. |

#7's P1 to P5, iteration 1's gate F and iteration 2's gate F are rerun with `--no-cache` and must
pass unchanged.

### Stop conditions

Iteration 1's, plus: any K1 difference, or any test in which a hit is served for a tree other than
the one npm would install, stops the work. There is no tolerance and no exception list.

### Out of scope

- The follow-up flags (#10), and builds in a kept install. #10 must define how a call takes hold of
  a kept install, and give each call's workers their own entry directories there, since two calls
  can share one install.
- A shared or hosted cache.
- Caching live facts beyond one call.
- The ETag fast path (deferred, above).
- A cache command (clear, list) or a size setting.

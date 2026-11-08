# Bundle size: status and handoff

Read SPEC.md first: it is the bar, the decisions, and the stop conditions.

## v2 direction (2026-10-19)

The snippet API (schema v5, `--bundle-entry`) shipped in #1 and is being replaced. In the round-4
decision eval, agents wrote valid snippets on the first try 6 times out of 35, and the CLI must work
as `depfit zod valibot` with no extra input (user decision). The new bar is SPEC.md (v2): sizes with
no input, in iterations, each with its own bar written before its code. The v1 bar is
SPEC-snippets-v1.md. Evidence: `eval/FINDINGS.md`, round 4 and its follow-up.

| Iteration | State |
|---|---|
| 0. Remove the snippet API | Passes (user decision, 2026-11-04; below) |
| 1. Root entry point, two ways, browser workspaces only | Built; scorecard below |
| 2. Each subpath in the `exports` map, measured whole (#9) | Built 2026-11-08 with bar amendment 6 (a compact map in the default report); scorecard below |

Holdout probes `holdout-1`, frozen 2026-10-19 before any iteration-1 code: 10 questions, sha256
`f792fac58becfaed39b978a33e2e118526652b9cb6c9214b424d9cf2461f8466` of `JSON.stringify` of the
`holdout-1` entries of `eval/probes.json` in file order.

Holdout probes `holdout-2`, frozen 2026-11-06 before any iteration-2 code: 10 questions, 29
candidates, sha256 `c39c0792cdc4fc44b13b7e34b8202fe06307d6c64d468463903a0b73e34a3dde` of
`JSON.stringify` of the `holdout-2` entries of `eval/probes.json` in file order (appended after
every earlier probe, so the files `eval/run.ts` writes for earlier probes keep their numbers).

The holdout-2 measurement inputs were frozen on 2026-11-07, before the first iteration-2
measurement, in the order SPEC.md gives:

| Input | sha256 or value |
|---|---|
| Project revisions, recorded in a local record, with a hash of each working tree | sha256 of the record: `4723833f848ac776397c5754afedf8f85c95669a1c0a0c65aedb756bcb91b845` |
| Ground-truth snippets (29) | `ece6ec2c17fd631dca54e6cc9ccf5172035ddb1b42f5061e01d95ce74b9cf584`, from `JSON.stringify` of the holdout-2 entries of `eval/snippets.json` in probe order |
| Resolved versions and install trees (29 lockfiles) | `909adea328f4e81a968a79c8a72c7c5079625faa7e7b8f74d0654b07c2571312`, from `JSON.stringify` of `[{name, version, lock_sha256}]` sorted by name (compact) |
| Collection run that recorded them, also gate H's control | the iteration-1 CLI at `7b30612` |

- **Snippets.** One blind Sonnet agent per project wrote them, from the project's source and the
  question only, with no sizes. All 29 passed depfit's snippet parser on the first try.

## Iteration 2: subpaths, measured whole (built 2026-11-08)

The bar is in SPEC.md, "Iteration 2", including bar amendment 6 (2026-11-07). Its evidence is in
FINDINGS.md, under "Round 5 follow-up: subpaths" and "Round 6". The default report gets
`exports_map`, `subpaths_listed`, `subpaths_whole_eager_js_gzip9_bytes` (at most 30 keys) and
`subpath_patterns_unmeasured`. Each null value is named by code in `unavailable`. The detail of each
subpath stays in the measurement code for the follow-up flags (#10). Scored by
`eval/bundle/subpath-score.ts` (gates L, A, B, C, D, E, F, R and the H0 prompt) and by
`root-score.ts`, which reruns iteration 1's gates.

**Scorecard: every gate passes** on the final code (after the code review's fixes, below). All gates were rerun on it.

| Gate | Result |
|---|---|
| L. Listing | Pass. (i) The unit tests cover every fixed manifest case the bar names. (ii) On the 288 manifests, depfit's listing equals `resolve.exports` 2.0.3 under the rule: 1,335 listed keys, 0 differences. The frozen B set equals the rule over this listing |
| A. Honesty | Pass. The B set has 8 nulls with their listed code and specifiers, each named in `unavailable`, and 0 others. The probe packages, measured with the cap of 100, have 11 nulls with their listed reason and 0 others. In the default report, every null value's key is named once per code. Coverage: 88 packages, 94 candidates, every listed subpath built. One reviewed listing and one re-encoding were needed (below) |
| B. Accuracy | Pass. 43 of 43 measured B-set subpaths fall in the rollup/webpack band on both gzip fields, with 0 gross errors |
| C. Vite conformance | Pass. The 43 cases equal a stock `vite build`: min bytes identical, gzip within 1% |
| D. Determinism | Pass. Over all 32 probes, two runs give 0 differences in the default report. The measurement call with the cap of 100 gives 0 differences on the B set and on the 88 probe packages |
| E. Contract | Pass. The fields, states and precedence give 0 problems, as do the listing metadata against the measurement call, the serialized members (read from the printed JSON, duplicates kept), the exact correspondence of keys, values and codes with the measurement call (cap 100, the same frozen trees, an explicitly named result checked for src/ and lockfile identity), the framing, and the rule that each (key, code) pair is named once. With `DEPFIT_BUNDLE=0`, non-bundle fields differ in 0 places. Every package has the control run's version |
| F. Cost | Pass. The default call's subpath phase per candidate: median 0 ms (budget 250), p90 78 ms (budget 1 s), max 875 ms (shiki, 10 subpaths), measured on the final code (`src/` tree `deb643a`). At most 10 subpaths were built for one package (limit 30). Iteration 1's bundle-step median, subpaths included, is 309.5 ms (limit 1.5 s; p90 4.0 s, max 32.2 s for three) |
| S. Browser signal | Pass. 22 of 22 workspaces match the table |
| R. Real usage | Pass. (a) 82 of 89 in `[0.9 × L, 1.1 × U]` (92.1%): round-4 29 of 34, holdout-1 29 of 30, holdout-2 24 of 25. (b) Pairs: 62 of 64 agree (96.9%). (c) Listing coverage: 0 uncovered, 0 over the cap. (d) The 7 misses are all classified: class 1a ×3 (dayjs, mathjax-full, pragmatic-drag-and-drop), class 1b ×2 (gsap, highlight.js languages) and class 3 ×2 (motion). The 2 disagreeing pairs both involve mathjax-full (class 1a). 5 candidates were left out because their real usage is null |
| H0. Comprehension | Pass. 3 of 3 blind Haiku readers answered all 11 questions correctly |
| H. Decisions | Pass. 0 misreadings of what a number measures. The independent code reviewer ruled on the two Haiku sentences left for review: a wrong ranking (lightbox) is not a misreading, and an inference about one locale from `./locale`'s whole size is covered by the known limit that subpaths are measured whole only. Iteration 2 differs from the control on 3 of 32 probes for Sonnet and 6 of 32 for Haiku. None is worse on the facts (FINDINGS.md, round 6) |

Iteration 1's gates were rerun as regression checks on the final code, and all pass:

| Gate | Result |
|---|---|
| A | 8 of 8 null cases; 16 single-export nulls as listed |
| B (whole) | The wild corpus gives 141 numbers and 59 nulls with codes, and meets W's conditions: 0, 0 with 1 reviewed exception, 0. 40 packages drifted and were not compared |
| B (single) | 84 of 84 |
| C | 0 failures |
| D, E | 0 differences |
| S | 22 of 22 |
| F | Median 309.5 ms |

The probes R under the iteration-1 rule is 82 of 89, with 56 of 59 pairs agreeing.

### Deviations and reviews while building

- **Gate A, two probe nulls (reviewed 2026-11-08).**
  - fuse.js `./worker` is null with `NON_JS_IMPORT`. Its specifier is the worker file emitted as
    an asset. `subpath-nulls.json` had encoded the bar's "a worker" as the `worker <module>`
    prefix, which is narrower than the bar's text.
  - three `./addons`, a holdout-2 candidate, emits Basis and Draco wasm and decoder assets
    (`NON_JS_IMPORT`). It was not listed because it was first measured after the bar.
  - An independent reviewer (Codex gpt-6.1-sol, high effort) judged both nulls honest. It called
    fuse.js an encoding correction, not a bar change, and approved listing three under gate A's
    review-and-list rule, with its seven asset names.
  - Following the reviewer, each entry of `subpath-nulls.json` now carries its own review; probe
    results keep each null's problems; and the probe scorer checks its own coverage.
- **A project moved after the freeze.** One holdout project, a React app in a Bun monorepo
  (bun.lock), gained 10 commits after the freeze. They changed no `package.json` or lockfile, but
  did change source files. It was measured from its frozen commit: `eval/run.ts --revisions`
  exported that commit with `git archive` into a fixed temp path, so the project itself was only
  read. Its workspaces were clean when the freeze was recorded.
- **The freeze record does not cover the contents of untracked files.** The working-tree hash
  covers each project's diff against HEAD and the names of its untracked files. When the freeze
  was recorded, 4 of the 10 recorded workspaces had uncommitted changes, and 3 of those have
  untracked files. An edit inside one of those files after the freeze would not have been caught.
  Before and after the collection runs, the tracked state of every project matched the record,
  except the moved project above.
- **One candidate resolved to a newer release.** maplibre-gl, a holdout-1 candidate that the probe
  names without a version, resolved to 6.17.0 in the first iteration-2 runs and to 6.16.0 in the
  control run a day earlier. A frozen lock pins a tree per name@version, not which version
  "latest" names. The final runs pin it with `eval/run.ts --pin`, so its `requested` reads
  `maplibre-gl@6.16.0`. Report scoring now fails unless every package has the control run's
  version. The project's two iteration-2 evaluators were rerun on the pinned reports.
- **Tooling fixes found by the gates.** The export path for frozen revisions was first a random
  temp directory, which made `project.root` differ between runs (gate E). It is now fixed per
  project and revision, and the 6 probes it affected were rerun in all three runs. Gate R's scorer
  now also classifies disagreeing pairs, as iteration 1's did.

### Independent code review (Codex gpt-6.1-sol, high effort, read-only, 2026-11-08)

**First review: do not approve.** Two must-fix findings:
1. Gate E's checker accepted states the contract forbids. It did not check the named keys after an
   unknown listing or an empty map, did not catch a populated map beside a root failure, and did not
   check groups that name keys which are not null values.
2. Candidate versions were not frozen across arms (maplibre-gl).

Five should-fix findings:
- untracked file contents in the freeze hash;
- duplicate map members and a lenient reason parser;
- correspondence read from the newest measurement file, unchecked;
- versions missing from the B-set comparison;
- the listing regex also admitting `.mjsx` and `.cjsx`.

There were also missing CLI-path tests: a toolchain mismatch with listed subpaths, root crashes
combined with a listing failure or the cap, and the 30/31 boundary.

All were fixed:
- Gate E now checks every state and its precedence, the listing metadata, members read from the
  printed JSON, and the exact set of named pairs, with a strict parser for the framing rule.
- `report` takes an explicit measurement file, checked for coverage, `src/` identity and lockfiles,
  and requires the control run's versions.
- References record their lock hashes.
- The listing admits exactly `.js`, `.mjs`, `.cjs` and `.jsx`.
- `eval/run.ts` gained `--pin` and a format-2 revision record that hashes untracked contents
  (`--record-revisions`). The holdout-2 record is format 1 and stays accepted with a warning, as
  noted under the deviations above.
- The tests cover the CLI's call in each of the missing cases.

Every gate was rerun on the fixed code.

On the two gate-H sentences, the reviewer ruled:
- (a) the lightbox ranking is neither a misreading nor a known-limit inference: it is an
  internally inconsistent ranking.
- (b) the locale sentence is an inference covered by the known limit.

**CI.** #15 merged before this work landed. Its bundle-accuracy job now also replays
`subpath-reference.json`: 51 subpaths, with exact bytes (gzip included) and the expected codes. The
local run gave 169 cases and 0 failures, and `bundle.cli.total` was 31.4 s against the 36.6 s
baseline. Tests and the end-to-end contract check pass on Bun and on Node.

### Independent review of bar amendment 6 (2026-11-07)

Codex gpt-6.1-sol, high effort, read-only. Three rounds, each briefed with the amendment and the
user's instructions and with no expected verdict. All three rounds ran before any report-level
iteration-2 result existed.

- **Round 1: do not approve.** Five must-fix findings:
  1. Gate E required each null key in exactly one entry, which contradicts one entry per code.
  2. The `unavailable` format could not identify keys.
  3. No gate tied published values to the measurement.
  4. The states overlapped, with no precedence.
  5. A, D and F did not say which call (cap 30 or cap 100) they read.

  Should-fix: gate R carried round-5 scores as if they were new, map order was not a serialization
  requirement, and some text still pointed at iterations 3 and 5. All were fixed, along with a bug
  the new unit tests then caught (a package with no map fell through to the build path).
- **Round 2: do not approve.** Two must-fix findings:
  1. E's correspondence check contradicted the failure states.
  2. Root-entry text could imitate an appended group.

  Should-fix: F's timing boundary. All were fixed. E's correspondence check now applies to a
  populated map only. Free text in `bundle:` entries percent-encodes `%`, `;` and `[`. F times one
  manifest read, plus the end of the root phase to the subpaths' final state.
- **Round 3: approve with changes.** One wording change: encoding applies outside the key arrays,
  and parsing resumes after each complete array. It was made.

### Independent review of the bar (2026-11-06)

Independent review (Codex gpt-6.1-sol, high effort, read-only, two rounds, briefed with the draft
and the evidence and no expected verdict):

- **Round 1: do not approve.** Six must-fix findings:
  1. Gate R's coverage check required bytes, which conflicts with the cap and with honest nulls.
  2. Gate R's arithmetic and inputs were unspecified, and it was unclear which iteration-1 gates
     are replaced.
  3. There was no contract for failure states, and a crash could erase the root's numbers.
  4. A reader could not tie a null subpath to its cause.
  5. Gate H's control leaked iteration-2 information.
  6. The B reference set has 51 cases, not 54.

  There were also five should-fix findings: holdout inputs beyond the questions were not frozen;
  cost counts and timing boundaries were wrong (26 of 65 candidates have a subpath, not 25;
  @base-ui/react takes 1.2 s without its root build); an H0 question claimed "in no number"; there
  were no fixed listing cases and `exports: null` was undefined; and a line-count estimate was wrong.

  All were fixed. Gate R now has a written algorithm, its coverage check is about listing only, and
  over-cap packages are reported separately. A state table was added, along with
  `subpaths[].unmeasurable_codes` and two codes, `SUBPATH_LIMIT` and `SUBPATH_LIST_FAILED`. Gate H's
  control is now the iteration-1 CLI. The 51 cases are listed. A preparation step freezes the
  holdout inputs. Gate L has fixed manifests. The numbers in FINDINGS were corrected.
- **Round 2: approve with changes.** The reviewer confirmed that all 11 findings were resolved. It
  reproduced the 51 cases with 8 nulls, the 58/64 and 48/48 scores, the cost figures and the
  holdout-2 hash. It raised four smaller points, all now fixed:
  1. Gate A asked `unmeasurable_codes` for a kind of specifier, but that field holds codes only.
     The kind is now checked against the build problems the eval keeps.
  2. Gate F's timer had no end when nothing is built.
  3. The percentile was misnamed.
  4. The table had no display for unknown and failed states.

## Iteration 1: root entry point, two ways (2026-11-04)

Built in schema 6. In a workspace with a browser signal (`project.browser_signals`), each npm
package gets `packages[].bundle`: the root entry point whole (`import * as m`, kept) and each export
alone, every export in its own `vite build`, sequentially in one Node child per package
(`src/collect/root-entry.ts`). With no signal, `bundle` is null with `bundle: skipped, no browser
signal in workspace`, and `root-entry.ts` (and with it Vite and rolldown) is never imported.
Scored by `eval/bundle/root-score.ts` (README "Iteration 1 scorecard").

**Scorecard: passes with the 2026-11-05 bar amendments.** As first scored, gates B, C and S failed
under the bar's text, for reasons the bar did not mean (the four questions below). The user decided
four amendments on 2026-11-05 after seeing these results; they are in SPEC.md ("Bar amendments
(2026-11-05, user-approved)") with the independent reviewer's verdict below, and gates A, B, C, D,
E, H0, R and S were rerun on the final code.

| Gate | Result |
|---|---|
| A. Honesty | Pass: 8/8 v1 null cases (all import the root) return their code on the whole build, now with one `unavailable` entry per cause (amendment 4). The 16 single-export nulls of the reference set each match their listed code and specifiers in `single-nulls.json` (amendment 2). Gross errors 0 (single-export set and wild corpus) |
| B. Accuracy, whole | Pass: gate W's 200 packages through the CLI with no flags, against W's conditions: (i) 0 numbers with an auditor fetch, (ii) 0 gross errors, server-only covered by its re-recorded exception (amendment 3), (iii) 0 unusable results. 141 numbers, 59 nulls with codes. 79 packages drifted from the frozen trees since 2026-10-16, so 39 numbers were not compared (W reports drift as information) |
| B. Accuracy, single export | Pass (amendment 2): 84/84 measured exports in band or covered by a reviewed exception (react-hook-form `FormProvider`, evidence in `evidence/react-hook-form-FormProvider.md`), 0 gross errors. The 16 listed nulls count under A |
| C. Vite conformance | Pass (amendment 2): 84 measured single exports identical to stock Vite on all four fields, 10 whole builds with min bytes identical and gzip within 1%. The 16 listed nulls count under A |
| D. Determinism | Pass: 65 probe packages across two runs on the same frozen installs; 20 reference packages measured twice (rerun on the final code) |
| E. Contract | Pass: every package has every bundle field, every field in `schema-docs`, 0 non-bundle differences with `DEPFIT_BUNDLE=0` over 22 probes (rerun on the final code) |
| F. Cost | Pass: with no browser signal no Vite or rolldown module is resolved (the tracer sees 7 in a browser workspace); added time per package over 65 probe candidates (59 distinct packages, each counted per probe), bundle step alone on frozen installs: median 318 ms (max 1500), p90 5.2 s, max 18.7 s (maplibre-gl, 87 large exports). CLI wall time per probe, advisory: median 2.5 s on, 1.7 s off |
| S. Browser signal | Pass (amendment 1): 22/22 workspaces match the table |
| R. Real usage | Pass: 59/64 in `[0.9 x median, 1.1 x whole]` (92%; round-4 probes 30/34, holdout 29/30); pairs 43/44 (98%); all 5 misses are class 1 (subpath); auto-animate left out (its real usage is null) |
| H0. Comprehension | Pass: 3/3 blind Haiku readers, all 5 questions; rerun on 2026-11-05 with the final code (one entry per cause, new `exports_measured` wording, Node gzip), again 3/3, and after amendment 5 (`external_packages` wording), again 3/3 |
| H. Decisions | Pass, pending review: 0 misreadings (1 ambiguous sentence, decision unchanged); v6 differed from the control on 2/22 (Sonnet) and 4/22 (Haiku) probes, none worse on the facts; one Haiku difference is a reading of the question (FINDINGS round 5) |

### Questions the 2026-11-05 bar amendments resolved

1. **Gate S table vs rule.** The rule checks `index.html` in the workspace directory only. The
   static Preact site keeps its `index.html` in `app/` (Vite `root`), so the rule gives `preact`
   where the table says `preact, index.html`. The Electron app with a React renderer has
   `index.html` in its workspace directory, so the rule gives `react-dom, index.html` where the
   table says `react-dom`. The detector follows the rule; the table rows look like the error, but
   that is a bar change. The exact workspaces were not recorded with the probes, so they were mapped
   from the table's stack descriptions on 2026-11-04 before any detector code was written
   (`eval/signals.json`, local). Resolved by amendment 1: the two rows now follow the rule.
2. **Gate B (single) and C on honest nulls.** The reference set is chosen by the rule (first 20
   wild packages with at least 10 rollup exports) and includes two Node-only CLI libraries
   (@inquirer/core and @inquirer/prompts), whose every export imports Node built-ins
   (`UNRESOLVED_IMPORT`). It also includes react-router and react-router-dom, where 6 exports keep a
   computed `import()` in Vite's output (`IMPORT_OUTSIDE_BUNDLE import(…)`); rollup and webpack
   build them. Each of these 16 nulls carries its code, which is what gate A asks for, but B and C as
   written count them as failures. The one number out of band is react-hook-form `FormProvider` (592 B gzip vs 430-433 B): depfit equals
   stock Vite exactly, and the extra bytes are top-level constants and member reads (`r.required,
   r.min, ...`) that rolldown keeps and rollup + terser drop. It would need a reviewed exception.
   Resolved by amendment 2: the listed nulls with their expected reasons (`single-nulls.json`) count
   under A, and FormProvider has a reviewed
   exception with its demonstrated cause (395 B of Vite-only unused code; without it the output is
   924 / 425 B, inside the band; `evidence/react-hook-form-FormProvider.md`).
3. **server-only's reviewed exception** (gate W, reused by B) records Bun's gzip (117 B); depfit
   now reports Node's (115 B). Re-recording it is a review, not a lead's edit. Resolved by
   amendment 3.
4. **Stop condition 5 or contract?** A package whose every build imports a Node built-in gets two
   entries for one cause: the whole build's `bundle: UNRESOLVED_IMPORT ...` and `bundle: <n> exports
   unmeasurable (UNRESOLVED_IMPORT)`. The contract prescribes both entries; stop condition 5 forbids
   more than one per cause. Resolved by amendment 4: the code now gives one entry per cause (the
   whole build's), the per-export summary lists only other causes, and stop condition 5 is
   unchanged.

### Amendment 5: `external_packages` lists only the peers the output imports (2026-11-05)

User-approved after seeing the round-5 reports. The field listed every declared peer, optional
ones included, so valibot showed `typescript`, an optional types-only peer its JS never imports.
It now lists the peers a measured build (whole or one export) still imports, by package name, and
is null when no build was measured; peers stay external in every build. Schema 6 is unreleased,
so this is a meaning change inside schema 6, with no version bump. Gates A, D, E, R and H0 were
rerun on this code.

The reports the round-5 decision evaluators read would now differ for 10 of 65 packages:
valibot (`typescript` to none), zustand (`immer, react, use-sync-external-store` to `react`), motion
in two probes (`react, react-dom, remix` to none: the root never imports React, `motion/react`
does), @tanstack/react-form (`@tanstack/react-start, react` to `react`), markdown-to-jsx
(`react, react-native, solid-js, vue` to `react`), and recharts, react-hot-toast, react-toastify and
react-window (`react, react-dom` to `react`). zustand still shows `react`. Evaluators cited the
field in two places: on Preact shared state, zustand's listed peers as code its bytes leave out
(still true for `react`), and on exercise forms, Haiku flagged `@tanstack/react-start` as absent
from `peer_dependencies` (no longer listed). No decision rested on a listed peer the output does not
import. The evaluators were not rerun.

Independent review (Codex gpt-6.1-sol, high effort, read-only): agree with changes. It found that
`importedPeers` also matched the build's own chunk paths, so an unused peer named like a chunk
directory (`assets`) would have been listed; chunk file names are now excluded, with a regression
test, and a CommonJS `require()` of a peer is now checked to be listed. It also asked to reword a
SPEC line that still said every peer is listed. Both are fixed. No reported peer in the rerun was
a chunk name, so the rerun results stand.

### Independent review of the bar amendments (Codex gpt-6.1-sol, high effort, 2026-11-05)

Two read-only rounds, briefed with the diff and the gate results, and no expected verdict.

- In round 1 the reviewer agreed with amendments 1, 3 (126 / 115 B confirmed from the saved run)
  and 4 (a cause is a reason code; different specifiers sharing a code collapse by design; the
  field docs match). For amendment 2 it said "agree with changes": any reason code could have let a
  regression pass (every single export null with `BUILD_ERROR` would pass A and leave B at 0/0);
  FormProvider's cause was not shown by any artifact; a pending exception already waived; the C row
  was not scoped to single exports; the band arithmetic was wrong (the band maximum is 1146.1 B,
  not webpack's 951 B); a failed export with no recorded problem would vanish from the summary.
- In response, the 16 nulls are listed in `single-nulls.json` with an expected code and
  specifier rule, and any other null fails A; `reference.ts --emit` rebuilt FormProvider three ways
  and `evidence/react-hook-form-FormProvider.md` keeps the emitted code. That corrected the lead's
  first cause: the `isWeb` check and the effect expression are in all three builds, and only 395 B
  is Vite-only. Exceptions and the null list waive nothing while their review is pending (a run in
  that state failed A 16 times and B 83/84). The B and C rows are scoped; the arithmetic and the
  empty-problems case (now `BUILD_ERROR`) are fixed.
- In round 2 the reviewer agreed with amendment 2 and approved the FormProvider exception: the reviewer recounted 286 + 109
  = 395 B and 924 / 425 B without it. `single-nulls.json` approved: the saved per-export failures
  match all 16 entries. No new must-fix issue. Both approvals are recorded in their `reviewed`
  fields; gates A, B and C were then rerun and pass.

### Codex review (gpt-6.1-sol, high effort, read-only, 2026-11-04)

Not passing at first; fixed and rerun:

- A write to a Vite child that had exited could raise an unhandled stream error. stdin errors and
  write callbacks now fail the build (`BUNDLER_ERROR`). The race did not reproduce here (Node
  reports the exit first); two tests cover a child that exits early.
- Missing or short inputs could pass gates (an empty probe directory, a missing
  reference file, fewer than 10 whole Vite references, an empty or unloadable signals list). Every
  gate group now checks its coverage first (probe count and the holdout sha256; 20 packages x 5
  exports and 10 whole references; 22 loadable workspaces) and fails while coverage fails.
- Gate F counted each distinct package once; it now counts every probe candidate (65, 59
  distinct). Median 318 ms.
- Gate D on the reference set compared only the number of listing problems; it now compares them all.
- Two installs of the same name@version could overwrite each other's frozen lock. A frozen lock
  is now published atomically (temp file, then a hard link that fails if one already exists).
- Not done: drifted wild packages are still not compared (gate W treats drift as information).
  Replaying the frozen wild trees would need their peers; 39 numbers were not compared this run.

The reviewer's opinions on the open questions (not acted on; bar changes need the user):

- Gate S (question 1): agrees both table rows are wrong against the written rule; correct the table,
  do not widen the rule to fit it.
- Gate B and C nulls (question 2): as written the 16 nulls fail B and C. The reviewer would support a
  narrow correction that keeps every case and judges nulls for honesty rather than accuracy, and
  would not support dropping them from the count. FormProvider is a reasonable candidate for a specific reviewed exception (pinned
  package, tree, import, exact bytes, the cause shown), not a blanket stock-Vite exemption.
- Stop condition 5 (question 4): the two entries literally trip it; the contract also requires both entries. Would
  support clarifying the stop condition to allow the two summaries; until then it is not satisfied.
- Moving gzip into the Node child: a legitimate general fix, not a bar move. (Question 3, the
  server-only exception, was not asked separately; it follows from that change.)

### Decisions made while building (for review)

- **Ground-truth rules**, written before any iteration-1 measurement: side-effect `.css` imports
  are removed from snippets (6 holdout snippets had one); a candidate whose ground truth is null is
  listed and left out of gate R (auto-animate). Holdout snippets live in `eval/snippets.json`
  (local) so `probes.json`'s frozen holdout entries keep their sha256.
- **Gate R miss classes** are assigned from the snippet's shape (README); no miss needed judgment.
- **Gate C's "10 whole-package cases"** are the first 10 packages of the single-export reference
  set, built whole with stock Vite (the SPEC does not name them).
- **Gate F's added time** is the bundle step alone per probe candidate, timed sequentially on the
  frozen installs; CLI wall time with bundling on and off is reported as advisory.
- **Gate H's control** is the `DEPFIT_BUNDLE=0` report with its `bundle:` entries removed, as round
  4's control had none. Evaluators read the reports from before the gzip change below (gzip values
  differ by at most 2%).
- **`exports` over the cap** stays the count; `exports_measured` and the median are null.
- **Median** of an even count is the mean of the middle two, rounded.
- **Builtins and failed packages** get no `bundle: skipped` entry (their sections are null by their
  own rule).

### Changes made after seeing results (each a general rule, recorded here)

- **gzip is computed in the Node child that runs Vite** (found by gate C). depfit ran gzip in
  Bun, whose zlib gives up to 2% fewer bytes than Node's on small chunks; the bar's 1% tolerance
  existed for that difference. Now every byte comes from the Node process that ran Vite, and gate C
  matches stock Vite exactly. All gzip numbers moved by up to 2%; the probe runs were redone.
  Known caveat for a later re-run: the gate H and H0 evaluators read reports made before this
  change (gzip values shifted by 2% or less). Their results are kept. H0 was later rerun on the
  final code (3/3); gate H's 27 evaluators were not.
- **Export names count only from a listing build in which the candidate resolved** (found by gate
  A's output). For a package with no root entry (biome), Vite left the import unresolved and the
  `export { default }` listing "succeeded", giving `exports: 1` and an extra entry. Now `exports` is
  null and the only entry is the whole build's `NO_ENTRY`.
- **D on the reference set compares the reported facts** (bytes and the set of problems), not the
  order in which Vite resolved imports.

## Iteration 0: remove the snippet API (2026-11-04)

Schema 6: `--bundle-entry`, `entry` and `entry_source` are gone, and `packages[].bundle` is
always null until iteration 1 fills it. The CLI no longer imports the bundle code. The snippet
parser, entry generator and `bundleEntry` stay in `src/collect/`, called only by
`eval/snippet-bundle.ts`, which `eval/run.ts` uses to write `<probe>.snippets.json` for each
probe with `bundle_entries`.

| Check | Result |
|---|---|
| Type check, lint (`oxlint`, `oxfmt --check`), tests | Pass |
| `--help`, README, `schema-docs` say nothing about snippets | Pass |
| A/B on the same day: v5 CLI (`3319786`, `--bundle-entry`) vs `eval/run.ts` on the 12 round-4 probes | 35/35 identical: version, entry, all four byte fields, reasons, peers |
| Round-4 ground truth, each candidate at its round-4 version | 33/35 within 1% (29 byte-identical); 2 outside |
| Round-4 ground truth, versions as resolved today | 23/35 within 1%; 11 of the 35 resolve to a newer release |

The two misses are at the same package version, with newer dependencies installed:

- recharts 2.15.4: +3.2% min, +2.6% gzip. Eleven d3 packages and `@babel/runtime` in its isolated
  install were published on 2026-11-03 and 2026-11-04, after round 4 (2026-10-19).
- streamdown 2.7.0: +2.0% min, +2.1% gzip. Its `marked` dependency now resolves to 18.1.3
  instead of 18.1.1; marked 18.1.3 alone is 5.7% larger than 18.1.1.

The A/B shows the engine is unchanged. The misses come from the registry, which round 4 did not
freeze.

**Decision (user, 2026-11-04): iteration 0 passes.** 33 of 35 round-4 candidates reproduced within
1%. recharts (+3.2%) and streamdown (+2.1%) missed only because their dependencies were republished
after round 4, and the A/B against the v5 CLI was 35/35 identical, so the user accepted the result as
meeting the bar's intent. The bar text is unchanged.

**Open item (kept for later):** the round-4 ground truth was never frozen, so reproducing it drifts
with the registry. This may need revisiting. From iteration 1 on, `eval/run.ts` freezes every
install: each candidate's resolved tree is saved as an npm lockfile next to the results
(`<out>/locks/`, gitignored), and a re-run with `--locks <dir>` reinstalls the same tree with
`npm ci`.

The rest of this file is the v1 history.

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

## Parallel builds (#7): measurements for the bar (2026-11-08)

**Bar approved by the user on 2026-11-08.** Independent review (Codex gpt-6.1-sol, high effort,
read-only), four rounds: not ready three times (failure precedence; full comparisons; on-demand
start; owned-process cleanup; today's CPU baseline; the small-machine rule; the CPU allowance; the
default-call bound; CI protocol), each fixed; the fourth, on the text rebased onto #9: approve with
changes (iteration 2's gate D populations, per-package subpath gating in `ci/perf.ts`, run counts,
the small-machine bound kept at 1.05x), applied in the approved text.

Measured for SPEC.md "Parallel builds (#7)" on an Apple M4 Pro (12 cores, 24 GB), Node 24.14.1,
Bun 1.3.14, npm 11.11.0, warm npm cache, with research scripts outside the repo that reuse depfit's
own runner (`startViteRunner`, `outcomeOf`, `measureRootEntry`). Another session's builds ran on the
same machine during part of this; the per-package and pool numbers below are from quiet windows, and
the zod and motion worker sweeps were taken under load, so they show the shape, not exact times.

**Today, CLI wall time** (`test/fixtures/browser-app`, two rounds, bundle facts on / off):

| Call | On | Off |
|---|---|---|
| valibot | 3.6, 4.2 s | 1.9, 1.0 s |
| zod | 7.1, 7.7 s | 2.1, 2.1 s |
| date-fns | 7.9, 8.8 s | 1.8, 1.7 s |
| motion | 10.8, 10.7 s | 2.6, 1.7 s |
| zod valibot | 7.2, 7.3 s | 1.3, 1.3 s |
| valibot zod date-fns motion | 16.3, 14.2 s | 2.2, 2.0 s |

Each pair of reports was identical apart from `generated_at`.

**Where the time goes today** (one candidate, ms from start): zod resolved at 592, installed at
1273, OSV done at 2029, builds done at 8027; motion 488, 1011, 1092, 10199. Builds start after the
install and run alongside the lookups, which all end by about 2.2 s.

**Bundle step: today against a shared pool, first prototype** (the whole build and every export,
recycling after 100 builds; the two listing builds were not run in the pool, which took the names
from today's run, so these times favor the pool slightly; superseded by the alternating runs below):

| Package (exports) | Today | 1 worker | 2 workers | 4 workers |
|---|---|---|---|---|
| valibot (321) | 3.26 s | 3.41 s | 1.86 s | 1.05 s |
| zod (260) | 6.01 s | 6.07 s | 3.84 s | 3.30 s |
| date-fns (251) | 5.95 s | 6.05 s | 3.79 s | 2.61 s |
| motion (350) | 9.32 s | 9.38 s | 5.80 s | 4.20 s |
| zod valibot | 5.80 s | 8.97 s | 5.12 s | 3.75 s |
| all four | 11.6 s | 24.4 s | 13.8 s | 9.7 s (9.2 s without recycling) |

"Today" for several packages is one child per candidate, all at once. Under load: zod at 1, 2, 4, 6
and 8 workers took 5.6, 3.7, 2.9, 2.7 and 3.0 s; motion at 2, 4 and 6 took 5.4, 3.8 and 3.6 s;
all four at 6 and 8 workers took 8.7 and 8.5 s.

**Same results:** every outcome (bytes, problems, peers) matched the sequential build in every
first-prototype run: 261, 351, 321, 251, 582 and 1184 builds, at 1 to 8 workers, with and without recycling,
with workers started in a neutral directory serving every install. Two entry layouts did not:

- A per-worker entry file name (`__depfit_entry_<i>.mjs`) changed @storybook/addon-a11y@10.6.6's lazy
  bytes by 2 B (687,903 to 687,905 min). Its lazy chunks name the entry chunk. The same name in a
  per-worker directory, or a copy of the install per worker (1.05 s to copy three), was identical.
- An entry in a per-worker directory turned biome's `NO_ENTRY` into `UNRESOLVED_IMPORT`, because
  `problemsFromBuild` recognizes the entry by its path relative to the root.
- No package in `single-reference.json` has lazy bytes, so CI's checks would not see the first one.

**Memory, first prototype** (summed resident memory of processes whose command named
`vite-build.mjs`, sampled every 150 ms; the earliest runs matched any worktree's, so another
session's worker may be counted in them; the alternating runs below sample owned processes only): one worker building
motion's exports over and over held 632 MB after 100 builds, 947 MB after 200, 1.5 GB after 500 and
2.3 GB after 1000; capped at a 384 MB heap it ran out at about build 570, so the memory is kept, not
merely uncollected. Peaks: today motion 1.4 to 1.5 GB, zod 0.8 GB, all four 3.0 to 3.1 GB. Pool with
4 workers and recycling: zod 2.0 GB, motion 2.5 GB, zod valibot 2.0 GB, all four 2.6 GB (4.1 GB
without recycling, 5.9 GB at 8 workers). A fresh worker's first build took 100 ms, later builds
11 ms (median).

**Load per call** (re-measured after a restart, under `nice -n 10`, at most 4 workers, recycling
after 100 builds, while another session's eval ran on the machine, load average 11 to 15). Each
worker's CPU time (user plus system, all threads) is read when it exits:

| Call | Workers | Wall | CPU time | Busy cores (average) |
|---|---|---|---|---|
| zod | 1 / 2 / 4 | 6.36 / 4.27 / 3.39 s | 18.2 / 18.1 / 16.9 s | 2.9 / 4.2 / 5.0 |
| motion | 1 / 2 / 4 | 9.70 / 5.62 / 4.19 s | 38.8 / 39.8 / 39.3 s | 4.0 / 7.1 / 9.4 |
| all four | 2 / 4 | 14.81 / 9.98 s | 85.9 / 87.4 s | 5.8 / 8.8 |

Today's code in the same window: zod 5.99 s, motion 9.86 s, all four 13.09 s (one child per
candidate, 3.1 GB). Among pool sizes the work per call does not change; against today's code, see
the alternating runs below. One worker already keeps about 3 to 4 cores busy, because rolldown is
multi-threaded.

**First alternating runs, the whole root operation** (their CPU totals were printed, not kept, so
they cannot be rebuilt from the files) (after the first review; superseded by the
second set below, because these started every worker at once, started a replacement before the
retiring worker exited, sampled depfit's workers but not depfit itself, and printed CPU time
without keeping it; `nice -n 10`, at most 4
workers). Each invocation measures one way on installs prepared once: today's `measureRootEntry`
for every candidate at once, or one shared pool of 4 workers running each candidate's whole build,
both listing builds and then every export, in that dependency order, recycling after 100 builds.
CPU is user plus system time of the invocation and every child, from `/usr/bin/time -l`; memory is
sampled every 100 ms over the invocation's own descendants, per process and summed. Today and pool
alternate; another session's eval ran on the machine part of the time (load average 7 to 16).

| Call (builds) | Today, wall | Pool, wall | Ratio | Today, CPU | Pool, CPU | Ratio | Today / pool memory (largest process) |
|---|---|---|---|---|---|---|---|
| clsx (5) | 0.15 s | 0.19 s | | 0.26 s | 0.64 s | 2.5x | 105 / 359 MB (103) |
| valibot (323) | 3.21, 3.17 s | 1.12, 1.15 s | 0.35x | 5.4 s | 6.4 s | 1.18x | 0.6 / 1.1 GB (285 MB) |
| zod (263) | 6.94, 5.77, 5.67 s | 3.08, 3.10, 2.98 s | 0.53x | 20.3 to 21.0 s | 20.8 s | 1.02x | 0.8 / 1.9 GB (524 MB) |
| date-fns (253) | 5.77, 5.76 s | 2.68, 2.66 s | 0.46x | 24.4 s | 26.9, 27.7 s | 1.12x | 1.0 / 2.3 GB (591 MB) |
| motion (353) | 9.97, 9.12, 9.04 s | 4.23, 4.22, 4.55 s | 0.46x | 40.5 to 42.1 s | 43.8 to 44.4 s | 1.09x | 1.5 / 2.6 GB (656 MB) |
| zod valibot (586) | 5.81, 5.84 s | 3.91, 3.92 s | 0.67x | 26.2 s | 26.5, 26.8 s | 1.02x | 1.3 / 1.6 GB (429 MB) |
| all four (1192) | 12.15, 11.86 s | 10.48, 10.27 s | 0.86x, 0.87x | 95.3, 95.2 s | 97.7, 98.3 s | 1.03x | 3.1 / 2.6 GB (683 MB) |

The largest process today is the one child per candidate (motion 1.5 GB); in the pool, a worker.
Every outcome matched across all 30 runs (each call's today and pool runs compared in full: whole
build, export names, listing problems as a set, each export). clsx's pool started 4 workers at once
for 5 builds, which is the cost on-demand start removes. Scripts and every run's output are kept with
the author's notes (local, gitignored).

**Second alternating runs** (after the second review, before #9 merged; quiet machine, load average 2
to 16 from these runs themselves, `nice -n 10`). The pool now starts a worker only when a build waits
and every live worker is busy, and waits for a worker retiring after 100 builds to exit before
starting its replacement. Memory covers depfit's own process and everything it started. Each run's
JSON and its `/usr/bin/time -l` output are kept (52 runs; every outcome identical within each call).
Time and CPU are medians; each pool experiment is compared with the today runs alternated with it;
memory is the largest sampled peak (GiB, from `ps` RSS):

| Call, workers | Pairs | Wall, today / pool | Ratio | CPU, today / pool | Ratio | Memory, today / pool (largest worker, MiB) | Started (most live) |
|---|---|---|---|---|---|---|---|
| clsx, 4 | 3 | 0.11 / 0.19 s | | 0.21 / 0.33 s | 1.57x | 0.18 / 0.18 (114) | 2 (2) |
| valibot, 4 | 3 | 2.94 / 1.10 s | 0.38x | 5.09 / 6.27 s | 1.23x | 0.71 / 1.22 (295) | 4 (4) |
| zod, 4 | 3 | 5.66 / 3.13 s | 0.55x | 20.5 / 20.6 s | 1.01x | 1.04 / 2.23 (554) | 4 (4) |
| date-fns, 4 | 3 | 5.75 / 2.69 s | 0.47x | 24.6 / 26.9 s | 1.09x | 1.13 / 2.44 (604) | 4 (4) |
| motion, 4 | 3 | 9.18 / 4.28 s | 0.47x | 40.9 / 43.9 s | 1.07x | 1.67 / 2.67 (639) | 4 (4) |
| zod valibot, 4 | 3 | 5.82 / 4.02 s | 0.69x | 26.1 / 26.9 s | 1.03x | 1.53 / 1.91 (450) | 8 (4) |
| all four, 4 | 3 | 12.13 / 10.75 s | 0.89x | 95.0 / 97.2 s | 1.02x | 3.32 / 2.95 (682) | 12 (4) |
| zod valibot, 2 | 3 | 5.86 / 5.66 s | 0.97x | 26.2 / 26.5 s | 1.01x | 1.55 / 1.38 (573) | 6 (2) |
| zod, 1 | 2 | 5.72 / 5.89 s | 1.03x | 20.3 / 20.6 s | 1.02x | 1.03 / 0.81 (589) | 3 (1) |

**Third alternating runs, as merged in #9** (c0e2a5d, after rebasing; same method). Today is
`measureRootEntry` with the default report's subpaths (`subpaths: true`, at most 30), as the CLI
calls it; the pool queues each listed subpath's whole build (once per target file) as soon as the
whole build has passed the toolchain check, alongside the exports. Subpaths built: clsx 1, zod 9,
motion 10, preact 12 targets; valibot and react-hook-form none; date-fns lists 739, over the cap, so
none. 44 runs (22 pairs), every outcome identical within each call, subpaths included:

| Call, workers | Pairs | Wall, today / pool | Ratio | CPU, today / pool | Ratio | Memory, today / pool (largest worker, MiB) | Started (most live) |
|---|---|---|---|---|---|---|---|
| clsx, 4 | 3 | 0.12 / 0.20 s | | 0.23 / 0.47 s | 2.04x | 0.18 / 0.18 (115) | 3 (3) |
| zod, 4 | 3 | 6.04 / 3.38 s | 0.56x | 21.2 / 21.6 s | 1.02x | 1.11 / 2.32 (543) | 4 (4) |
| motion, 4 | 3 | 9.67 / 4.49 s | 0.46x | 42.4 / 45.7 s | 1.08x | 1.74 / 2.76 (660) | 4 (4) |
| zod valibot, 4 | 3 | 6.32 / 4.30 s | 0.68x | 27.2 / 28.0 s | 1.03x | 1.55 / 1.98 (462) | 8 (4) |
| all four, 4 | 3 | 12.69 / 11.32 s | 0.89x | 97.6 / 100.7 s | 1.03x | 3.35 / 3.00 (701) | 16 (4) |
| all four, react-hook-form, preact, 4 | 2 | 12.87 / 11.34 s | 0.88x | 98.7 / 101.3 s | 1.03x | 3.30 / 3.02 (690) | 16 (4) |
| zod valibot, 2 | 3 | 6.36 / 6.11 s | 0.96x | 27.1 / 27.8 s | 1.03x | 1.56 / 1.40 (578) | 7 (2) |
| zod, 1 | 2 | 6.21 / 6.41 s | 1.03x | 21.3 / 21.7 s | 1.02x | 1.13 / 0.87 (613) | 3 (1) |

Today's memory includes one process per candidate (motion's: 1.4 to 1.5 GiB). The 1- and 2-worker
rows stand in for a small machine, where the rule gives as many workers as candidates. Subpaths
added 0.4 to 0.5 s to today's zod and motion and 0.25 s to the pool's; the ratios moved by at most
0.01. Valibot and date-fns build no subpaths, so their second-set numbers stand.

**Not measured:** a machine with 1 to 4 CPUs, including CI's 4-vCPU runners (worker counts 1 and 2
were run on 12 cores instead); worker counts above 4 after the restart
(the 6- and 8-worker numbers above are from before it). The research scripts are kept with the
author's notes (local, gitignored).

## Parallel builds (#7): scorecard (2026-11-08)

Built to the approved bar (SPEC.md, "Parallel builds (#7)"): `src/collect/vite-pool.ts` (the shared
pool), `src/collect/children.ts` (every child stopped on SIGINT or SIGTERM), `root-entry.ts` (a
candidate's builds at once, the result decided by today's order), `index.ts` (one pool per run).
"Today" is c0e2a5d in a separate checkout, run alternately with #7 on the same machine (Apple M4
Pro, 12 cores; default count 4) under `nice -n 10`. Scored by `eval/bundle/parallel-score.ts`;
every run's output is kept with the author's evidence (local, gitignored).

**Scorecard: passes.**

| Gate | Result |
|---|---|
| P1 (a). Same results, reference packages | Pass: 41 packages (single-reference.json, the 8 root null cases of cases.json, subpath-reference.json, @storybook/addon-a11y with its 687,903 lazy bytes), 1,290 export builds and 102 subpath builds, the measurement call (cap 100) and the default report in full: identical to today in all 8 variants (default twice, 1, 2 and 4 workers, reversed at 1 and 4, serial) |
| P1 (b). Full reports | Pass: 9 calls in `test/fixtures/browser-app` (clsx, valibot, zod, date-fns, motion, zod valibot, all four, `node:sqlite`, a missing name), 5 alternating pairs each, every #7 report identical to the today report before it apart from `generated_at`; and 32 probe calls through `eval/run.ts`, bundle facts identical, one GitHub count (`commits_last_year` 1864 to 1861) differing once and identical when the pair was run again |
| P1 (c). Stock Vite (gate C) | Pass: `ci/bundle-accuracy.ts` at `DEPFIT_BUNDLE_WORKERS=2`, 10 whole, 8 null cases, 100 exports, 51 subpaths, 0 failures (today's code: the same) |
| P1 (d). Earlier gate D | Pass: iteration 2 default reports over every probe, two #7 runs, 0 differences; the measurement call twice per probe package (88 packages), 0 differences; iteration 1 probe reports, 0 differences; iteration 1 reference singles, 0 differences. Iteration 1 A, B, C and iteration 2 A and E pass too |
| P2. Speed (5 pairs, medians) | Pass: valibot 0.39x (3.18 to 1.22 s), zod 0.53x (6.30 to 3.34 s), date-fns 0.48x, motion 0.47x (9.69 to 4.56 s); zod valibot 0.69x; all four 0.90x; six 0.90x; zod at 1 worker 1.04x, zod valibot at 2 workers 0.96x. CLI: valibot 0.47x, zod 0.59x (7.36 to 4.31 s), date-fns 0.57x, motion 0.50x (10.10 to 5.08 s), zod valibot 0.69x (7.12 to 4.94 s), all four 0.89x, clsx 0.98x; `node:sqlite` and the missing name equal (9 pairs: 0.04 and 0.38 s both ways) and start no worker |
| P3. Load and memory | Pass: CPU valibot 1.20x, zod 1.00x, date-fns 1.08x, motion 1.08x, clsx 0.50 against 0.24 s, zod valibot 1.02x, all four and six 1.03x, all inside 1.25x plus 0.1 s per allowed worker; workers started at most the allowed count plus one per 100 builds (all four: 16 for 1,211 builds); memory valibot 1.19 GiB (today 0.72), zod 2.41 (1.15), date-fns 2.48 (1.16), motion 2.88 (1.75), zod valibot 2.05 (1.55), all four 3.16 (3.32), six 3.12 (3.37), all inside their allowance; largest worker 705 MiB |
| P4. Robustness | Pass: tests with stand-in runners for the timeout from dispatch, a timeout, a crash, an unreadable result, a worker that cannot start, a dropped queued build, a subpath failure while root builds run, two failures in either completion order, a worker ignoring the end of its input (killed after the grace period, also when it is retiring and another build waits), and SIGINT or SIGTERM at start-up, during builds, during a recycle, with a worker that ignores SIGTERM (killed after 2 s), and during an install whose npm started a process of its own (every PID gone); no worker after a CLI run; no browser signal: 0 Vite or rolldown modules loaded |
| P5. Contract and CI | Pass locally: no field, reason or schema change; type check, lint, format, unit tests on Node and Bun (267), `ci/e2e.ts`, `ci/bundle-accuracy.ts`. CI runs the measurement steps at 2 workers and the CLI step at the default; `ci/perf.ts` gates `bundle.subpaths.<package>` at a 2 s baseline |
| Earlier cost gates | Pass: iteration 1 gate F, median 324 ms (max 1.5 s); iteration 2 gate F on the serial schedule, median 0 ms, p90 85 ms, max 915 ms (shiki); the default call's bound over 32 probe calls: none above 1.1x today's plus 0.2 s, median ratio 0.74 (total 144.6 to 81.9 s) |

Decisions made while building, for review:

- **The entry module is labeled by its file name** wherever it is written (`vite-build.mjs`), so a
  worker's entry in `.depfit-w<n>/` under the install root is still recognized by the checks
  (`NO_ENTRY`). For today's entry in the root the label was already the file name.
- **An unreadable result now ends its worker**, as an exit or a timeout does; before, it failed that
  one build and the root phase then threw anyway.
- **A call measured without a pool** (the eval and CI scripts call `measureRootEntry` directly) uses
  one of its own, `bundleWorkers(1)` workers, closed before it returns.
- **Queued builds of a candidate are dropped** once its result is decided by a failure, so a package
  whose builds all crash does not start a worker per build.

Code review (Codex gpt-6.1-sol, high effort, read-only), on the diff with the bar and this
scorecard: not ready, three findings, all fixed and checked by tests that fail on the code before
the fix:

1. A retiring worker that never exits kept its place, so with one worker the next build never
   started (only `close` had a deadline). A retiring worker is now killed after the same 2 s grace.
2. On a signal, only direct children got SIGTERM and depfit ended at once: a child ignoring SIGTERM,
   or a process npm started, survived. Now every process descending from depfit (read from `ps`
   before any is signalled) gets SIGTERM, any left after 2 s is killed, a child started meanwhile
   is killed at once, and then depfit ends with the signal.
3. Timing-sensitive tests: the scripted stand-in runner imported Vite, a timeout test gave a fresh
   worker 200 ms, and the real-Vite comparison ran four pools at once. The runner now reads the pins
   from package.json, the timeout tests use 1.5 s limits with the gap still deciding them, and the
   real-Vite variants run one after another.

After the fixes, P1 (a) (41 packages, 8 variants), gate C, `ci/e2e.ts` on Bun and Node, and the
unit tests were rerun: unchanged results, all pass. The speed and load pairs were not rerun: the
fixes change only what happens to a worker that does not exit on its own, which Vite's do.

## Cache (#8): measurements for the bar (2026-11-08)

**Bar drafted and revised after review, pending the user's approval.** Measured for SPEC.md "Cache (#8)" on an Apple M4 Pro
(12 cores), Node 24.14.1, Bun 1.3.14, npm 11.11.0, at 573991c, every command under `nice -n 10`,
one at a time, at most 4 Vite workers, over the real registry from a home network. Research scripts
are outside the repo and reuse depfit's own functions (`resolvePackage`, `advisories`,
`githubFacts`, `weeklyDownloads`, `typesPackage`, `dependencyVulnerabilities`,
`withIsolatedInstall`, `measureRootEntry`). No cache code exists yet, so the hit times below are a
simulation of its critical path, not a run of it.

One batch was discarded: the first CLI timings ran before `bun install` in this worktree, so Bun
auto-installed Vite 8.3.6 and every build crashed (`BUNDLER_ERROR`, bundle on and off took the same
time). That is also why the bar never caches a `BUNDLER_ERROR`.

**Lock-only resolution against a full install** (`npm install [--package-lock-only] <spec>` with
depfit's flags in an empty temp directory, warm npm cache; medians of rounds 2 to 4, ms; round 1
was the warm-up and its full install is shown as "first"):

| Package (tree) | Full install | First | Lock-only | Lock-only, `--prefer-online` | `npm ci` from the lock-only lockfile |
|---|---|---|---|---|---|
| clsx (1) | 136 | 141 | 123 | 479 | 139 |
| zod (1) | 237 | 238 | 133 | 505 | 222 |
| valibot (1) | 183 | 544 | 167 | 624 | 130 |
| date-fns (1) | 534 | 500 | 140 | 488 | 517 |
| motion (5) | 425 | 2216 | 306 | 2128 | 249 |
| react-hook-form (2) | 206 | 567 | 170 | 721 | 160 |
| @tanstack/react-form (10) | 281 | 1451 | 229 | 1742 | 181 |
| shiki (45) | 359 | 2473 | 185 | 2468 | 305 |
| @mui/material (36) | 714 | 3423 | 363 | 3028 | 475 |
| next (54) | 2219 | 4395 | 528 | 2443 | 1829 |

In all 40 runs every `packages` entry other than the root was identical, all fields, between the
lock-only lockfile and the full install's, and the lockfile `npm ci` wrote from it matched on
version, `resolved`, `integrity` and the dev, optional and peer flags. The root entry, the
installed files and `readTree`'s facts were not compared; gate K1 covers them.

**Lock-only on a stale npm cache** (a private npm cache filled at 13:10, timed at 13:17, past
npm's 300 s freshness, then again at once; s): zod 0.65 then 0.15, motion 2.22 then 0.32,
@tanstack/react-form 1.88 then 0.25, shiki 2.46 then 0.20, @mui/material 2.90 then 0.38, next 2.23
then 0.56. On the empty cache it took 0.77 to 4.72 s. `--prefer-online` matches the stale case.
The registry sends `cache-control: public, max-age=300` for packuments.

**Conditional revalidation** of every package in the tree (abbreviated packuments, the `Accept`
header npm sends, `If-None-Match` with the ETag, all at once; 3 rounds, ms): zod 87 to 255 (1
packument), motion 94 to 95 (5), @tanstack/react-form 108 to 131 (10), shiki 109 to 125 (45),
@mui/material 111 to 116 (33), next 145 to 154 (54). Every response was 304. Fetching the same
packuments in full took 0.39 to 0.87 s and 1.2 to 63 MB. A HEAD request's ETag gives a 304 on a
conditional GET (next, zod, @types/node). `Last-Modified` was 2 to 10 s after the packument's
`modified` field for zod, next, typescript, react, @types/node and motion.

**Which packuments npm reads** (npm's cache index after a resolution into an empty cache, against
the names in the lockfile): react-hook-form 3 for a tree of 2, @tanstack/react-form 10 of 10, shiki
45 of 45, @mui/material 37 for 33, next 58 for 54, motion 14 for 5. The extra ones are optional
peers and similar. Adding every dependency and peer named in the installed manifests still missed 6
of motion's and 1 of @mui/material's, so the bar takes the set from npm's own log:
`--loglevel=http` prints one `npm http fetch` or `npm http cache` line per packument URL.

**How often the recording rule applies** (one lock-only resolution per package with
`--loglevel=http`, then a HEAD request for every logged URL, against the rule in SPEC.md): all 10
packages of the table above qualify, every log line a `hit`. The youngest packument in any tree was
typescript's, last modified 611 minutes earlier (an optional peer valibot's resolution reads; it
publishes nightly), then playwright's at 798 minutes (motion, next). So a tree that reads
typescript gets new validators about once a day, and its first call after that takes step 3.
Run once, on one day; the preflight measures the rate on the full corpus.

**Probes, once per run:** `npm config list --json` 67 to 77 ms (170 keys, including `npm-version`,
`registry`, `legacy-peer-deps`; identical from two different directories); `node -p` 25 ms.

**A hit's critical path, simulated** (resolve the version; then, at once: the live lookups, the
probes, conditional revalidation of every URL npm logged for the tree, reading a 100 KB file, and
dependency OSV on the stored tree; 5 rounds, ms, median and range). CLI start-up and the project
scan come on top (CI's baseline for `--schema`: 64 ms on Bun):

| Package | Total | Revalidation done after resolve |
|---|---|---|
| zod | 617 (499 to 1047) | 90 to 100 |
| valibot | 460 (435 to 510) | 84 to 90 |
| motion | 590 (557 to 990) | 92 to 261 |
| shiki | 762 (613 to 812) | 115 to 288 |
| @mui/material | 788 (730 to 920) | 166 to 242 |
| next | 1659 (1074 to 1741) | 126 to 718 |

The same path with lock-only resolution (fresh npm cache) in place of revalidation: zod 483 to
2295, valibot 442 to 466, motion 837 to 920, shiki 723 to 1003, @mui/material 990 to 1149, next
1536 to 1753. Dependency OSV, which needs the tree, is the long pole for trees with dependencies
(about 0.3 to 0.45 s after the tree is known); next's resolve (0.54 to 0.73 s, a large packument)
and OSV (1.1 to 1.6 s) dominate it.

**Today's CLI** (`test/fixtures/browser-app`, 3 rounds, s, median; bundle facts on / with
`DEPFIT_BUNDLE=0`, which still installs): zod 4.18 / 1.32, valibot 1.76 / 1.75, motion 5.19 / 2.01,
shiki 5.09 / 1.75, `zod valibot` 4.90 / 1.27, clsx 1.03 / 1.86. The off column varies with the
network (valibot 1.06 to 1.89).

**Cache entry sizes** (the measurement with the subpath cap of 100, what #10 reads; the overview's
with the cap of 30 was the same size for all eight; install facts as `readTree` gives them; the
install directory by `du`):

| Package | Exports | Subpaths built | Measurement (gzip) | Install facts | Install dir (files) |
|---|---|---|---|---|---|
| clsx | 2 | 1 | 0.8 KB (0.2) | 0.2 KB | 0.1 MB (16) |
| zod | 260 | 9 | 48.4 KB (4.5) | 0.2 KB | 8.1 MB (851) |
| valibot | 320 | 0 | 57.7 KB (5.2) | 0.2 KB | 1.9 MB (23) |
| date-fns | 250 | over the cap | 46.6 KB (4.0) | 0.2 KB | 26.5 MB (5,148) |
| motion | 350 | 10 | 67.8 KB (7.0) | 1.2 KB | 16.4 MB (1,046) |
| react-hook-form | 18 | 0 | 3.7 KB (0.6) | 0.4 KB | 2.6 MB (269) |
| shiki | 54 | 10 | 12.9 KB (1.6) | 13.5 KB | 21.9 MB (2,432) |
| @mui/material | 474 | over the cap | 98.7 KB (9.0) | 11.0 KB | 38.5 MB (5,428) |

next's install is 337 MB (10,386 files). Renaming an install directory took 6 ms; deleting one,
which today's code does at the end of every install, took 0.31 s (@mui/material), 0.28 s
(date-fns) and 0.67 s (next).

**Not measured:** Linux, Windows and CI's runners; private registries; concurrent runs; a range
floating in the wild (nothing can be published to npm for it; gate K2 (b) uses a local test
registry instead); and the cache itself, which does not exist yet.

**Independent review of the bar** (Codex gpt-6.1-sol, high effort, read-only, 2026-11-08), on the
first draft and the raw outputs: **not ready**, eleven findings, all applied in the revised text:

1. Must-fix: the age window alone does not show what npm read, since npm serves a stale cached
   packument when a revalidation fails. Now no validators are recorded unless every log line is a
   network fetch or `hit`, `revalidated` or `updated` (npm logs that case as `stale`), with a test.
2. Must-fix: one lockfile can install different trees (`omit=optional` keeps omitted packages in
   it). The npm settings hash is now in the entry key and the install directory's name, and install
   facts are cached only when every missing package is excluded by `os`, `cpu` or `libc`.
3. Must-fix: `npm config list --json` omits credentials. The text says so, and validators are
   recorded only for npmjs URLs that answer without credentials.
4. Must-fix: caching every code but `BUNDLER_ERROR` would keep transient failures
   (`SUBPATH_LIST_FAILED` from a read error, unreadable directories in `readTree`). Now only codes
   that depend on the package alone are cached, with recovery tests.
5. Must-fix: a 15-minute grace does not protect a concurrent reader of an install. No #8 run reads a
   kept install, so the grace is gone, and #10 must define how a run takes hold of one.
6. Must-fix: the limits could not be enforced with exemptions. Nothing published is exempt now, an
   oversized install is not kept, eviction runs after every run that opened the cache, staging of
   dead runs is removed, and the limits are soft only by work in flight; file system tests added.
7. Must-fix: `measured_at` could not promise an order relative to `generated_at` (a concurrent run
   can publish later), nor a time when no build completed. It is now the stored measurement's time,
   null when no build completed.
8. Should-fix: the identity left out Vite's own dependencies. It now lists Vite's installed closure.
9. Should-fix: the speed targets rest on a simulation that recorded validators unconditionally. K5
   is now provisional until a preflight, the rule's rate was measured (above), and the 50 ms
   budget's scope is defined.
10. Should-fix: the test-registry gate needed freshness control, mutations that change the tree,
    and a seam, since the CLI resolves on npmjs. All three are now specified.
11. Should-fix: STATUS claimed more lockfile equality than the script checked. Narrowed, and step 3
    now starts in a directory with no lockfile or `node_modules`.

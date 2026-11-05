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
- **Peers:** installed for `cost`, left out of every bundle and listed in `external_packages`.
- **Eager vs lazy:** eager is the entry chunk plus its static-import closure; lazy is the rest of
  what `import()` reaches. Never summed.
- **Band, gross error, reviewed exceptions, references** (rollup 4 + terser, webpack 5), and every
  v1 settled question that does not concern snippets.
- **Stop conditions** (below), unchanged.

## Iterations, safest first

Each iteration is its own PR. Its acceptance bar is written into this file before its code, and
the next iteration starts only after the current one passes and its scorecard is in `STATUS.md`.

| # | Ships | Bar |
|---|---|---|
| 0 | Remove `--bundle-entry` from the CLI and schema. Keep the engine, and keep snippet measurement as an eval-only library call for ground truth. | Below |
| 1 | Root entry point, measured two ways, for browser workspaces only. | Below |
| 2 | Each subpath in the package's `exports` map, measured whole. | Written before iteration 2 |
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
| `external_packages` | Peers left out, as v5 |

A whole-package null keeps its reason code in `unavailable`, as in v5. Unmeasured exports add
one entry: `bundle: <n> exports unmeasurable (<codes>)`. `schema-docs` says each number is a
standalone build of the named import, that neither is the reader's usage nor marginal cost, and
that real usage of a few exports usually lies between the two.

Deliberately left out: the heaviest export and its name, lazy bytes per export, and min/p90. Add
them in a later iteration only if gate H shows readers need them.

### Gates

| Gate | Pass condition |
|---|---|
| **A. Honesty** | Every v1 null case that measures the root entry point returns its expected code. 0 gross errors on whole or single-export numbers. |
| **B. Accuracy** | **Whole:** gate W's corpus (about 200 packages, `import * as m`, the exact whole-package build) passes W's conditions (i)–(iii) against its existing references. **Single export:** a fixed reference set of 20 wild-corpus packages with at least 10 exports, as counted by the rollup reference build, not by depfit (the first 20 in `wild.json` order) × 5 exports each (evenly spaced over sorted names) is in band against rollup + webpack, or covered by a reviewed exception; 0 gross errors. |
| **C. Vite conformance** | For the 20 × 5 set and 10 whole-package cases, depfit's bytes equal a stock `vite build` made by `reference.ts` without depfit's code: min bytes identical, gzip within 1%. |
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
| Static Preact site, Vite | `preact`, `index.html` |
| Preact + CodeMirror notes app, Vite | `preact`, `index.html` |
| Next.js app | `next`, `react-dom` |
| Vite + React apps (4 workspaces) | `react-dom`, `index.html` where present |
| React application package (no app shell) | `react-dom` |
| Astro portfolio and Astro marketing site | `astro` |
| Next.js docs app in a UI-library monorepo | `next`, `react-dom` |
| Electron app with a React renderer | `react-dom` (renderer counts) |
| Expo app with `react-dom` | `react-dom` (known limit: a React Native bundle is not a browser bundle) |
| depfit itself (`vite` as a tool) | none |
| Bun TUI, Bun CLI, two Node servers, a Cloudflare Workers API, a Bun resume builder, a TypeScript-only package, an Electron main-process app | none |

Exact workspace paths are kept with the probes (local, gitignored).

### Holdout probes

10 browser questions, frozen on 2026-10-19 before any iteration-1 code, in `eval/probes.json`
with `"set": "holdout-1"` (local, gitignored). Their sha256 is recorded in `STATUS.md`. Ground-truth
snippets for them are written blind by agents, validated, and used by the eval only, as in round 4.

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

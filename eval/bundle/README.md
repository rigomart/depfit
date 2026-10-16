# Bundle-size evaluation

The acceptance bar is [SPEC.md](SPEC.md); bundler settings are in [SETTINGS.md](SETTINGS.md). This
directory holds the harness that measures the bar.

```bash
bun eval/bundle/reference.ts [caseId...]   # builds reference.json: rollup + webpack, plus Vite for mandatory browser cases (~2 min)
bun eval/bundle/score.ts [--runs 2] [--step workers|non-js|all] [caseId...]
bun eval/bundle/score.ts --record-v4       # once, on code without the feature (gate E)
bun eval/bundle/wild-select.ts             # once: builds wild.json by the rule below (never re-run to move the corpus)
bun eval/bundle/reference.ts --wild        # builds wild-reference.json and runs the auditor (~1 h)
bun eval/bundle/score.ts --wild [--resume] # gate W
bun eval/bundle/comprehension.ts [results.json] [caseId...]   # gate H0 prompt and key
```

`DEPFIT_CLI` points `score.ts` and `comprehension.ts` at another build of the CLI.

## Gates

`score.ts` prints the scorecard for gates A-F on step 1 cases (the SPEC's table is authoritative).
Non-JS and Workers cases (`step` other than `"1"`) are excluded unless `--step` adds them.

| Gate | What `score.ts` checks |
|---|---|
| A. Honesty | Every `null` case returns its expected `bundle: <code>` (and specifier). No number is a gross error (outside `[0.5 x min(ref), 2 x max(ref)]`) on any of the four byte fields. |
| B. Accuracy | Every `measure` case, eager and lazy, minified and gzip 9 (four fields), is inside the rollup/webpack band `0.90 x min(ref) - 100 B .. 1.10 x max(ref) + 100 B`. Mandatory cases must be in band; the others may be null with a code (at most 2). |
| C. Vite anchor | For each `mandatory` browser measure case, `eager_js_gzip9_bytes` and `eager_js_min_bytes` are within +-3% of a real `vite build` of the same snippet with Vite's own injected dynamic-import runtime removed (the `vite_anchor` entry in `reference.json`, see "Gate C normalization"). A regression check for "matches what Vite ships", not ground truth. Vite is not part of the band in B. A case without a usable anchor counts as failing; none is excluded. |
| D. Determinism | Two runs (`--runs 2`) give identical bytes and reasons. |
| E. Contract | Every package has a `bundle` key (null without `--bundle-entry`); the SPEC's `packages[].bundle.*` fields have `schema-docs` entries; every other field is identical with and without `--bundle-entry`; the output keys match the v4 baseline. When a non-bundle field differs, the failure line and the results file (`contract_diff`) hold its path and both values, so a flaky live source can be told from a real leak. A difference that disappears once failed network sources are ignored (an `unavailable` entry from osv, github, downloads, types or registry that responded 429/5xx or timed out, with the fields it nulls) makes `score.ts` run that case's pair once more after a pause; if it persists it is listed as a "network flake", apart from real failures, and does not fail E. Any other difference fails. `score.ts` pauses 3 s after every CLI run, like `eval/run.ts`, so a full run does not trigger the 429s itself. |
| F. Cost | Pass: rolldown is never loaded without bundling, and the median overhead of `--bundle-entry` is at most 1500 ms. The no-bundle runtime against the v4 baseline is printed as advisory (network noise is about +-20%) and never fails the gate. |
| H0. Comprehension | Not run by `score.ts`. `comprehension.ts` writes `results/comprehension/prompt.md` (depfit's `--json` for `sonner-named`, `shiki-codeToHtml`, `node-pty-named` and `simple-git-default`, `depfit --schema`, and six questions) and `results/comprehension/comprehension-key.md` (the answers; never show it to the reader). Give a blind small-model reader only the prompt; the gate passes when it answers all six correctly in 3 of 3 runs (question 6: node-pty has a number; does that mean it works in a browser, and which fields say whether it can). |

`score.ts` stores the full `--json` output of the four H0 cases in its results file, and
`comprehension.ts` reads it from the latest `results/*.json` (or the file you name). A case missing
from that file is run live. Naming case ids replaces the four fixed cases.

Gates G and H need later steps and are not scored here. Gate W is scored by `score.ts --wild`.

### Webpack context modules

webpack turns `require("./locale/" + x)` into a context module that bundles every file the
expression could match; Rollup-family bundlers (Vite, depfit) leave the call. When the webpack
reference build contains a context module, `reference.ts` records `webpack_context_modules` and a
`band_excluded.webpack` reason in `reference.json`, and the band is built from the other
reference only. The check looks at webpack's module classes (`ContextModule`), never at byte
numbers, and applies to any case: moment and node-pty are the current ones.

### Drift

`locks/<id>.json` freezes each case's dependency tree. `score.ts` compares it with depfit's
`cost.new_packages` (an empty scratch project, so the whole tree is new) in both directions: a
non-optional locked package depfit did not install, and a package depfit installed that the lock
has no entry for. Peers are the one expected difference: depfit installs them and the lock does not,
so `reference.ts` records what npm adds to the frozen lock when peers are honored
(`peer_only_packages` in `reference.json`) and those are not counted as extra. A drifted case is excluded from every size gate (A, B and C) in
comparisons and totals; it still counts for D, E and F. The scorecard prints how many cases were excluded and
which, so they are re-baselined rather than forgotten.

### Gate C normalization

Vite instruments every dynamic `import()` in a build: it wraps the call in
`__vitePreload(() => import("./x.js"), __vite__mapDeps([...]), import.meta.url)`, adds a
`__vite__mapDeps` table that lists chunk files, and emits the preload helper. That is Vite's
runtime, not the package's, and depfit (plain rolldown) does not add it. Comparing against stock
Vite therefore excluded every case with lazy chunks, which was a weaker gate. Instead `reference.ts`
computes Vite's numbers with the runtime removed, by a method that does not look at any case:

1. Build the case with `build.modulePreload: false`, Vite's own switch (`vite_no_preload`). It
   stops the per-import wrapping and drops the `__vite__mapDeps` table, the two parts that grow
   with the package. Vite 8 still emits the helper function itself, unreferenced, in the entry
   chunk.
2. Remove that helper by its measured cost. A control with no package in it (one `import()` of an
   empty module) is built once by Vite with `modulePreload: false` and once by bare rolldown (same
   version and options, no Vite plugins). The difference is the helper:
   `vite_preload_helper_control` in `reference.json` (min and gzip 9 bytes, a constant of the Vite
   version).
3. The helper is subtracted only for a case whose stock Vite build differs from its
   `modulePreload: false` build (the stock build had the instrumentation). `vite_anchor` holds the
   result and how much was removed. Cases without dynamic imports are unchanged (in the current reference their stock and
   `vite_no_preload` numbers are identical).

Gzip is not additive, so the subtracted gzip figure is an estimate of the helper's contribution,
good to a few tens of bytes on the one case that needs it (shiki, 0.1% of its size), far inside the
3% tolerance. If a Vite release changes how it injects the runtime, the control no longer
describes it: rebuild and re-check that the control still equals the stock-minus-switch residue.

`reference.ts` re-runs itself under Node so gzip (`node:zlib`, level 9) is identical whichever
runtime started it. Bundlers are installed into a temp dir at the exact versions pinned in
`reference.ts`; nothing is added to the repo's `package.json`. `score.ts` needs the depfit CLI and
network, and writes `results/<timestamp>.json` (gitignored).

## cases.json

An array of cases. Ids are stable.

| Field | Meaning |
|---|---|
| `id`, `package`, `version` | Case id; the candidate, pinned to an exact version. |
| `imports` | Array of import statements, see below. |
| `target` | `browser` or `workerd`. |
| `step` | Feature step that scores the case: `"1"` (browser, JS only), `"workers"`, `"non-js"` (CSS, assets, wasm). `score.ts` scores step 1 unless `--step` adds more; `reference.ts` always builds all (Vite only for step 1 `mandatory` browser cases). |
| `class` | Tags for the failure class the case covers. |
| `expect` | `"measure"` (a number inside the reference band) or `"null"` (bytes null plus a `bundle:` entry in `unavailable`). |
| `code`, `specifier` | Null cases only. `unavailable` must contain `bundle: <code>`, followed by `specifier` when the case gives one. Codes: `UNRESOLVED_IMPORT`, `MISSING_EXPORT`, `IMPORT_OUTSIDE_BUNDLE`, `NO_ENTRY`, `NON_JS_IMPORT`. |
| `reason` | Null cases only: why the null is the honest answer. |
| `mandatory` | Optional. The case must be in band (or return its code); it cannot be one of the tolerated nulls in gate B. |
| `notes` | Why the case exists. |
| `history` | Old depfit outputs, kept for context. Not read by any script. |

An import statement is `{ "from", "named"?, "default"?, "namespace"?, "members"? }`:

- `from`: the specifier, which is the package or one of its subpaths (`pkg/sub`).
- `named`: names in `import { a, b }`. `default: true` adds a default import, `namespace: true`
  adds `import * as ns`.
- `members`: `<binding>.<prop>` accesses to keep alive instead of the binding itself, where
  `<binding>` is a name from `named`, `default`, or `*`. Without members every binding is kept
  whole.
- Only `from`: a side-effect import (`import "pkg"`).

Example: `{ "from": "zod", "named": ["z"], "members": ["z.object", "z.string"] }` is
`import { z } from "zod"; z.object; z.string;`.

## Files

- `cases.ts`: loads and validates cases; `snippetParts` turns `imports` into JS; `entryArgs` (one
  function) is the only place that renders `imports` as a `--bundle-entry` snippet.
- `reference.ts`, `reference.json`: rollup 4 + terser and webpack 5 sizes per case (and, for null
  cases, whether they build). Per case and bundler: `min_bytes`, `gzip_bytes` (eager JS, gzip
  level 9 per chunk, summed), `lazy_min_bytes`, `lazy_gzip_bytes` (every chunk reached only
  through `import()`, each counted once), `css_bytes_unminified`, `asset_bytes_not_inlined`,
  `wasm_bytes`, or `{ error }`. Only the four JS fields are scored. `mandatory` browser measure
  cases also get a `vite` entry with the same fields, from a real `vite build` (pinned exactly):
  library-less app mode from an `index.html`, Vite's default client production settings except no
  asset inlining, peers external, no modulepreload polyfill and no CSS code split. It is gate C's
  anchor, kept apart from the rollup/webpack band because Vite 8 bundles with rolldown. Those
  cases also get `vite_no_preload` (the same build with `modulePreload: false`) and `vite_anchor`
  (the numbers gate C scores, see "Gate C normalization"); `vite_preload_helper_control` sits at
  the top level. Tool versions (including Vite's rolldown) are recorded in the file. A snippet
  that keeps nothing (side-effect-only imports) is built without the `globalThis.__depfit = [...]`
  keep-alive line, so the reference measures exactly what the CLI measures.
- `comprehension.ts`: writes the gate H0 prompt and answer key under `results/comprehension/`.
- `locks/<id>.json`: the resolved dependency tree of each case (installed without peers). The
  reference build runs `npm ci` from it, so references do not move when dependencies publish.
  Delete a lock to re-resolve it. `score.ts` flags a case as drifted when the lock and depfit's
  `cost.new_packages` disagree in either direction (see "Drift").
- `score.ts`: runs the CLI per case and scores gates A-F. `REPORT_FIELD` is the only place that
  names depfit's JSON fields.
- `trace-loads.js`: Bun preload that records whether rolldown was loaded (gate F).
- `results/`: scorecards and the v4 baseline (gitignored).

## Gate W: wild corpus

### Selection rule

Written on 2026-10-16 before anything was fetched. It is never changed after seeing depfit's
results; a change forced by an API (not by results) is recorded here with its reason.

1. **Candidates.** For each keyword in `react`, `browser`, `dom`, `frontend`, `ui`, take the first
   500 results of npm's search in its default ranking:
   `GET https://registry.npmjs.org/-/v1/search?text=keywords:<keyword>&size=250&from=0` and
   `from=250`. The candidate set is the union.
2. **Rank.** By last-month downloads (`GET https://api.npmjs.org/downloads/point/last-month/<name>`),
   descending, ties by name.
3. **Exclude**, walking down the ranking, until 200 packages are kept:
   - names starting with `@types/`;
   - packages that are `package` of a case in `cases.json`;
   - packages whose `latest` manifest has a `deprecated` message;
   - packages with no JS entry: the `latest` manifest has none of `main`, `module`, `exports`,
     `browser`. (Conservative: a package that relies on the implicit `index.js` is dropped.)
4. **Pin** each package at `dist-tags.latest` when the corpus is built. `wild.json` stores
   `name`, `version` and the selection-time `downloads_last_month`.
5. **Entry.** `import * as m from "<name>"`, namespace kept whole, `browser` target, the same
   settings as every other case.
6. **No replacements.** A package whose reference build or depfit run fails stays in the corpus and
   is counted as such. Nothing is swapped in or out after the first depfit run.

### The auditor

`wild-audit.ts` looks for hidden runtime loads in the rollup and webpack outputs of every wild
package. It is independent of depfit's detector on purpose: it imports nothing from `src/` and does
not parse or resolve scopes. It matches the spellings of a load as text, so a blind spot in one
approach is unlikely to be the same blind spot in the other. Its patterns were fixed before any
wild package was built.

Hits have three strengths:

- **fetch**: code fetched from outside the bundle, which the emitted bytes understate: an `import(`
  whose target is not an emitted chunk, and `importScripts`. Gate W (i) counts only these.
- **load** (information only): `require(...)` in any form (`require(`, `(0, require)(`,
  `module.require(`, `globalThis.require(`, `x["require"]`, `__non_webpack_require__`),
  `createRequire`, `dlopen`, `process.binding(`, `eval(` (also `(0, eval)(`, `x.eval(`,
  `x["eval"]`), `Function(` and `new Function(` (also `x.Function(`, `x["Function"]`,
  `.constructor("return ...")`), the commonjs plugin's dynamic-require stub, `MODULE_NOT_FOUND`.
  The SPEC's number is emitted bytes with no claim that the code runs, so these are reported, not
  failed.
- **mention** (information only): any other occurrence of `require`, `eval`, `Function`
  (`typeof require`, a property named `require`, `x instanceof Function`).

Two things are ignored by construction: `import("./chunk.js")` to a chunk of the same build, and
webpack's `import("./" + chunkFile)` loader; and webpack's own
`try{return this||new Function("return this")()}` global-object helper, which the same package text
would still show in the rollup output. Each hit keeps its count and the first snippet.

Per package, `wild-reference.json` holds the rollup and webpack sizes, the externalized peers, and
`audit.rollup` / `audit.webpack` (null when that build failed, so there was no output to scan).
References are built with the same settings as every other case, from locks frozen in
`locks/wild/`. Builds time out after 10 minutes; a timeout or a build error is an `error` entry,
and the package stays in the corpus.

### Scoring

`score.ts --wild` runs the CLI once per package (`<name>@<version> --bundle-entry 'import * as m
from "<name>";'`), two at a time with a 3 s pause after each run, as `eval/run.ts` does, and writes
`results/wild-<timestamp>.json` (per-package results in `results/wild-run/`, so `--resume` can
continue an interrupted run). Each package is a **number** (all four byte fields), a **null** (all
four null, with a `bundle: <CODE>` entry) or a CLI **error** (anything else).

| Check | Pass |
|---|---|
| (i) | 0 packages where depfit gives a number and the auditor found a `fetch` hit (code fetched from outside the bundle) in the rollup or webpack output. All of them are listed with the matches. |
| (ii) | 0 gross errors: no number outside `[0.5 x min(ref) - 100 B, 2 x max(ref) + 100 B]` on any of the four fields, over the rollup and webpack builds that succeeded (a bundler in the case's `band_excluded` is left out). |
| (iii) | Every package is a number or a null that carries a code. A CLI failure, or a null without a `bundle:` entry, fails. |

The report also gives the null rate by code (no threshold), numbers outside the band but not gross,
numbers for which neither reference built (nothing to check them against), and how many numbers the
auditor flags with the information-only `load` hits.

Files: `wild-select.ts` (builds `wild.json`), `wild.json`, `wild-reference.json`,
`wild-audit.ts`, `wild-score.ts`, `locks/wild/`, `harness.ts` (CLI runner and bands shared by
`score.ts` and `wild-score.ts`).

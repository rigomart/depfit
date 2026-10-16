# Bundle size: acceptance bar

Bundle size returns only when it passes this bar. It was cut in schema v4 because its numbers were
wrong in ways evaluators could not see: full-namespace imports 25–100x too large, failed builds
retried into tiny numbers, dynamic imports inlined, Node conditions on browser builds. Those numbers
still drove decisions (7/10 in eval round 1), so a wrong number is worse than none.

Principle: **depfit reports the bytes a real production bundler emits for a given import, or null
with a reason code. Never a guess.** The number is a size, never a claim that the code runs on the
target. A package that throws in a browser (ws's stub, node-pty's native loader) still ships those
bytes. Whether it works is answered by other facts (`cost.native_binaries`, `engines`), not by this
number.

## What is measured

- **Input:** a JS snippet the agent writes (step 1) or the repo's own imports (step 2). Never an
  assumed full-package import.
- **Engine:** rolldown, configured like Vite 8's client build (Vite 8 bundles with rolldown).
  Settings are in `SETTINGS.md`.
- **Target:** `browser` only until step 3 (Workers).
- **Peers:** installed as today, so the `cost` fields keep their peers. Excluded only at bundle
  time and listed. Their cost is already in `cost` and `peer_dependencies`.
- **Eager vs lazy:** eager is the entry chunk plus the closure of its static imports. Lazy is every
  chunk reachable through dynamic `import()` minus the eager set. Each chunk counts once. They are
  never summed.
- **Non-JS imports** (CSS, wasm, URL assets): null with `NON_JS_IMPORT` until step 4. Mapping them
  to empty modules or URLs produces code that builds but is broken.
- **Unmeasurable inputs** get null bytes and a `bundle: <CODE> [specifier]` entry in `unavailable`.
  Codes:
  - `UNRESOLVED_IMPORT`: warnings are escalated to errors.
  - `MISSING_EXPORT`.
  - `IMPORT_OUTSIDE_BUNDLE <specifier>`: the output still contains an `import()` or static import
    whose target is not an emitted chunk and not an external peer (e.g. `import("https://…")`).
    That code would be fetched at runtime and is not in the bytes. This is the only way emitted bytes
    understate what loads, and it is checked structurally from the chunk graph.
  - `NO_ENTRY`.

  **History of this rule.** Step 1 first flagged "opaque runtime loads" with a pattern list, which
  review bypassed (`globalThis.require`, `eval`). Then it tried a structural free-identifier rule,
  which nulled 13 of 27 real cases on harmless environment checks (`typeof process`,
  `Function("return this")`) and still had gaps. Proving that nothing loads at runtime can't be done
  statically. Most such loads are dead code in a browser, or belong to a package that doesn't work
  there, and in both cases the emitted bytes are still correct. So the claim was narrowed to emitted
  bytes, and only `IMPORT_OUTSIDE_BUNDLE` remains (user decision).
  - `NON_JS_IMPORT`.
  - Any other bundler error passes through with the bundler's own code (e.g. `PARSE_ERROR`).

  Failed builds are never retried with failures marked external.

## Contract (schema v5, step 1)

CLI: `depfit zod --bundle-entry 'import { z } from "zod"; z.object; z.string'`

- The option is repeatable, one snippet per candidate.
- A snippet may contain only import declarations from one candidate (or its subpaths) and bare
  member-expression statements on imported bindings. Anything else is a usage error.
- Bindings with no member statements are kept whole (`import * as m from "x"` keeps all of `m`).
- Side-effect imports (`import "core-js/stable"`) are measured as written.
- JS is used instead of a mini-language because agents write it fluently, it has no shell-expansion
  or scoped-name ambiguity, and it states what is kept.
- Bare `--bundle` is reserved for step 2 (repo usage).

`packages[].bundle` is null when bundling was not requested for that package. Otherwise:

| Field | Meaning |
|---|---|
| `bundler` | e.g. `rolldown@1.2.14` |
| `target` | `browser` |
| `entry` | Normalized snippet that was measured |
| `entry_source` | `requested` (step 1); `repo_usage` (step 2) |
| `eager_js_min_bytes`, `eager_js_gzip9_bytes` | Eager JS, minified, then gzip level 9 per chunk, summed. Null when unmeasurable. |
| `lazy_js_min_bytes`, `lazy_js_gzip9_bytes` | Lazy chunks. 0 when there are none, null when unmeasurable. |
| `external_packages` | Peers (and their subpaths) left out of the bundle |

Bundling never changes another field of the report.

## Evaluation

All cases use public packages at pinned versions, so the suite is committed.

- **`cases.json`:** `measure` cases, and `null` cases with an expected `code` (and specifier).
  - `mandatory: true` marks cases that alone test a failure class: member shaking, namespace vs
    named, root vs subpath, production conditions, peers, lazy split, and opaque loads.
  - `step` says which feature step a case belongs to: absent means step 1, otherwise `workers` or
    `non-js`.
- **`locks/<id>.json`:** the frozen full dependency graph per case. References build from it with
  `npm ci`. When depfit's resolved tree (`cost.new_packages` in an empty project) differs, the case
  is reported as **drifted** (re-baseline), not scored.
- **`reference.json`:** sizes from **rollup 4 + terser** and **webpack 5**, pinned, with the same
  semantic settings. They share no resolver, CJS transform, tree-shaker, or minifier with
  rolldown/oxc. Reference disagreements above 10% are investigated per case, never absorbed by
  widening the band.
- **`score.ts`:** runs the CLI on every case and prints the scorecard. Results go to `results/`
  (gitignored).

**Band:** `0.90 × min(ref) − 1000 B ≤ x ≤ 1.10 × max(ref) + 1000 B`, applied to gzip and min bytes, both
eager and lazy. This is provisional. It was derived from 9 single-chunk snippets (gzip spread ≤ 5.3%,
min spread ≤ 9.2%) and is recalibrated on the full corpus before step 1 ships.
**Gross error:** a number outside `[0.5 × min(ref) − 1000 B, 2 × max(ref) + 1000 B]`.

**Absolute slack history.** It was 100 B (enough for the reference's keep-alive line on an empty
bundle). Raised to 1000 B after the round 3 fixes, by user decision, then **rejected by Codex round 4**
because it hid a real 16.7% error (`import.meta.env` not replaced; see STATUS.md): bundlers
add a fixed amount of wrapper code per bundle that differs between them, measured at about 430 B
(rolldown's CommonJS interop on ws, which Vite emits identically), 400-900 B (rollup's and
webpack's on server-only, a single `throw`), and 200-400 B (webpack's strict ESM interop on small
wild CommonJS packages). A percentage cannot absorb a fixed difference on a small bundle. depfit
still reports the number; `schema-docs` says small bundles can differ by about 1 KB.

## Gates

| Gate | Pass condition | Steps |
|---|---|---|
| **A. Honesty** | Every null case returns its expected code (and specifier). 0 gross errors in any case. | 1+ |
| **B. Accuracy** | Every mandatory measure case is in band on all four byte fields. Each other measure case is in band, or null with a code; at most 2 such nulls and 0 out-of-band numbers. | 1+ |
| **C. Vite anchor** | Every mandatory browser measure case is within ±3% of a real `vite build` of the same snippet, on eager gzip and min. Vite's injected dynamic-import runtime is removed by a case-independent method (README "Gate C normalization"). A case without a usable anchor fails. This is a regression check for "matches what Vite ships", not ground truth. | 1+ |
| **D. Determinism** | Two runs give identical bytes. Drifted cases are listed separately. | 1+ |
| **E. Contract** | Every package has a `bundle` key. Every new field is in `schema-docs`. All other fields are identical with and without `--bundle-entry`. | 1+ |
| **F. Cost** | Without bundling, rolldown is never loaded (hard check). With bundling, median overhead is ≤ 1.5 s per package beyond the existing install. Runtime without bundling vs v4 is advisory, because network noise is about ±20% run to run. | 1+ |
| **W. Wild corpus** | About 200 popular browser packages, chosen by a fixed rule that depfit's results never influence, never tuned against, each measured as `import * as m`. Pass conditions: (i) an independent auditor finds 0 numbers whose reference output fetches code from outside the bundle (`import()` of a non-chunk target, `importScripts`); other hidden loads are reported as information only; (ii) 0 gross errors against the references, except one listed in `wild-exceptions.json` with a written, independently reviewed cause, which covers that package only while its version, lock, depfit bytes and reference bytes are unchanged (agreement with Vite alone is not a reason: Vite shares depfit's engine); (iii) every null carries a code, and the null rate is reported by code. | 1+ |
| **H0. Comprehension** | A blind small-model reader given only JSON plus `--schema` answers 6 fixed questions correctly in 3/3 runs: what the number includes, that it is standalone and not marginal, eager vs lazy, what a null code means, that peers are excluded, and (for node-pty, which now has a number) that the number does not mean the package works in a browser, citing `native_binaries`. | 1+ |
| **G. Repo usage** | On fixture projects the derived entries equal a hand-written expected set, static and dynamic usage stay separate, and sizes are in band. | 2+ |
| **H. Decisions** | A local blind eval on browser probes produces decisions that are justified by the facts, with no bundle-field confusion in the reviews. | 6 |

## Steps, safest first

1. **Explicit entry, browser, JS only, opt-in** (`--bundle-entry`). Gates A–F, H0.
2. **Repo usage** (`--bundle`): entries from `in_repo.files_using`, with static and dynamic imports
   kept apart, and a namespace whose member access can't be resolved statically kept whole and
   marked. Gate G.
3. **Workers target.** First specify the compatibility date and flags, the runtime-provided module
   allowlist, `cloudflare:*`, and whether wrangler's polyfills are counted. Then add browser/Workers
   case pairs.
4. **Non-JS** (CSS with `@import`/`url()`, wasm forms, URL assets, worker URLs). This needs
   semantics-preserving loaders and execution checks before any bytes are compared.
5. **Marginal bytes:** what the import adds given the repo's other imports.
6. **Default-on** for detected browser and Workers workspaces. Gate H.

## Stop conditions

These are the v1–v3 failure modes. If one shows up, stop and reassess with the user instead of
patching forward.

1. **A silent wrong number** reaches the output: a number from any input, in or out of the corpus,
   that is badly off and carries no code.
2. **Case-shaped fixes:** a setting, special case, or retry added to pass one case, without a
   general rule that would be written down before seeing that case's numbers.
3. **The bar moves to fit:** a gate, band, case expectation, or reference changed after seeing
   depfit's results, without an independent reviewer agreeing it was wrong. Two or more such
   changes in one step means stop.
4. **Code grows faster than scope:** a step adds more code than its gates justify, or fixes keep
   landing in the same module round after round.
5. **Noise in `unavailable`:** dumps of build logs or many entries per package. The old blessed
   build dumped 3 esbuild logs there.
6. **Readers misread a field:** any H0 or H miss on what a number includes.

## Settled questions

- Dynamic imports: eager and lazy are reported separately.
- Peers: excluded at bundle time only; `peer_dependencies` says whether the repo has them.
- A stub or native wrapper that builds but throws at runtime (ws, node-pty on browser) ships those
  bytes, so it gets a number. depfit makes no claim about whether the package works in a browser.
- Bundlers can genuinely disagree on computed requires: webpack turns `require("./locale/" + x)`
  into a context module that bundles every match, while Rollup-family bundlers leave it. depfit
  claims to match Vite, so a webpack reference that built a context module is excluded from that
  case's band. This rule is about the feature, not the number.
- Bundlers can also disagree through their minifiers: oxc (Vite 8, depfit) copies a large string
  constant into each use site, where terser and webpack's minifier keep one binding (one wild
  package: about 2x). `schema-docs` says other bundlers can differ by a factor of two or more. Such
  a package is a gate W gross error unless it has a reviewed exception (gate W). A blanket "within
  3% of Vite" rule was tried and rejected by Codex round 3.
- Empty roots (pdnd `*`): the measured bytes are what that import ships. The agent chooses the entry.
- Version: the report's `version`.
- No entry given: `bundle: null`. depfit never assumes `*`.
- Production conditions only.

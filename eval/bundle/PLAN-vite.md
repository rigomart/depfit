# Plan: measure with `vite build` instead of imitating it

Status: proposed 2026-10-16 after Codex review round 4, revised after a Codex review of the plan
(reproductions in `results/research/review5/`), decisions confirmed by the user, spike done (below).
The implementation (step 2 of Order) is not started.

## Why

Step 1 bundles with rolldown and copies Vite's client-build settings by hand. Each setting that was
missed became a silent wrong number: JSON handling (node-pty, 25% under Vite) and
`import.meta.env.DEV/PROD` (development-only code kept, up to +16.7%, found in round 4). Nothing
shows the list is complete now. Four review rounds each found something, and fixes keep landing in
the same place (stop condition 4). Running Vite itself makes the number Vite's own output by
construction and removes that class of bug.

The user chose Vite after a depfit comparison of vite, esbuild, webpack, @rspack/core, rollup and
rolldown (from an empty project). vite: 30 MB, 16 packages; rolldown alone: 18 MB, 4. Vite is the
only candidate with a standard app production build, so nothing has to be hand-assembled, and it is
what Vite apps and the frameworks built on it (SvelteKit, Nuxt, Astro, React Router, SolidStart,
TanStack Start) ship. The user accepts the install size and wants the feature on by default later
(step 6, after repo-usage entries in step 2).

**Claim, narrowed:** the bytes of a standalone `vite build` of the snippet with depfit's documented
configuration. A real app can differ through its own plugins, aliases, `define`, target, `base` and
surrounding imports. `schema-docs` says so.

## What depfit runs

`vite build` in a **child process** started with `NODE_ENV=production` and an environment stripped of
`VITE_*` variables. Codex showed that the parent shell leaks in otherwise (`NODE_ENV=development`
flips `import.meta.env.DEV` despite `mode: "production"`; an exported `VITE_X` lands in the bundle),
and a child process also keeps Vite from touching depfit's own environment. Vite is loaded only
there, only when bundling is requested (gate F).

Vite's defaults apply except for this list, the complete set of depfit's choices:

| Setting | Why |
|---|---|
| `root`: the isolated install; `configFile: false`; `envDir: false`; `envPrefix: []`; `mode: "production"`; `publicDir: false`; `base: "/"`; `cacheDir` inside the install | No user, project or shell config leaks in; nothing written outside the disposable install |
| `build.rollupOptions.input`: the generated `__depfit_entry.mjs` (a JS entry, no `index.html`) | An HTML entry adds Vite's modulepreload polyfill, an app-level constant |
| `build.write: false` | Measure in memory (it also turns off output clearing and public-file copying) |
| Peers external through Vite's exported `esmExternalRequirePlugin`, which owns them (not top-level `external`) | Unchanged contract: peers are excluded and listed. Stock `external` leaves a runtime `require()` helper for a CJS `require("react")` (+256 B min in Codex's fixture); the plugin turns it into an import, as the current code does |
| Log capture: a handler that records structured `onLog` entries before forwarding | The honesty checks read codes from them |

Kept from Vite as-is: target, minifier, conditions, mainFields, `define`, JSON, CommonJS interop, and
**the preload helper**. It is counted (decision 1). The toolchain is frozen: Vite pinned exactly, and
its rolldown pinned exactly too (Vite declares `~1.2.12`), both recorded in the output and in eval
results.

Spike facts so far (Vite 8.3.4, JS entry): zod `{ z }` with two members gives 22,414 B gzip, the same
as depfit today, in well under 0.1 s. A JS entry injects no modulepreload polyfill. Production builds
write no `.vite` cache and copy no public files when `write: false`.

Removed from depfit: conditions, mainFields, target, `define`, the JSON plugin and minify options, and
the direct `rolldown` dependency (Vite exports `parseAst`).

## What depfit still checks (the honesty rules do not change)

Each check uses the structural signal that matches its meaning, not one catch-all:

- **Node built-ins:** Vite resolves them to an empty `__vite-browser-external` stub and only warns.
  The same stub id is also produced by a package's intentional `browser: { "./x.js": false }`
  mapping, which is legitimate and must stay measurable. So a resolve hook records each original
  specifier and its resolution. A Node built-in specifier (`node:*` or a built-in name) resolving to
  the stub gives null `UNRESOLVED_IMPORT <names>`. A `browser`-field mapping does not.
- **Unresolved imports:** `UNRESOLVED_IMPORT` from captured `onLog` entries, including warnings,
  and from aggregate build errors (`error.errors[].code`). An unexpected
  `__vite-optional-peer-dep:*` module (a missing optional peer that Vite replaces with a throw) also
  counts.
- **Missing exports:** `MISSING_EXPORT` from aggregate errors, and `IMPORT_IS_UNDEFINED` warnings on a
  requested namespace member (Vite emits `undefined` and succeeds).
- **Non-JS (step 1 stays JS-only), with an explicit rejection boundary:** null `NON_JS_IMPORT` for a
  non-JS module in the graph, an asset/worker/wasm/url/raw/inline query (`?url`, `?worker`, `?raw`,
  `?inline`, `?init`), a `new URL(..., import.meta.url)` or `new Worker(...)` reference in the
  bundled sources, or any emitted asset. Codex showed that each of these alone misses a form (an
  inlined SVG URL leaves no SVG module id; a worker is emitted as an asset; `?worker&inline` keeps a
  `.js` id).
- **`IMPORT_OUTSIDE_BUNDLE`:** the same structural check on Vite's output, with chunk paths resolved
  relative to the importing chunk.
- Warnings in general, and package-authored stubs or loaders that throw, are not nulls: the settled
  contract measures emitted bytes.
- Eager and lazy accounting, and gzip level 9 per chunk: unchanged, on Vite's output chunks.

Output: `bundle.bundler` becomes `"vite@<v> (rolldown@<v>)"`. `schema-docs` states the narrowed claim
and that the preload helper is included when there is a lazy chunk. Field meanings do not change, so
there is no `SCHEMA_VERSION` bump.

## Harness changes

- **Gate C becomes a small conformance check.** depfit's four byte fields and chunk graph must equal a
  separately invoked stock `vite build` (same entry, peers and isolation, no depfit code) on a few
  behaviors: ESM, CJS, JSON, production environment, lazy splitting, an external CJS peer. Exact
  equality, since it is the same build. The current anchor corpus and the runtime-removal plugin go
  away.
- **Slack** goes back to 100 B (round 4 rejected 1000 B).
- **Reviewed exceptions** move from `wild-exceptions.json` to one file used by A, B and W. They waive
  explained size discrepancies only, never an expected null code or a structural honesty failure.
  Each records the entry, the dependency tree (lock hash), the toolchain versions, all four byte
  fields of depfit and both references, and the written cause. Expected: ws (rolldown CJS interop
  helper), node-pty (Vite JSON namespace; rollup-only band), tldts (oxc string duplication),
  server-only (reference wrapper code). Each is re-reviewed with the new numbers. Anything else that
  falls outside the band is a finding, not an exception.
- **Round 4 harness findings:** the `--resume` cache is keyed by implementation and toolchain version,
  snippet and dependency tree, and ranges, audits and exception validity are recomputed on every run.
  The webpack loader exemption requires that the `.u` comes from the same runtime binding that
  defines webpack's chunk-filename function. Gate E checks that both reports have the same keys
  before excusing source-fed values.
- **New cases** (fixtures and, where a real pinned package exists, corpus cases): an
  `import.meta.env.DEV` branch; the shell-environment leak (`NODE_ENV=development`, `VITE_*`); a
  `browser: false` mapping (measured) vs a Node built-in (null); a missing optional peer; a missing
  namespace member; an asset by URL, a worker, `?worker&inline`, a missing URL asset; a CJS `require()`
  of a peer; an import attribute on an external import (round 4); JSON fixtures that tell Vite's
  required-JSON handling apart from the old behavior.
- References: rollup and webpack builds are unchanged. The Vite fields of `reference.json` and
  `wild-reference.json` are replaced by gate C's conformance builds; exceptions record depfit's own
  bytes, which are Vite's.
- SPEC, SETTINGS, README, gate F's load detector (it must check that neither Vite nor rolldown is
  loaded without bundling) and `schema-docs` are updated together.

## Spike results (2026-10-16)

Script: `results/research/spike/` (gitignored; `spike.ts` drives `vite-runner.mjs`, one child process
per build, Vite 8.3.4 with rolldown 1.2.14 from a scratch install).

- **Corpus, 33 step-1 cases:** 29 identical to today's depfit to the byte (including every null code).
  4 changed, all explained:
  - **moment −749 B min:** Vite's default `mainFields` include `jsnext:main`, which depfit's copy
    lacked, so Vite bundles moment's ES module build (`dist/moment.js`) and depfit bundled the UMD
    `moment.js`. A third missed setting, and the kind of bug the switch removes.
  - **node-pty +8 B, ajv +16 B:** Vite's own JSON handling differs slightly from depfit's
    standalone copy of it (two extra `.default` accesses in ajv). Vite's output is now the number.
  - **shiki +10.7 KB eager min:** Vite's preload helper and per-import wrapping, counted by decision 1.
    Within 142 B of the stock Vite build in `reference.json` (151,743 vs 151,885).
- **Fixtures, 15 new cases:** all as planned. The `import.meta.env.DEV` branch is dropped (29 B); a
  `browser: false` mapping is measured; `node:fs` gives `UNRESOLVED_IMPORT`; a missing optional peer
  of a dependency gives `UNRESOLVED_IMPORT`; a missing namespace member gives `MISSING_EXPORT`; small,
  large and missing URL assets, worker URLs, `?worker&inline` and CSS give `NON_JS_IMPORT`; a CJS
  `require()` of a peer leaves no runtime `require`; an import attribute on a peer and a required JSON
  file are measured.
- **Isolation:** identical results from another working directory and another root path. With the
  parent shell passed through unstripped (`NODE_ENV=development`), react-dom grows from 210,684 to
  399,473 B and the env fixture keeps its development branch, which confirms the clean child
  environment is required.
- **Side effects:** no file written in the install other than the generated entry, and the observing
  plugin changes no output (compared with a build without it).
- **Speed:** median 109 ms per build including child-process start and Vite import (max 270 ms,
  shiki), well inside gate F's 1.5 s.
- **Toolchain pinning is required:** the repo's own Vite 8.3.4 resolved a nested rolldown 1.2.13
  (npm kept depfit's 1.2.14 at the top level), and zod differed by 46 B between the two. depfit must
  force one rolldown version for Vite (`overrides`) and record both versions.
- **Spike bugs fixed along the way** (in the spike, informing the implementation): Vite's own virtual
  modules (`\0vite/...`) must be skipped by the source scan, and paths must be compared on the real
  path of the temp root (`/var` vs `/private/var` on macOS). An unresolved import arrives as a warning
  log, not an error.
- Not covered by the spike, left to the implementation: that an ordinary CLI run loads neither Vite
  nor rolldown, and cold timing through the Bun CLI path.

## Order

1. **Spike** before any production code. For every mandatory case and every new case, record the
   four byte fields, the chunk graph and the reason codes from the Vite-based build, beside today's
   output. Also:
   - Repeat builds with a different shell environment, working directory and fresh temp root, which
     must give identical results.
   - Take a before/after inventory of the filesystem and depfit's own environment.
   - Time a cold run through the real Bun CLI path.
   - Check that an ordinary CLI run loads neither Vite nor rolldown.
   Every changed number needs an explanation; an unexplained change stops the migration.
2. `src/collect/bundle.ts` on Vite, with the fixtures above. Target: smaller than today's 403 lines.
3. Harness changes above.
4. Rerun the corpus (`--runs 2`), W (fresh) and H0.
5. Codex review on the implementation.
6. Stop and present to the user before step 2.

## Decisions

1. **Preload helper: counted** (Codex's recommendation, and the lead's after review; user to
   confirm). There is no supported switch that removes it: `modulePreload: false` keeps it, and
   replacing Vite's internal plugin would bring back hand-maintained Vite behavior. Counting it fits
   "standalone, not marginal". That an app already ships it is a step 5 (marginal bytes) question.
   Subtracting it is wrong, because gzip and minification are not additive.
2. **Gate C: replaced** by the small conformance check above, not removed. Full removal would lose
   coverage of depfit's entry generation, peer handling and accounting.

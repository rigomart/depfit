# Bundle measurement settings

depfit measures a snippet with a real `vite build` (`src/collect/vite-build.mjs`, run on Node), Vite 8.3.4 on
rolldown 1.2.14, both pinned exactly (`package.json`, with an `overrides` entry so Vite uses the same
rolldown). Vite's production defaults apply: target, minifier, resolve conditions and main fields,
`define` (`process.env.NODE_ENV`, `import.meta.env`), JSON, CommonJS interop, and the preload helper
for lazy chunks. SPEC.md wins on conflict.

## depfit's choices (the complete list)

| Setting | Why |
|---|---|
| A Node child process (not Bun: Vite builds its preload helper from function source text, which Bun prints differently; shiki was 2 B off) with `NODE_ENV=production` and only `PATH`, `HOME` and temp-dir variables from the shell | Vite reads the process environment: `NODE_ENV=development` selects development code even with `mode: "production"` (react-dom 210,684 → 399,473 B), and `VITE_*` variables land in the bundle |
| `root`: the isolated install; `configFile: false`; `envDir: false`; `envPrefix: []`; `mode: "production"`; `publicDir: false`; `base: "/"`; `cacheDir` inside the install | No user, project or shell config; nothing written outside the disposable install |
| `build.rollupOptions.input`: the generated `__depfit_entry.mjs` (a JS entry, not `index.html`) | An HTML entry adds Vite's modulepreload polyfill, an app-level constant |
| `build.write: false` | Measured in memory (also turns off output clearing and public-file copying) |
| Peers external through Vite's exported `esmExternalRequirePlugin` | Peers are excluded and listed. Plain `external` leaves a runtime `require` shim of a few hundred bytes for a CommonJS `require()` of a peer (the `cjs-peer` fixture: 536 B with plain `external`, under 400 B with the plugin); the plugin turns it into an import |
| An observing plugin (`resolveId` returns null after recording each resolution), an `onLog` that records, and a worker-build recorder (`worker.plugins`) | The honesty checks read only what Vite resolved, logged and emitted, never package source. A build without them emits the same output (spike) |

Gzip is level 9 per chunk with the parent runtime's zlib (Bun's is +0.4% against Node's).

## Honesty checks (`problemsFromBuild` in `src/collect/bundle.ts`)

Vite turns several broken inputs into a quiet success, so each is read from its own signal:

| Input | Vite does | depfit reports |
|---|---|---|
| Import that does not resolve | warns `UNRESOLVED_IMPORT`, leaves it external | `UNRESOLVED_IMPORT` (`NO_ENTRY` for the snippet's own import of the candidate) |
| Node built-in by any route (`node:fs`, `fs`, an import alias like `#crypto`) | resolves to an empty `__vite-browser-external` stub, warns | `UNRESOLVED_IMPORT <specifier>`: every stub is unmeasurable unless the importing package maps that import to false in its `browser` field (never for a `#` import alias, which Vite resolves through `imports` first) |
| A package's `browser` mapping to false (`"./x.js": false`, matched with Vite's extensions; `"crypto": false`) | resolves to the same stub, no warning | measured (the package chose it) |
| Missing optional peer of a dependency | replaces it with `__vite-optional-peer-dep:*`, a throw | `UNRESOLVED_IMPORT <peer>` |
| Missing named export | error `MISSING_EXPORT` | `MISSING_EXPORT` |
| Missing namespace member (`m.nope`) | warns `IMPORT_IS_UNDEFINED`, emits `undefined` | `MISSING_EXPORT` |
| A file Vite emits besides JS chunks: CSS, an asset too large to inline, a worker, wasm | emits it | `NON_JS_IMPORT <file>` (step 1 is JS only) |
| An asset Vite inlines into the JS (a small image as a data URL, `?inline`, `?raw`) | inlines it | measured: the bytes are in the JS |
| A worker, inline or not (`?worker`, `?worker&inline`, `new Worker(new URL(..., import.meta.url))`) | builds it separately, outside this build's plugins | `NON_JS_IMPORT worker <module>`: depfit's checks and peer exclusion do not reach a worker build; workers are step 4 |
| A file loaded by a path at runtime (`new Worker("./w.js")`, a missing asset left as a URL, `fetch`) | leaves the path | measured; the file is outside the claim, like any runtime load |
| An `import()` or import left in the output that is no emitted chunk and no peer | builds | `IMPORT_OUTSIDE_BUNDLE <specifier>` |
| A peer's own files bundled through an alias (`#peer`, a relative path into `node_modules/peer/`) | bundles them | `PEER_IN_BUNDLE <peer>` |
| The installed Vite or rolldown is not the evaluated version | builds | `TOOLCHAIN_MISMATCH <found>` |
| Any other build error | fails | Vite's code (`PARSE_ERROR`, `PLUGIN_ERROR`, ...) |

Warnings in general, and package-authored stubs or loaders that throw, are not nulls: the number is
emitted bytes, with no claim that the code runs (SPEC.md).

## History

Until 2026-10-16 depfit ran rolldown directly with Vite's settings copied by hand
(`SETTINGS-rolldown-v1.md`). Three settings were missed, each a silent wrong number: Vite's JSON
handling (node-pty 25% under Vite), `import.meta.env` replacement (development branches kept), and the
`jsnext:main` main field (moment's UMD build instead of its ES build). Running Vite itself removes that
class of error (PLAN-vite.md).

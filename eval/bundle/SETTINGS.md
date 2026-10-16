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
| An observing plugin (`resolveId` returns null after recording, `transform` returns null after scanning) and an `onLog` that records | The honesty checks read resolutions, sources and log codes. A build without it emits the same output (spike) |

Gzip is level 9 per chunk with the parent runtime's zlib (Bun's is +0.4% against Node's).

## Honesty checks (`problemsFromBuild` in `src/collect/bundle.ts`)

Vite turns several broken inputs into a quiet success, so each is read from its own signal:

| Input | Vite does | depfit reports |
|---|---|---|
| Import that does not resolve | warns `UNRESOLVED_IMPORT`, leaves it external | `UNRESOLVED_IMPORT` (`NO_ENTRY` for the snippet's own import of the candidate) |
| Node built-in (`node:fs`, `fs`) | resolves to an empty `__vite-browser-external` stub, warns | `UNRESOLVED_IMPORT <name>` |
| A package's `browser: { "./x.js": false }` | resolves to the same stub, no warning | measured (the package chose it) |
| Missing optional peer of a dependency | replaces it with `__vite-optional-peer-dep:*`, a throw | `UNRESOLVED_IMPORT <peer>` |
| Missing named export | error `MISSING_EXPORT` | `MISSING_EXPORT` |
| Missing namespace member (`m.nope`) | warns `IMPORT_IS_UNDEFINED`, emits `undefined` | `MISSING_EXPORT` |
| CSS, wasm, images, fonts; `?url`, `?raw`, `?inline`, `?worker`, `?init` queries; `new URL(..., import.meta.url)`; `new Worker(...)`; any emitted asset | inlines a URL, emits an asset, or a worker | `NON_JS_IMPORT` (step 1 is JS only) |
| An `import()` or import left in the output that is no emitted chunk and no peer | builds | `IMPORT_OUTSIDE_BUNDLE <specifier>` |
| Any other build error | fails | Vite's code (`PARSE_ERROR`, `PLUGIN_ERROR`, ...) |

Warnings in general, and package-authored stubs or loaders that throw, are not nulls: the number is
emitted bytes, with no claim that the code runs (SPEC.md).

## History

Until 2026-10-16 depfit ran rolldown directly with Vite's settings copied by hand
(`SETTINGS-rolldown-v1.md`). Three settings were missed, each a silent wrong number: Vite's JSON
handling (node-pty 25% under Vite), `import.meta.env` replacement (development branches kept), and the
`jsnext:main` main field (moment's UMD build instead of its ES build). Running Vite itself removes that
class of error (PLAN-vite.md).

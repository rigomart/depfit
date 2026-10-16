# Bundle measurement settings

rolldown settings for depfit, from the bundler study (rolldown 1.2.14, Vite 8.3.4).

> **Amended after review (see SPEC.md, which wins on conflict).**
> - **Step 1 scope:** browser target, JS only. The workerd rows and the Workers note are input for
>   step 3.
> - **Non-JS imports:** a CSS, wasm, or asset import yields `NON_JS_IMPORT` (null) until step 4.
>   The `empty`/`asset` module types below produced code that built but was broken, e.g.
>   `(void 0).button` for CSS modules, and a tiktoken wasm namespace that held a URL instead of
>   exports.
> - **Peers:** keep depfit's existing isolated install, which already installs required peers.
>   Exclude them in the bundler's `external`, not at install time, so `cost` is unchanged.
> - **Opaque loads:** after a successful build, scan the output for a surviving `require(`,
>   `import(` with a non-literal argument, `createRequire`, or `process.dlopen`. If one is found,
>   return null with `OPAQUE_RUNTIME_LOAD`. Escalating warnings alone misses node-pty, which builds
>   to about 1.2 KB with zero warnings.
> - **Field names:** `eager_js_min_bytes`, `eager_js_gzip9_bytes`, `lazy_js_min_bytes`,
>   `lazy_js_gzip9_bytes`.


Goal: same answer as a Vite 8 production client build of the snippet; anything that cannot be measured is
an error with a reason, never a smaller number.

**Entry.** Generate a virtual entry from the snippet and keep every binding alive:
`import { format, parseISO } from "date-fns"; globalThis.__depfit = [format, parseISO];`. For a namespace
import, keep only the members the snippet accesses (`[ns.object, ns.string]`); with no members given,
keep `ns` whole and say so in a field (e.g. `namespace_kept_whole: true`). Side-effect imports
(`import "pkg"`) are measured as-is.

**Input options**

- `platform: "browser"` for both targets.
- `resolve.conditionNames`: browser `["module", "browser", "production"]` (Vite's client set);
  workerd `["workerd", "worker", "browser", "module", "production"]` (wrangler's set plus Vite's).
  **Do not list `import`, `require` or `default`**: rolldown adds them per import kind. Listing `import`
  made `require("style-to-object")` (from CJS style-to-js, inside react-markdown) resolve to the ESM
  file, +0.4% and different modules than Vite.
- `resolve.mainFields`: `["browser", "module", "main"]`. Honor the `browser` field object form (including
  `false` → empty module); verify rolldown's alias-field default when implementing.
- `transform.define`: `{ "process.env.NODE_ENV": "\"production\"" }`. Nothing else; do not stub
  `process`/`global`, size does not depend on them.
- `transform.target`: Vite's baseline (`chrome111, edge111, firefox114, safari16.4, ios16.4`), so syntax
  lowering matches what Vite ships.
- `preserveEntrySignatures: false`; default tree-shaking (honors `sideEffects` and `/*#__PURE__*/`).
- `external`: the candidate's `peerDependencies` (optional ones too) and their subpaths
  (`^(react|react-dom)(/.*)?$`), plus any the user names. Install the candidate without auto-installing
  peers so a missing external cannot be bundled by accident. Record the list (`external_packages`).
- `moduleTypes`:
  - `.css`: `"empty"`. rolldown 1.2 errors `UNSUPPORTED_FEATURE: Bundling CSS is no longer supported`
    otherwise. Report the CSS files imported and their raw byte size as separate facts
    (e.g. `css_files`, `css_bytes_unminified`); never add them to the JS number.
  - images, fonts, `.svg` used as URLs: `"asset"` (emitted file, JS keeps a URL). Report
    `asset_bytes` separately. Note: Vite inlines assets under 4 KB as base64; depfit should not, and the
    field name should say "not inlined".
  - `.wasm`: `"asset"` and report `wasm_bytes` separately (default rolldown fails with a misleading
    `PARSE_ERROR`). Workers import wasm as a module too, so the same treatment fits workerd.
  - `.json`: rolldown's `viteJsonPlugin` with Vite's build defaults (`namedExports: true`,
    `stringify: "auto"`, `minify: true`), as Vite runs it on every `.json` import (amended after
    Codex review round 3). A `require()` of JSON then gets Vite's ESM interop; without it, node-pty
    measured 1,179 B gzip against Vite's 1,591. Named-key tree-shaking still works.
- `onLog`: **escalate `UNRESOLVED_IMPORT` to an error.** Default rolldown only *warns* and turns the
  specifier into an external (`does-not-exist`, `node:fs`, `path` all "built" to 39–58 B). This is the
  single most important setting. `MISSING_EXPORT` is already an error. Record the codes of any remaining
  warnings as a fact (`bundle_warnings`), no prose.

**Unmeasurable inputs → errors (verified with rolldown 1.2.14)**

| Input | Target browser | Target workerd |
|---|---|---|
| `node:*` or bare built-in (`fs`, `path`) | error `UNRESOLVED_IMPORT` (escalated), report the specifier | external, listed as `node_builtins` (nodejs_compat provides them; wrangler's unenv polyfills are out of scope) |
| unresolvable bare import (optional dep, generated `.prisma/client`) | error, report specifier | same |
| `.node` native addon | error `UNRESOLVED_IMPORT` on the `.node` path | same |
| named export that does not exist | error `MISSING_EXPORT` | same |
| package that is browser-incompatible through its own `browser` mapping (execa → unicorn-magic) | error `MISSING_EXPORT` (`toPath`) | same |
| dynamic `import()` | builds; emit as chunks | same |

Never retry with unresolved imports marked external (the old `buildRetrying`): that is how wrong numbers
were produced.

**Output options**: `format: "esm"`, `minify: true` (oxc), `topLevelVar: true`,
`comments: { legal: false, annotation: false, jsdoc: false }`, no sourcemap, `write: false` (use
`generate`).

**Measuring**

- `eager` = entry chunk plus the closure of its static `imports`; `lazy` = chunks reachable only through
  `dynamicImports`. Report both (`gzip_bytes`, `lazy_gzip_bytes`); never fold lazy into the main number.
  (Probe: a 20 KB dynamic import correctly became a separate chunk.)
- gzip per emitted chunk with `node:zlib` `gzipSync(code, { level: 9 })`, then sum (each chunk is a
  separate transfer). Also report `min_bytes`. Field names should carry the units and level
  (`gzip9_bytes`); schema docs should say the zlib of the running runtime is used.
- Record `bundler: "rolldown@1.2.14"` and `target` in the report.

**workerd note.** wrangler does not minify by default, so a Worker as deployed is larger than depfit's
minified number unless the project sets `minify = true`. Keep one definition (minified) for both targets
and make that explicit in the field name or schema doc rather than guessing the project's setting; or
read `minify` from `wrangler.toml/jsonc` and report it as a project fact.

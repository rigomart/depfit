# depfit blind eval: findings

Inputs: 3 blind Sonnet evaluator reviews of depfit v1 output, 10 comparisons across three local projects:

- **Next.js app** (bun.lock, server + React UI, ~500 lockfile packages): 4 comparisons
- **Browser notes app** (Preact + CodeMirror, bun.lock, bundle size matters): 3 comparisons
- **Terminal dashboard** (Bun TUI with a native-binary UI framework): 3 comparisons

Raw outputs and reviews are kept locally (`eval/results/`, `eval/reviews/`, gitignored) and were used to confirm or reject specific claims. Most bugs below are fixed in schema v2; see §9.

## 1. Summary

- All 10 comparisons got a decision from depfit output alone. Confidence was high in 2, medium-high in 3, medium in 3 and medium-low in 2. Both medium-low calls (fuse.js, git library) turned on capability, which depfit does not report, so the evaluators fell back on background knowledge.
- `in_repo` facts drove 6/10 decisions, and all 6 were "keep the installed package" (`files_using`, `in_package_json`, `pulled_in_by`). In the 4 greenfield questions `in_repo` was empty for every candidate, and cost plus maintenance decided.
- Repo facts overrode popularity every time they were present. For example, marked has `weekly_downloads` 84.9M but `pulled_in_by: ["streamdown"]` and `files_using: []`. Evaluators ignored `stars` in 9/10 comparisons.
- The weakest areas: keep vs upgrade vs add semantics (3/3 evaluators confused), bare advisory counts (3/3), field meanings that are documented only in `report.ts` and never reach JSON readers, and bot-skewed maintenance values.

## 2. Decisions

| Project | Question | Decision | Confidence | `in_repo` drove it |
|---|---|---|---|---|
| Next.js app | Switch date libraries? | Keep date-fns | high | yes (`files_using` 12 vs 0 vs 0) |
| Next.js app | Charting library for activity charts | Keep recharts 2.15.4 | medium-high | yes (`files_using` 4, incl. `ui/chart.tsx`) |
| Next.js app | GitHub client, GraphQL + REST, server | Keep @octokit/core | medium | yes (`pulled_in_by` showed @octokit/graphql already comes via core) |
| Next.js app | README renderer in React | Keep streamdown | medium | yes (`files_using`, marked `pulled_in_by: ["streamdown"]`) |
| Notes app | IndexedDB wrapper | Keep idb | high | yes (`in_package_json` ^8.0.3, `installed_alternative.new_packages` 0) |
| Notes app | Full-text search | fuse.js | medium-low | no (all empty) |
| Notes app | Markdown to HTML export | marked | medium-high | no (all empty) |
| Terminal dashboard | TUI framework | Keep @opentui/core 0.5.12 | medium-high | yes (`files_using` 4, `installed_alternative.new_packages` 0) |
| Terminal dashboard | Run git child processes | tinyexec | medium | no (all empty) |
| Terminal dashboard | Git library vs shelling out | None (simple-git if forced) | medium-low | no (all empty; "none" was a default, not data-backed) |

## 3. Field usage

Counts are across the 10 comparisons, from each review's "Fields that drove / ignored" lines. Several fields show up in both lists. Which list they land in depends on context (browser app vs CLI).

**Drove decisions**

| Field | Count |
|---|---|
| `maintenance.days_since_release` | 8 |
| `in_repo.files_using` | 7 |
| `cost.bundle.gzip_bytes_full_import` | 7 |
| `in_repo.in_package_json` | 6 |
| `security.advisories_all_versions` | 6 |
| `maintenance.stable_releases_last_year` | 6 |
| `maintenance.commits_last_90d` | 5 |
| `cost.total_packages` | 5 |
| `cost.new_packages` | 5 |
| `cost.new_install_bytes` | 4 |
| `maintenance.commits_last_year` | 3 |
| `maintenance.committers_last_year` | 3 |
| `security.open_vulnerabilities` | 3 |
| `compatibility.node_engine` | 3 |
| `in_repo.installed_versions`, `in_repo.pulled_in_by`, `in_repo.installed_alternative.new_packages`, `compatibility.side_effects_free`, `maintenance.top_committer_share`, `maintenance.provenance`, `compatibility.licenses_in_tree` | 2 each |
| `compatibility.peer_dependencies[].satisfied`, `maintenance.downloads_change_90d`, `maintenance.last_commit_at`, `maintenance.open_issues`, `cost.bundle.gzip_bytes_node` | 1 each |

**Ignored as noise**

| Field | Count |
|---|---|
| `maintenance.stars` | 9 |
| `compatibility.licenses_in_tree` / `license` | 7 |
| `maintenance.weekly_downloads` | 6 |
| `maintenance.downloads_change_90d` | 5 |
| `maintenance.publishers_recent` | 5 |
| `cost.bundle.browser_exports` | 5 |
| `maintenance.external_pr_share` | 4 |
| `maintenance.top_committer` | 4 |
| `maintenance.npm_maintainers` | 4 |
| `cost.bundle.browser_compatible` | 4 |
| `maintenance.top_committer_share`, `compatibility.side_effects_free`, `maintenance.open_prs` | 3 each |
| `maintenance.open_issues`, `cost.new_install_bytes`, `cost.bundle.gzip/min_bytes_full_import` (CLI projects), `maintenance.first_published_at`, `generated_at`, `schema_version` | 2 each |
| `cost.install_scripts`, `cost.native_addons`, `cost.platform_specific_packages`, `maintenance.prerelease_tags_ahead`, `maintenance.issues_median_days_to_close`, `compatibility.module_format` | 1 each |

**Never mentioned in either list**: `maintenance.deprecated` (null for all 28 packages), `maintenance.archived` (false for all), `maintenance.repository`, `maintenance.published_at`, `compatibility.node_engine_satisfied` (null for all 30 entries, because `project.node_range` was null in all 3 projects), `compatibility.types`, `project.*`, `unavailable`, `error`.

## 4. Confirmed bugs

1. **Other-platform packages counted as new.** @opentui/core `cost.new_packages` lists all 8 `@opentui/core-<os>-<arch>@0.6.0` packages, but only `darwin-arm64` installs. `platform_specific_packages: 8` includes the one for this host. (`new_install_bytes` 22,032,773 is correct; see §7.) *Fix:* drop optional packages that are absent on disk from `new_packages` and `total_packages`, and count other-platform variants separately.
2. **`native_addons` misses FFI libraries.** @opentui/core `native_addons: []`, but the package ships `libopentui.dylib`. `install.ts` only checks for `.node` and `binding.gyp`. *Fix:* also detect `.dylib`, `.so` and `.dll`, and consider renaming the field to `native_binaries`.
3. **Commits and committers count different populations.** @octokit/core shows `commits_last_year` 25 with `committers_last_year` 0, and @octokit/graphql shows 25 with 0. octokit shows 24 with 0, and all three have `top_committer*` and `external_pr_share` null. Every commit was by dependabot[bot] or renovate[bot]. `committers` excludes bots and `commits` does not, so the output reads as abandoned. *Fix:* apply one bot filter to every commit field, and expose bot commits as their own count (e.g. `bot_commits_last_year`).
4. **Bot filter misses `semantic-release-bot`.** marked shows `top_committer: "semantic-release-bot"`, and its `committers_last_year` 36 includes the bot. Knock-on: `external_pr_share: 1`, because a bot never authors PRs, so every PR counts as "external". `isHuman` only matches `[bot]` and `dependabot|renovate|github-actions`. *Fix:* use GitHub's account type (Bot) where available and match `/[-_]?bot$/i`.
5. **Reuse check ignores the subtree under reused packages.** `newPackages` checks each tree entry independently, so the children of a reusable parent are still counted as new. This produces nonzero `installed_alternative.new_packages` for the exact locked version: recharts 1, @octokit/core 3, @octokit/graphql 4, streamdown 1. Keeping a locked version adds 0 by definition. Example: a fresh install of @octokit/graphql@9.0.3 resolves `@octokit/request@10.0.16` (the lockfile has 10.0.7, which is reusable), and its new children `json-with-bigint`, `content-type` and `@octokit/types@18.0.0` (locked: 16.0.0) get counted. The same pattern inflates `cost.new_packages`: recharts lists `scheduler@0.28.0`, which comes from a fresh `react-dom@19.3.0`, but the locked react-dom 19.2.3 already satisfies the peer range. *Fix:* walk the tree from the root and, when a package is reusable, skip its subtree (use the locked version's dependencies). For a version that is exactly locked, return 0 without installing.
6. **Bundle error is unlabelled and duplicated.** execa `bundle.error` reads "No matching export in unicorn-magic/default.js for import toPath", with no build label (labels are dropped when only one build fails). It actually comes from the browser-exports build, while `gzip_bytes_node` 39,004 is valid. The same string is repeated in `unavailable`. *Fix:* always prefix the build name. When `browser_compatible` is false, treat a failed browser-exports build as `browser_exports: null` rather than an error.
7. **blessed bundle fails entirely.** The node build fails on an unresolvable optional `term.js`, so `gzip_bytes_node` is null. `browser_compatible` is null even though the browser error is the Node built-in `net`, because mixed errors are not classified. A 3-build esbuild dump lands in `unavailable`. *Fix:* retry with unresolved bare imports marked external and record them as a fact (e.g. `unresolved_imports: ["term.js"]`). Classify the browser build as incompatible whenever any error is a Node built-in.
8. **npm downloads HTTP 429 is not retried.** Fast runs record the 429 in `unavailable` and `weekly_downloads` / `downloads_change_90d` become null. None of these 10 runs hit it. *Fix:* retry with backoff and honor `Retry-After`. Use the bulk downloads endpoint for unscoped names.

## 5. Schema and semantics problems (values correct, readers confused)

| Problem | Evaluators hit |
|---|---|
| **Keep vs upgrade vs add.** `version` is the latest, `cost` describes adding the latest, and `installed_alternative` is the only "keep" signal, without saying so. Examples: idb `cost.new_packages: ["idb@8.0.4"]` with 8.0.3 installed; date-fns 10.9 MB `new_install_bytes` for an installed package; @opentui/core `version` 0.6.0 vs installed 0.5.12. Nobody could assess the recharts 2→3, streamdown 2.2→2.7 or opentui 0.5→0.6 upgrades. | 3/3 |
| **`advisories_all_versions` is a bare count.** marked 13, simple-git 10, markdown-it 5, zx 2, with no IDs or affected/fixed ranges. Its relation to `open_vulnerabilities` is unclear. `open_vulnerabilities` covers the candidate's tree only, so the installed streamdown 2.2.0 and marked 17.0.1 were never checked. | 3/3 |
| **`total_packages` vs `new_packages`.** The already-present packages are implied by subtraction, never named. Examples: opentui 19 vs 9, micromark 29 vs 26, react-markdown 86 vs 2. | 3/3 |
| **`gzip_bytes_full_import` vs `gzip_bytes_node`.** `full_import` is browser-only, so it is null for Node-only packages (simple-git, tinyexec, zx, ink, opentui) and the comparison looks inconsistent. The gaps (recharts 161,974 vs 256,366) are unexplained. | 3/3 |
| **`browser_exports` meaning.** "A count of what?" Also populated for browser-incompatible packages (opentui 304, ink 24). | 3/3 |
| **`node_engine_satisfied: null`.** Unknown vs not applicable. It was null for every package because all 3 projects use bun with no `.nvmrc` or `engines`. | 3/3 |
| **`side_effects_free`.** How it is derived, and what it implies for the full-import size. | 3/3 |
| **Bot semantics in committer fields.** See bugs 3 and 4. | 2/3 |
| **`external_pr_share` definition.** Read as contradicting `top_committer_share` (ink 1 vs 0.66). | 2/3 |
| **`downloads_change_90d` unit.** Ratio vs percent. | 2/3 |
| **`types` as a spec string.** luxon `"@types/luxon@3.7.6"` vs `"bundled"`, and the @types package is not included in `cost`. | 2/3 |
| **Peer listed as unsatisfied even though depfit's cost includes it.** ink `react satisfied: false` while `react@19.3.0` is in `new_packages`. | 1/3 |
| **`in_package_json` mixes exact pins and ranges** without saying which. | 1/3 |
| **`unavailable` duplicates `bundle.error`.** | 1/3 |

Root cause shared by most rows: the definitions live in `report.ts` doc comments, and JSON readers never see them. AGENTS.md already says caveats belong in field names, and several fields break that rule.

## 6. Missing facts requested

| Fact | Evaluators asking | Fit |
|---|---|---|
| Advisory details: ID, severity, affected/fixed ranges, whether the installed version is affected | 3 | Fits facts-only (OSV already returns them) |
| Capability: React bindings, HTML sanitization, fuzzy vs indexed search, worktree support, REST helpers | 3 | Needs curation. This is a scope question. The npm `description` and `keywords` are an uncurated partial answer that would fit. |
| Upgrade delta for installed packages: cost of moving installed→latest, whether it crosses a semver major | 3 | Fits (the cost diff and the major-version gap are facts). A changelog or breaking-change summary would need interpretation. |
| Runtime: bun vs node, so engine checks resolve (@opentui/core declares `engines.bun >=1.3.14`, which depfit does not read) | 3 | Fits (read all `engines` keys, bun.lock, `@types/bun`) |
| "Mature/finished vs abandoned" (react-markdown, luxon, uplot, minisearch, idb) | 2 | Needs interpretation (it is a verdict). Raw facts already present (`days_since_release`, `commits_last_year`, `open_issues`) are the facts-only answer. |
| Migration effort: imported symbols or call sites per file in `files_using` | 2 | Fits (static count from source) |
| Usage-aware bundle size (tree-shaken to the symbols actually imported) | 1 | Fits (depfit already knows `files_using`) |
| Existing built-in usage / "no dependency" baseline (`node:child_process`, `Bun.spawn`) | 1 | Fits only if the user names the built-in as a candidate. Mapping a candidate to its built-in alternative needs curation. |
| Names of the reused packages (`reused_packages`) | 1 | Fits |
| `@types/*` package included in cost | 1 | Fits |
| Which OS/arch the install cost was measured on | 1 | Fits (e.g. `project.platform: "darwin-arm64"`) |
| Companion-package cost (react-chartjs-2 for chart.js) | 1 | Needs curation |
| Index memory/speed at N notes | 1 | Out of scope (benchmarks) |

## 7. Evaluator claims rejected

- **@opentui/core `new_install_bytes` 22 MB counts all 8 binaries** (terminal dashboard evaluator). Wrong. Only the host's binary is on disk and the others contribute 0 bytes; installed 0.5.12 measures 19.4 MB. The real bug is `new_packages` (bug 1).
- **marked `advisories_all_versions: 13` is suspicious.** The count matches OSV. The problem is the missing detail (§5).
- **@opentui/core `node_engine: ">=26.4.0"` looks wrong.** It is correct: the package declares `engines.node >=26.4.0` and `engines.bun >=1.3.14`.
- **react-markdown `open_issues: 1` / `issues_median_days_to_close: 0` is untrustworthy.** GitHub shows issues enabled with 1 open issue.
- **`micromark-util-edit-map@1.0.0` may not exist.** It exists on npm.
- **`external_pr_share` 1 contradicts `top_committer_share`** (ink, micromark, flexsearch). Consistent with the definition: the top committer pushes directly, and merged PRs come from others. marked's 1 is the exception (bug 4).
- **fuse.js `open_issues: 2` vs median 150.9 days is inconsistent.** The median is over the last 100 issues, closed ones included, so the two don't conflict.
- **Node vs browser gzip gaps are bugs** (recharts, flexsearch, micromark). They are separate builds with different export conditions. Only the naming is a problem.
- **execa `gzip_bytes_node` can't be trusted next to an error.** The node build succeeded and the error came from the browser-exports build. The bug is the label (bug 6).
- **Bundle fields are null only for simple-git, which is inconsistent.** By design: the browser build fails on Node built-ins, so `browser_compatible` is false. A naming issue only.
- **octokit lists `@octokit/plugin-paginate-rest` twice.** Genuine: 14.0.0 and 15.0.0 are both required within octokit's tree.
- **zx `node_engine: ">= 12.17.0"` is stale.** That is what zx declares.
- **ink `react satisfied: false` reads as a blocker.** The value is correct (react is not in the terminal dashboard lockfile).
- **Bots inflate marked's contributor base.** Only partly true: 1 of 36. The real damage is `top_committer` and `external_pr_share`.
- **Requests for verdicts and flags.** These are out of scope by design (AGENTS.md: facts only). Examples: date-fns `top_committer_share` 0.92 "not flagged", "a verdict on whether a change is worthwhile", an ESM-vs-CommonJS "compatibility verdict", an `adoption_cost` summary, an "abandoned" flag.

## 8. Recommended next changes

1. Split cost for installed candidates into keep (0) / upgrade-to-latest / add, add a `semver_major_bump` fact, and run OSV on the installed version too.
2. Fix package accounting: skip subtrees of reusable packages, exclude other-platform optional packages, name `reused_packages`, and detect `.dylib`/`.so`/`.dll` as native.
3. Replace the bare `advisories_all_versions` count with a list of `{id, severity, affected_ranges, fixed_in}`.
4. Make fields self-describing: rename them (e.g. `gzip_bytes_browser_full_import`, `downloads_change_ratio_90d`) and ship field descriptions in the output or behind `--schema`.
5. Use one bot classifier (GitHub account type plus a `-bot` suffix) for every commit, committer and PR field, and expose a bot commit count.
6. Read every `engines` key and detect a bun runtime, so `node_engine_satisfied` (or a bun equivalent) stops being null everywhere.
7. Harden collectors: retry 429s with backoff, label bundle errors per build, and retry bundling with unresolved imports marked external.

## 9. Status after schema v2

Re-ran the same 10 probes after the v2 changes:

| Finding | v2 result |
|---|---|
| Reuse ignored subtrees | Locked versions report `version_change_from_installed: "same"` and 0 new packages; recharts no longer lists `scheduler`. A patch bump can still add packages when the new version raises dependency floors (@octokit/core 7.0.6 → 7.0.8 adds 9, verified against npm). |
| Other-platform packages counted | @opentui/core: 2 new, 7 in `other_platform_packages` |
| FFI libraries missed | `native_binaries` detects .dylib/.so/.dll |
| Bot accounting | `sampled_commits_by_bots` exposed; @octokit/core shows 25 of 25 by bots; marked's top committer is human |
| Bundle failures (execa, blessed) | Both bundle for node; blessed lists `unresolved_imports` |
| Bare advisory counts | `security.advisories` with id, severity, ranges, fixed_in, affects_* |
| Keep/upgrade/add | `newest_installed` + `version_change_from_installed` |
| Field meanings invisible | `depfit --schema` |
| Engine checks always null | `project.runtime` detects bun; `engine_satisfied` filled |
| 429s | Retried with backoff |
| Capability facts (scope) | npm `description` and `keywords`, verbatim; no curation |

---

# Round 2: schema v2 with a control group

Projects:

- **Bun monorepo**: Cloudflare Workers API (Hono, Drizzle, valibot) plus React web and shared packages, ~800 lockfile packages. 6 comparisons.
- **Large pnpm monorepo**: Electron desktop, Node server, and React web, ~1,800 lockfile packages, with native modules. 6 comparisons.

Per project, two Sonnet agents answered the same questions:
- **depfit**: blind; depfit JSON plus `depfit --schema` only.
- **control**: no depfit; could read the repo, run `npm view`, and search the web.

## Decisions

| Project | Question | depfit agent | Control agent | Same? |
|---|---|---|---|---|
| Bun monorepo | Validation for shared contracts | keep valibot (high) | keep valibot (high) | yes |
| Bun monorepo | HTTP framework on Workers | keep hono (high) | keep hono (high) | yes |
| Bun monorepo | Query layer on Workers | keep drizzle-orm (high) | keep drizzle-orm (high) | yes |
| Bun monorepo | Drag and drop | keep @dnd-kit/core (medium) | keep @dnd-kit/core (medium) | yes |
| Bun monorepo | Transactional email on Workers | resend (medium) | resend (medium) | yes |
| Bun monorepo | Toasts for the web app | reuse installed sonner (high) | sonner, already used in the shared UI package (high) | yes |
| pnpm monorepo | OS keychain for Electron | keep @napi-rs/keyring (high) | keep @napi-rs/keyring (high) | yes |
| pnpm monorepo | SQLite for the server | @libsql/client, already transitive (low-medium) | **none: the server already uses built-in `node:sqlite`** (high) | **no** |
| pnpm monorepo | Pseudo-terminal | **@lydell/node-pty** (low-medium) | **keep node-pty, declared and used** (high) | **no** |
| pnpm monorepo | Request validation | effect (high) | effect (high) | yes |
| pnpm monorepo | Syntax highlighting | shiki at installed 4.2.0 (medium-high) | none needed; shiki already comes via @pierre/diffs (medium) | close |
| pnpm monorepo | Drag and drop | keep @dnd-kit/core (high) | keep @dnd-kit/core (high) | yes |

The agents agreed on 10/12. The control used about 10–11 tool calls per project and reached the same
repo facts on its own. In both disagreements the control was right.

## What the control found that depfit didn't show

1. **A built-in was the real incumbent.** The server uses `node:sqlite`. depfit only sees the
   candidates it is given, so the transitively installed @libsql/client looked like the "free"
   choice. Fact-based fix: accept built-ins as candidates (`depfit node:sqlite better-sqlite3`) and
   report the files that import them.
2. **Usage in sibling workspaces.** sonner is installed and used by the shared UI package. depfit
   showed `installed_versions: ["2.0.7"]` with empty `pulled_in_by` and `files_using`: workspace
   packages are skipped as dependents, and `files_using` scans only the current workspace.
3. **Deploy target.** Three questions said Cloudflare Workers; `project.runtime` reported "bun".
   wrangler config and deps should set the runtime to `workerd`/"cloudflare-workers".

## Bugs (verified)

1. **Cost computed for `latest` even when the project declares a newer prerelease.** node-pty is
   declared `^1.2.0-beta.15` and used in 2 files, but depfit costed `latest` 1.1.0
   (`version_change_from_installed: "older"`, +1 package, install script). That pushed the agent to
   the fork. Fix: when the package is declared in the workspace, resolve `version` to what the
   declared range resolves to; otherwise latest.
2. **`types_source: "none"` for packages that ship types.** effect 4.0.2 (implicit `index.d.ts` next to
   the JS entry) and kysely (a `types@<5.4` export condition). Fix: detect from installed files
   (sibling `.d.ts` of the resolved entry) and from any `types*` condition key.
3. **Subpath-only packages.** @atlaskit/pragmatic-drag-and-drop's root exports nothing (147 B,
   `browser_named_exports: 0`); its code lives in subpaths. Facts are correct but the full-import
   bundle is meaningless here. Needs usage/subpath-aware bundling, or a `root_entry_empty` fact.
4. **Native and generated-code packages fail to bundle** (keytar, @napi-rs/keyring: `.node` loaders;
   @prisma/client: generated `.prisma/client`). Mark `.node` files and generated paths external
   and record them in `unresolved_imports`.

## Rejected evaluator claims

- **better-sqlite3 `install_scripts: []` is wrong.** Correct: v13 has no install script.

## Takeaways

- depfit's facts let a blind agent match a repo-exploring agent on 10/12 decisions, without reading
  the repo. The control needed ~10 tool calls per project to get there.
- Both misses came from the same blind spot: depfit describes candidates, not the project's
  existing solution for the same job (a built-in, a sibling workspace, a newer declared version).
  When the incumbent sits outside the candidate list or outside the current workspace, a
  "reuse what's installed" signal can point the wrong way.
- Next changes, by impact: (1) resolve `version` from the declared range; (2) whole-repo `files_using`
  with workspace dependents; (3) built-in candidates (`node:*`); (4) types detection; (5) a Workers
  runtime; (6) bundling fixes for native, generated, and subpath-only packages.

---

# Round 3: schema v3, same questions

The same 12 probes were re-run on v3. Two new blind depfit evaluators were compared with the round 2 control answers.

| Project | Question | Round 2 (v2) | Round 3 (v3) | Control |
|---|---|---|---|---|
| Bun monorepo | 6 questions | 6/6 match control | 6/6 match control (sonner: "reuse the shared UI package's wrapper") | |
| pnpm monorepo | Keychain | keep @napi-rs/keyring | keep @napi-rs/keyring | same |
| pnpm monorepo | SQLite | @libsql/client | better-sqlite3 | **built-in `node:sqlite`** |
| pnpm monorepo | Pseudo-terminal | **@lydell/node-pty** | **keep node-pty** | keep node-pty |
| pnpm monorepo | Validation | effect | effect | effect |
| pnpm monorepo | Highlighting | shiki 4.2.0 | shiki 4.2.0 | none needed (shiki via @pierre/diffs) |
| pnpm monorepo | Drag and drop | keep @dnd-kit/core | keep @dnd-kit/core | same |

**11/12 now match the control.** The pseudo-terminal miss is fixed: the declared prerelease range
resolves to 1.2.0-beta.15 ("same", 0 new packages).

The remaining SQLite miss is expected. The probe did not list `node:sqlite` as a candidate, and
depfit only reports on candidates it is given. With the agent instruction ("include built-ins the
project could use instead"), `depfit node:sqlite better-sqlite3` reports 10 files already importing
the built-in.

## New verified issues

1. **browser_compatible false positive for native wrappers.** @lydell/node-pty reports `true`
   (1,332 B) while `native_binaries` lists `@lydell/node-pty-darwin-arm64`. Its root loads the
   platform package through a dynamic require that esbuild leaves alone. Fix: false whenever the
   tree installs a native binary.
2. **No cost for the installed version.** shiki 4.2.0 is already in the lockfile, but `cost` is for
   latest 4.5.0 (+8 packages). Both evaluators asked for the "use what's installed" cost as a number.
   This is the third round the request has come up. Fix: add `cost_at_newest_installed` (new
   packages + bytes) when `version` differs from `newest_installed`.
3. **Advisories only checked against the newest installed copy.** hono 4.12.18 and 4.13.13 are both
   installed; `affects_newest_installed` covers only one. Fix: `affects_installed_versions: string[]`.
4. **Meaningless full-import sizes** for re-exports of generated code (@prisma/client 523 B) and empty
   roots. Facts are correct; the size needs a caveat field or should be null when `unresolved_imports`
   covers the root's re-exports.

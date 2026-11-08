# CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, on `ubuntu-24.04`.
The scripts here are what its jobs run; each also runs locally, and needs network access and `npm`.

| Job | Runs | Fails when |
|---|---|---|
| Code quality (Bun, Node 22, 24, 26) | `bun run check-types`, `npx oxlint`, `npx oxfmt --check`, unit tests on that runtime | any of them fails |
| End to end (Bun, Node 22, 24, 26) | `ci/e2e.ts`: the CLI on `test/fixtures`, on that runtime | a report breaks the output contract (below) or a project's expectation |
| Bundle accuracy | `ci/bundle-accuracy.ts`: the bundle eval's frozen reference cases | a byte differs from its reference, or a reason code is not the expected one |
| Performance | `ci/perf.ts compare`: the times the two jobs above measured | a gated time is 2x its baseline or more |

Bun is pinned to 1.3.14, the version `bun.lock` was written with; the Bun jobs also install Node 24,
because depfit runs Vite in a Node child process. Node 22, 24 and 26 are the LTS lines that depfit's
dependencies support (vitest: `^22.12.0 || ^24.0.0 || >=26.0.0`); the CLI runs on Node from source
through Node's type stripping.

## End to end

`bun ci/e2e.ts` (or `node ci/e2e.ts`) runs the CLI on the fixtures with the runtime running the
script, and checks each `--json` report with `ci/contract.ts`:

- every field in the report is documented in `--schema`, and every documented field is present
  (null when unknown, never a missing key);
- each value has the JSON kind the typed fixtures in `test/reports.ts` give that field, or is null;
- a null fed by a failed source has that source in `unavailable` (install, osv, downloads, github,
  bundle), and a listed GitHub failure leaves the GitHub fields null;
- outside a browser workspace, `bundle` is null with its `bundle: skipped` entry.

Values that change daily (downloads, GitHub activity, release dates) are checked for kind only. One
run hides the GitHub token, so `github: no token` is exercised every time.

## Bundle accuracy

`bun ci/bundle-accuracy.ts` reads its cases from `eval/bundle`, so cases added there are picked up
with no change here:

- `single-reference.json`: each package's whole entry point through the CLI must equal its stock
  Vite build (`whole_vite`) on all four byte fields, and each listed export, measured by
  `measureRootEntry`, must equal its own stock Vite build, or be null with exactly the code
  `single-nulls.json` lists for it.
- `cases.json`: every browser null case that imports the root must give a null whole build through
  the CLI, with its `bundle: <code>` (and specifier) in `unavailable`.

Installs replay the frozen trees in `eval/bundle/locks` through `DEPFIT_LOCK_DIR`, with npm's
`legacy_peer_deps` (the trees were frozen without peers, which no bundle includes), so the numbers
are deterministic. A reference file in `eval/bundle` that the script neither replays nor lists in
`REFERENCE_FILES` with a reason fails the job, so a new reference set needs a check here.
`wild-reference.json` (about 200 packages) is too slow for every pull request.

## Performance baseline

`ci/perf-baseline.json` holds one time per metric, recorded on GitHub's runners. Gated metrics are
the totals and each package's bundle measurement with a baseline of 2 s or more; the rest are listed
in the job summary only, since single CLI runs are mostly network time and short times double from
runner noise alone.

To update it, after a change that makes depfit legitimately slower or faster:

1. Download the `timings-*` artifacts of two CI runs of the change (a re-run gives the second):
   `gh run download <run-id> --pattern 'timings-*' --dir runs/1`, then the same into `runs/2`.
2. `bun ci/perf.ts record runs/1 runs/2` rewrites the baseline with each metric's slowest run.
3. Commit it with the change, and say why in the pull request.

# depfit

Compare npm packages by what they would cost **this** repo, not npm in general.

```sh
depfit zod valibot yup
```

A package with 40 dependencies you already have is close to free. A package with 2 dependencies that pull in a native binary isn't. Websites can't tell you which is which because they can't see your lockfile. depfit runs in your repo and reports what it finds there: what is already installed and who pulls it in, which files use it, which new packages adding it would bring, and whether it needs install scripts or native binaries. Maintenance and security facts come with it.

It is built for coding agents deciding which dependency to add, and prints facts only: no scores, rankings, or recommendations.

## Install

Requires [Bun](https://bun.sh). Not published to npm yet.

```sh
git clone https://github.com/rigomart/depfit.git
cd depfit
bun install
bun link        # puts `depfit` on your PATH
```

GitHub facts use `GITHUB_TOKEN` / `GH_TOKEN`, or `gh auth token` if the GitHub CLI is logged in. Without a token those fields are `null` and listed under `unavailable`.

## Usage

Run it from the workspace where the dependency would go:

```sh
depfit zod valibot yup                    # compare candidates
depfit sharp                              # one package: what would adding it cost?
depfit zod@^3                             # cost a specific range
depfit node:sqlite better-sqlite3         # include a runtime builtin as an option
depfit hono --cwd apps/api                # run against another workspace
depfit zod valibot --json                 # full report as JSON
depfit --schema                           # what every JSON field means
```

Output is a table in a terminal and JSON when piped, which is what agents get. Use `--table` or `--json` to force either.

### Bundle size

Bundle size depends on how you import a library, so depfit measures only an import you write:

```sh
depfit zod valibot \
  --bundle-entry 'import { z } from "zod"; z.object; z.string' \
  --bundle-entry 'import { object, string } from "valibot"'
```

A snippet holds imports from one candidate (or its subpaths) and member statements like `z.object` on the imported names. A name with no member statements is kept whole, so `import * as Icons from "lucide-react"` measures every icon. Give one snippet per candidate.

depfit bundles the snippet for the browser with rolldown, configured like a Vite production build, and reports minified and gzip bytes for what loads up front and for chunks behind dynamic `import()`. Peer dependencies are left out of the bundle. When a build can't give an honest number (a Node built-in, code loaded at runtime that the bundle doesn't contain, CSS or wasm), the bytes are `null` and `unavailable` gives the reason.

## Example

In a project where `@modelcontextprotocol/sdk` already installs zod (trimmed):

```
package-lock.json (92 packages), type module, node >=20

                              zod                        valibot
In this repo
  Installed                   4.6.5                      no
  Pulled in by                @modelcontextprotocol/sdk  none
  Declared in                 none                       none
  Files using                 1                          0

Cost
  Cost for                    4.6.5 (latest)             1.5.0 (latest)
  New packages                0                          1
  New install size            0 B                        1.9 MB
  Native binaries             none                       none

Compatibility
  Types                       bundled                    bundled
  Peer deps                   none                       typescript >=5 optional (have 5.9.3)

Maintenance
  Last release                27 days ago                31 days ago
  Commits last year           598                        458
  Provenance                  yes                        yes

Security
  Advisories                  1 (0 affect 4.6.5)         2 (0 affect 1.5.0)
```

Here zod costs nothing to add, and the source already imports it without declaring it.

## What it reports

For each candidate:

- **In this repo:** installed versions, what pulls it in, which workspaces declare it, which files import it.
- **Cost:** new vs. reused packages and their install size, install scripts, native binaries, packages for other platforms, and the cost of using the version you already have instead.
- **Compatibility:** module format, types, `engines` against your runtime (Node, Bun, or Cloudflare Workers), and peer dependencies against your lockfile. Also the license.
- **Maintenance:** last release, releases per year, deprecation, provenance, weekly downloads, last commit, archived.
- **Security:** OSV advisories with the versions they affect, including the ones you have installed.

The costed version is the range you typed, else the range your workspace already declares (pnpm/bun `catalog:` included), else `latest`. `version_source` says which one applied.

## Use with agents

Add this to your agent instructions (e.g. `~/.claude/CLAUDE.md` or `AGENTS.md`):

```md
Before adding, replacing, or choosing between npm dependencies, run `depfit <candidates>` from the workspace where the dependency would go, and use its output in the decision. Include built-ins the project could use instead (e.g. `depfit node:sqlite better-sqlite3`). Run `depfit --schema` if a field's meaning is unclear.
```

## Limitations

- **Costs are estimates.** depfit matches semver ranges against your lockfile; your package manager may dedupe differently.
- **Sizes are platform-specific.** Install sizes and native binaries are measured on the current OS and CPU.
- **npm only.** It reads npm, pnpm, yarn v1, and bun lockfiles.
- **Bundle sizes only on request, and only for the browser.** Each one is the snippet bundled on its own, not what it adds to your existing bundle. CSS, wasm, and asset imports aren't measured yet.
- **Network calls on every run.** It queries the npm registry, the npm downloads API, OSV, and GitHub, and installs each candidate into a temp directory. Nothing in your repo is modified.

## Development

```sh
bun run test:once      # tests
bun run check-types
bun run lint
```

See [AGENTS.md](AGENTS.md) for layout and conventions. `eval/` holds the blind-evaluation harness; [eval/FINDINGS.md](eval/FINDINGS.md) records what evaluation showed and how the output changed.

# Test fixtures

The four `lockfile-*` fixtures are one Node project (MCP SDK and express) whose `src/server.ts`
imports zod, which arrives only transitively. Every format must parse to the same packages,
dependents, and repo facts.

- `lockfile-npm`: that project with package-lock.json.
- `lockfile-pnpm`: that project with pnpm-lock.yaml.
- `lockfile-yarn`: that project with a yarn v1 yarn.lock, which records no peer dependencies.
- `lockfile-bun`: that project with bun.lock.
- `bun-workspace`: a Bun monorepo with fake integrity hashes: `apps/api` (Hono, zod,
  wrangler.toml, `bun:sqlite`), `apps/web` (zod), `packages/ui` (sonner, `catalog:` react), and
  `examples/demo`, which has a package.json but is not a workspace.
- `pnpm-workspace`: the same monorepo for pnpm, with default and named catalogs, a `!`
  workspace exclusion, wrangler.jsonc, and `node:sqlite`.
- `browser-app`: a Vite + Preact workspace with an `index.html`, whose `react-dom` is only a peer
  dependency (browser signals come from dependencies and devDependencies).
- `bundle/*`: one tiny package each for the bundle engine's checks; `bundle/root-mixed` has a
  default export and three named ones, one of which loads code from a URL; `bundle/no-entry` has
  only a bin.

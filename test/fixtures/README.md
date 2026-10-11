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

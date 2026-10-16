/**
 * One `vite build` of a generated entry, run by `bundle.ts` as its own Node process (never
 * imported). Plain JavaScript so any Node that Vite supports runs it without a TypeScript step; its
 * input and output types are `ViteBuildRequest` and `ViteBuildResult` in bundle.ts.
 *
 * It runs on Node, not Bun, because that is what Vite users run, and Vite's output depends on the
 * runtime: the preload helper is generated from a function's source text, which Bun prints
 * differently (2 bytes on shiki, and every lazy chunk's hash). The parent also gives it a clean
 * environment (`NODE_ENV=production`, no `VITE_*`), because Vite reads the process environment.
 *
 * Reads a request as JSON on stdin and prints the raw facts as JSON on stdout: output chunks and
 * assets, every import resolution, captured logs, and references to URLs and workers in package
 * sources. `bundle.ts` turns them into bytes or reasons.
 *
 * Vite's defaults apply except for the settings below, the complete list of depfit's choices
 * (eval/bundle/SETTINGS.md): isolation from any config, `.env` file, shell or public dir; a JS entry
 * (an HTML entry adds Vite's modulepreload polyfill); no files written; peers left out through Vite's
 * own `esmExternalRequirePlugin`, so a CommonJS `require()` of a peer becomes an import instead of a
 * runtime `require` helper. The observing plugin resolves nothing and transforms nothing.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { build, esmExternalRequirePlugin, rolldownVersion, version } from "vite";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Does the package containing `file` map `specifier` to false in its `browser` field? Then a Node
 * built-in name resolving to Vite's empty stub is the package's own choice, not a missing built-in
 * (brorand maps `crypto` to false).
 */
function mappedAwayByBrowserField(file, specifier, root) {
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const browser = manifest?.browser;
    return typeof browser === "object" && browser !== null && browser[specifier] === false;
  }
  return false;
}

/** A string property of an unknown value, or null. */
const field = (value, key) => {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const found = value[key];
  return typeof found === "string" ? found : null;
};

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function main() {
  const request = JSON.parse(await readInput());
  const { root, entry, peers } = request;
  if (typeof root !== "string" || typeof entry !== "string" || !Array.isArray(peers)) {
    throw new Error("vite-build: bad request");
  }
  // Module ids use the real path (on macOS the temp dir is /var -> /private/var).
  const realRoot = realpathSync(root);
  const label = (id) => {
    if (id === null) return null;
    const base = id.startsWith(realRoot) ? realRoot : id.startsWith(root) ? root : null;
    return base ? relative(base, id) : id;
  };

  const resolutions = [];
  const logs = [];
  const sourceRefs = [];
  const observe = {
    name: "depfit:observe",
    enforce: "pre",
    async resolveId(source, importer, options) {
      let resolved = null;
      try {
        resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      } catch {
        // Vite's resolver throws for some failures (a package with no entry for the specifier):
        // recorded as unresolved; Vite reports its own error when it resolves again.
      }
      const id = resolved ? resolved.id : null;
      resolutions.push({
        source,
        importer: label(importer ?? null),
        id: label(id),
        external: resolved ? resolved.external !== false : false,
        browserFalse:
          id?.includes("__vite-browser-external") && importer
            ? mappedAwayByBrowserField(importer, source, realRoot)
            : false,
      });
      return null;
    },
    transform(code, id) {
      // Vite's own virtual modules (`\0vite/preload-helper.js`) are not package sources.
      if (id.startsWith("\0")) return null;
      const at = label(id) ?? id;
      // An asset or worker file (`new Worker(new URL("./w.js", import.meta.url))` too). A Worker
      // made from in-bundle code (a Blob URL, as fflate does) fetches nothing and is measured.
      if (/new\s+URL\s*\([^)]*import\.meta\.url/.test(code)) {
        sourceRefs.push({ kind: "new URL(import.meta.url)", id: at });
      }
      return null;
    },
  };
  const external = peers.flatMap((name) => [name, new RegExp(`^${escapeRegExp(name)}/`)]);
  const toLog = (level, log) => ({
    level,
    code: field(log, "code"),
    plugin: field(log, "plugin"),
    // A module path (MISSING_EXPORT) relative to the root; a bare specifier stays as it is.
    exporter: label(field(log, "exporter")),
    id: label(field(log, "id")),
  });

  let output;
  try {
    const result = await build({
      root,
      configFile: false,
      envDir: false,
      envPrefix: [],
      mode: "production",
      publicDir: false,
      base: "/",
      cacheDir: `${root}/.depfit-vite-cache`,
      logLevel: "silent",
      plugins: [observe, ...(peers.length ? [esmExternalRequirePlugin({ external })] : [])],
      build: {
        write: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: entry,
          onLog(level, log) {
            logs.push(toLog(level, log));
          },
        },
      },
    });
    output = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output ?? []);
  } catch (error) {
    const errors = Array.isArray(error?.errors) ? error.errors : [error];
    print({
      vite: version,
      rolldown: rolldownVersion,
      resolutions,
      logs,
      sourceRefs,
      chunks: [],
      assets: [],
      errors: errors.map((item) => toLog("error", item)),
    });
    return;
  }
  const chunks = [];
  const assets = [];
  for (const item of output) {
    if (item.type === "asset") assets.push(String(item.fileName));
    if (item.type !== "chunk") continue;
    chunks.push({
      fileName: String(item.fileName),
      isEntry: item.isEntry === true,
      imports: item.imports.map(String),
      dynamicImports: item.dynamicImports.map(String),
      moduleIds: item.moduleIds.map((id) => label(id) ?? id),
      code: String(item.code),
    });
  }
  print({
    vite: version,
    rolldown: rolldownVersion,
    resolutions,
    logs,
    sourceRefs,
    chunks,
    assets,
    errors: null,
  });
}

function print(result) {
  process.stdout.write(JSON.stringify(result));
}

await main();

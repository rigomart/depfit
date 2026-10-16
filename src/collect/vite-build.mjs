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
import { build, esmExternalRequirePlugin, parseAst, rolldownVersion, version } from "vite";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Extensions Vite tries for a relative import (its default `resolve.extensions`, plus index). */
const TRIED = ["", ".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json", "/index.js"];

/**
 * Does the package containing `file` (its nearest package.json, as Vite reads it) map `specifier`
 * to false in its `browser` field? Then Vite's empty stub is the package's own choice (brorand maps
 * `crypto` to false; others map `./server.js`), and the bytes are measured. Every other stub, a
 * Node built-in by any route (`node:fs`, or a `#crypto` import alias), makes the build unmeasurable.
 * A relative specifier matches a `./` key that names the same file, with Vite's extensions.
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
    if (typeof browser !== "object" || browser === null) return false;
    if (browser[specifier] === false) return true;
    if (!specifier.startsWith(".")) return false;
    const target = join(dirname(file), specifier);
    const candidates = new Set(TRIED.map((extension) => target + extension));
    return Object.entries(browser).some(
      ([key, value]) => value === false && key.startsWith(".") && candidates.has(join(dir, key)),
    );
  }
  return false;
}

const LANGS = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".jsx": "jsx" };

/** `import.meta.url`, also as `import.meta["url"]`. */
const isImportMetaUrl = (node) =>
  node?.type === "MemberExpression" &&
  node.object?.type === "MetaProperty" &&
  node.object.meta?.name === "import" &&
  node.object.property?.name === "meta" &&
  (node.computed ? node.property?.value === "url" : node.property?.name === "url");

/** The constructor's name in `new X(...)` or `new globalThis.X(...)`. */
const constructed = (node) =>
  node.callee?.type === "Identifier"
    ? node.callee.name
    : node.callee?.type === "MemberExpression" && !node.callee.computed
      ? node.callee.property?.name
      : null;

const isStringLike = (node) =>
  (node?.type === "Literal" && typeof node.value === "string") || node?.type === "TemplateLiteral";

/**
 * References in a module's source to a file the bundle does not contain (SETTINGS.md): an asset or
 * worker URL, `new URL(x, import.meta.url)` in any spelling, and a Worker or SharedWorker started
 * from a literal URL or path. A Worker made from in-bundle code (a Blob URL, as fflate does) loads
 * nothing more and is measured. Read from the syntax tree, so words inside strings never count; a
 * module the parser rejects falls back to text patterns, so a parse failure never hides one.
 */
function fileReferences(code, id) {
  if (!code.includes("import.meta") && !code.includes("Worker")) return [];
  const extension = /\.[a-z]+$/i.exec(id.split("?")[0] ?? "")?.[0] ?? "";
  let program;
  try {
    program = parseAst(code, { lang: LANGS[extension] ?? "js", sourceType: "module" });
  } catch {
    const kinds = [];
    if (/new\s+URL\s*\(/.test(code) && /import\s*\.\s*meta/.test(code)) {
      kinds.push("new URL(import.meta.url)");
    }
    if (/new\s+(?:Shared)?Worker\s*\(/.test(code)) kinds.push("new Worker");
    return kinds;
  }
  const kinds = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object" || node === null) return;
    if (node.type === "NewExpression") {
      const name = constructed(node);
      const [first, second] = node.arguments ?? [];
      if (name === "URL" && isImportMetaUrl(second)) kinds.add("new URL(import.meta.url)");
      if ((name === "Worker" || name === "SharedWorker") && isStringLike(first)) {
        kinds.add("new Worker");
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "parent" && typeof child === "object" && child !== null) visit(child);
    }
  };
  visit(program);
  return [...kinds];
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
      for (const kind of fileReferences(code, id)) sourceRefs.push({ kind, id: at });
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

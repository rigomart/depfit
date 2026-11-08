/**
 * A tiny npm registry for tests: packuments with ETags and `max-age=0` (so npm revalidates on every
 * resolution), and tarballs packed at test time. Packages are unscoped.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VersionSpec = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
};

type Published = { manifest: Record<string, unknown>; tarball: Buffer };

export type Registry = {
  url: string;
  publish: (name: string, version: string, spec?: VersionSpec) => Promise<void>;
  unpublish: (name: string, version: string) => void;
  tag: (name: string, tag: string, version: string) => void;
  /** Makes the tarball of name@version answer 500 while `failing` is true. */
  failTarball: (name: string, version: string, failing: boolean) => void;
  close: () => Promise<void>;
};

export async function startRegistry(): Promise<Registry> {
  const work = await mkdtemp(join(tmpdir(), "depfit-registry-"));
  const packages = new Map<string, Map<string, Published>>();
  const tags = new Map<string, Record<string, string>>();
  const failing = new Set<string>();
  let url = "";

  const packument = (name: string) => {
    const versions = packages.get(name);
    if (!versions || versions.size === 0) return null;
    return JSON.stringify({
      name,
      "dist-tags": tags.get(name) ?? {},
      versions: Object.fromEntries([...versions].map(([v, p]) => [v, p.manifest])),
    });
  };

  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const tarball = /^\/-\/tarballs\/(.+)-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
    if (tarball) {
      const [, name = "", version = ""] = tarball;
      const found = packages.get(name)?.get(version);
      if (!found || failing.has(`${name}@${version}`)) {
        response.writeHead(found ? 500 : 404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(found.tarball);
      return;
    }
    const body = packument(path.slice(1));
    if (body === null) {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    const headers = { "content-type": "application/json", "cache-control": "max-age=0", etag };
    if (request.headers["if-none-match"] === etag) response.writeHead(304, headers).end();
    else response.writeHead(200, headers).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;

  return {
    url,
    publish: async (name, version, spec = {}) => {
      const dir = join(work, `${name}-${version}`);
      await mkdir(join(dir, "package"), { recursive: true });
      const manifest = { name, version, main: "index.js", ...spec };
      await writeFile(join(dir, "package", "package.json"), JSON.stringify(manifest));
      await writeFile(
        join(dir, "package", "index.js"),
        `export const v = ${JSON.stringify(version)};\n`,
      );
      const file = join(dir, "package.tgz");
      execFileSync("tar", ["-czf", file, "-C", dir, "package"]);
      const tarball = await readFile(file);
      const dist = {
        tarball: `${url}-/tarballs/${name}-${version}.tgz`,
        shasum: createHash("sha1").update(tarball).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      };
      const versions = packages.get(name) ?? new Map<string, Published>();
      versions.set(version, { manifest: { ...manifest, dist }, tarball });
      packages.set(name, versions);
      tags.set(name, { ...tags.get(name), latest: version });
    },
    unpublish: (name, version) => {
      packages.get(name)?.delete(version);
      const remaining = [...(packages.get(name)?.keys() ?? [])];
      const current = tags.get(name) ?? {};
      if (current.latest === version && remaining.length) {
        tags.set(name, { ...current, latest: remaining[remaining.length - 1] ?? "" });
      }
    },
    tag: (name, tag, version) => tags.set(name, { ...tags.get(name), [tag]: version }),
    failTarball: (name, version, on) => {
      if (on) failing.add(`${name}@${version}`);
      else failing.delete(`${name}@${version}`);
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(work, { recursive: true, force: true });
    },
  };
}

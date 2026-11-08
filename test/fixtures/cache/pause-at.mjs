// Opens the cache at argv[2] (src/collect at argv[4]) and pauses at hook argv[3] (beforeLink or beforeRename), printing "paused", so a test can SIGKILL it.
const [dir, hook, collect] = process.argv.slice(2);
const { openCache } = await import(`${collect}/cache.ts`);
const pause = async () => {
  process.stdout.write("paused\n");
  // A timer keeps the process alive until the test kills it.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
const cache = await openCache({ dir, hooks: { [hook]: pause } });
if (!cache) throw new Error("no cache");
if (hook === "beforeLink") await cache.write("facts", "k", "1.0.0", "key", { n: 1 });
else {
  const { writeFile } = await import("node:fs/promises");
  const staged = await cache.staging();
  await writeFile(`${staged}/file`, "x");
  await cache.publishInstall(staged, "install");
}

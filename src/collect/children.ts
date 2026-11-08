/**
 * The child processes depfit starts (Vite workers, npm installs), so none outlives it. On SIGINT or
 * SIGTERM every live child is sent SIGTERM, then the signal is raised again with its default action,
 * so depfit still ends as it would have. A child that has exited is forgotten.
 */
import type { ChildProcess } from "node:child_process";

const live = new Set<ChildProcess>();
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

function stopAll(signal: NodeJS.Signals): void {
  for (const child of live) child.kill("SIGTERM");
  for (const name of SIGNALS) process.off(name, stopAll);
  process.kill(process.pid, signal);
}

/** Remembers `child` until it exits; the first one installs the signal handlers. */
export function track(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (live.size === 0) for (const name of SIGNALS) process.on(name, stopAll);
  live.add(child);
  child.once("exit", () => {
    live.delete(child);
    if (live.size === 0) for (const name of SIGNALS) process.off(name, stopAll);
  });
}

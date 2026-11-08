/**
 * The child processes depfit starts (Vite workers, npm installs), so none outlives it. While any is
 * running, SIGINT and SIGTERM are handled: every process descending from depfit (its children and
 * theirs, such as what npm runs) is sent SIGTERM, any still running after GRACE_MS is killed, and
 * then the signal is raised again with its default action, so depfit still ends as it would have. A
 * second signal meanwhile gets the default action at once.
 */
import { type ChildProcess, execFileSync } from "node:child_process";

const live = new Set<ChildProcess>();
const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const GRACE_MS = 2000;
/** Set once a signal arrived: a child started after that (a pool replacing a worker) is killed. */
let stopping = false;

/**
 * Every process descending from `root`, from `ps` (POSIX), taken before any is signalled, so a
 * descendant whose parent dies first is still found. Empty where `ps` is not available.
 */
export function descendants(root: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || Number.isNaN(pid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (found.includes(child)) continue;
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const send = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
};

function stopAll(signal: NodeJS.Signals): void {
  stopping = true;
  for (const name of SIGNALS) process.off(name, stopAll);
  const tree = descendants(process.pid);
  const pids = new Set([...tree, ...[...live].flatMap((child) => child.pid ?? [])]);
  for (const pid of pids) send(pid, "SIGTERM");
  const started = Date.now();
  const check = () => {
    const left = [...pids].filter(running);
    if (left.length && Date.now() - started < GRACE_MS) return void setTimeout(check, 50);
    for (const pid of left) send(pid, "SIGKILL");
    process.kill(process.pid, signal);
  };
  check();
}

/** Remembers `child` until it exits; the first one installs the signal handlers. */
export function track(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (stopping) {
    child.kill("SIGKILL");
    return;
  }
  if (live.size === 0) for (const name of SIGNALS) process.on(name, stopAll);
  live.add(child);
  child.once("exit", () => {
    live.delete(child);
    if (live.size === 0 && !stopping) for (const name of SIGNALS) process.off(name, stopAll);
  });
}

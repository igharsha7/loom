/**
 * Harness processes for warm sessions. Each session's CLI runs in its own
 * process group, so stopping a session ends every tool it started, and the
 * stop resolves only once that group is gone.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { agentEnv, quiesceProcessGroup } from "../adapters/base.js";

export interface HarnessProcess {
  child: ChildProcess;
  /** The last ~4 KB of stderr. */
  stderr: () => string;
  /** Resolves when the process has closed (exit and pipes). */
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; quiescenceError?: Error }>;
}

/** Spawn a harness CLI in its own process group, with pipes on all three streams. */
export function spawnHarness(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): HarnessProcess {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? agentEnv(),
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let tail = "";
  child.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; quiescenceError?: Error }>(resolve => {
    let exited = false, pipesClosed!: () => void;
    const pipes = new Promise<void>(resolve => { pipesClosed = resolve; });
    child.once("exit", (code, signal) => {
      exited = true;
      // close waits for inherited pipes. A dead parent must instead fence its
      // descendants, then close the pipes, even if a tool never closes them.
      void (async () => {
        let quiescenceError: Error | undefined;
        try { if (child.pid) await quiesceProcessGroup(child.pid); }
        catch (error) { quiescenceError = error as Error; }
        await Promise.race([pipes, new Promise(resolve => setTimeout(resolve, 100).unref())]);
        child.stdout?.destroy(); child.stderr?.destroy();
        resolve({ code, signal, ...(quiescenceError ? { quiescenceError } : {}) });
      })();
    });
    child.once("close", (code, signal) => { pipesClosed(); if (!exited) resolve({ code, signal }); });
  });
  // A spawn failure (ENOENT) closes the process too; the caller reads child.pid.
  child.on("error", () => {});
  return { child, stderr: () => tail, closed };
}

/** Wait for a spawned process to either get a pid or fail to launch. */
export function launched(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
};

/**
 * End a harness: close stdin, give it `graceMs` to exit, then SIGTERM and
 * SIGKILL its group. Resolves once the process and its group are gone; rejects
 * (NativeQuiescenceUnknown) when the group cannot be proven dead.
 */
export async function stopHarness(proc: HarnessProcess, graceMs = 2000): Promise<void> {
  const { child } = proc;
  const timeout = (ms: number) => new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms).unref());
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    if (await Promise.race([proc.closed, timeout(graceMs)]) === "timeout") {
      signalGroup(child, "SIGTERM");
      if (await Promise.race([proc.closed, timeout(3000)]) === "timeout") {
        signalGroup(child, "SIGKILL");
        await Promise.race([proc.closed, timeout(3000)]);
      }
    }
  }
  if (child.pid && process.platform !== "win32") await quiesceProcessGroup(child.pid);
}

/** A durable process record must not signal a group whose leader PID was reused. */
export function processGroupIdentity(pid: number): string | null | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    if ((error as { status?: number }).status === 1) return null; // leader exited; descendants may still hold its group
    throw error;
  }
}

export async function stopRecordedProcessGroup(record: { processGroupId?: number; processIdentity?: string }, identify = processGroupIdentity): Promise<boolean> {
  const pid = record.processGroupId;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  if (!record.processIdentity) return false;
  const current = identify(pid);
  if (current === undefined) return false;
  // A replacement leader means the original group no longer exists. POSIX
  // cannot reuse its group id while original members still belong to it.
  if (current && record.processIdentity && current !== record.processIdentity) return true;
  await quiesceProcessGroup(pid);
  return true;
}

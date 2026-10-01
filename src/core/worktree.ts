/**
 * Working-tree inspection — the data behind "what code changed, per prompt".
 * Read-only git plumbing; every function degrades to empty results outside
 * a git repo.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const PATCH_EVENT_LIMIT = 12_000; // per-turn patch stored in the event log
const PATCH_VIEW_LIMIT = 64_000; // full working-tree patch served to apps

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }, (err, stdout) =>
      resolve(err ? "" : stdout),
    );
  });
}

export interface ChangedFile {
  status: string; // porcelain XY code, e.g. " M", "??", "A "
  path: string;
}

export function parsePorcelain(porcelain: string): ChangedFile[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3).trim() }));
}

export async function porcelainStatus(dir: string): Promise<string> {
  // -uall lists files inside untracked directories (not just "?? dir/").
  return (await git(["-c", "status.relativePaths=false", "status", "--porcelain", "-uall"], dir)).trimEnd();
}

/** A content snapshot still works when checkpoint capture was refused. */
export async function turnSnapshot(dir: string): Promise<string> {
  const root = (await git(["rev-parse", "--show-toplevel"], dir)).trim() || dir;
  const files: Record<string, { status: string; hash: string }> = {};
  const deadline = Date.now() + 15_000;
  let bytes = 0, count = 0;
  for (const line of (await git(["status", "--porcelain", "-z", "--no-renames", "-uall"], dir)).split("\0").filter(Boolean)) {
    if (++count > 20_000 || Date.now() > deadline) return "";
    const rel = line.slice(3);
    if (isLoomState(rel)) continue;
    let hash = "missing";
    try {
      const file = path.join(root, rel), info = await fs.promises.lstat(file);
      if (info.isSymbolicLink()) hash = `link:${await fs.promises.readlink(file)}`;
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 256 * 1024 * 1024) return "";
        const digest = createHash("sha256");
        const stream = fs.createReadStream(file);
        const timer = setTimeout(() => stream.destroy(new Error("snapshot deadline exceeded")), Math.max(1, deadline - Date.now()));
        try { for await (const chunk of stream) digest.update(chunk); }
        finally { clearTimeout(timer); stream.destroy(); }
        hash = `${info.mode}:${digest.digest("hex")}`;
      }
    } catch { /* deleted or unreadable: status remains evidence */ }
    if (Date.now() > deadline) return "";
    files[rel] = { status: line.slice(0, 2), hash };
  }
  return JSON.stringify({ loomTurnTree: files });
}

export interface TurnDiff {
  files: ChangedFile[];
  added: number;
  removed: number;
  patch: string;
  truncated: boolean;
}

/** Loom's own bookkeeping inside the project — never an agent's work. */
const isLoomState = (path: string) => path === ".loom" || path.startsWith(".loom/");

/**
 * Changes attributable to one turn: files whose porcelain line differs from
 * the pre-turn snapshot, with a patch limited to those files.
 *
 * `.loom/` is not one of them. The event log, the prompt queue and the
 * adapters' session state live there and change while a turn runs; a project
 * that doesn't gitignore `.loom/` used to see them land in the turn's diff,
 * telling you the agent had edited files it never touched.
 */
export async function diffSinceSnapshot(dir: string, before: string): Promise<TurnDiff | null> {
  const snapshot = before.startsWith('{"loomTurnTree":') ? JSON.parse(before).loomTurnTree as Record<string, { status: string; hash: string }> : null;
  const next = snapshot ? await turnSnapshot(dir) : "";
  const current = next ? JSON.parse(next).loomTurnTree as typeof snapshot : null;
  const after = await porcelainStatus(dir);
  const beforeSet = new Set(before.split("\n").filter(Boolean));
  const changedLines = current && snapshot ? [...new Set([...Object.keys(snapshot), ...Object.keys(current)])]
    .filter(p => JSON.stringify(snapshot[p]) !== JSON.stringify(current[p]))
    .map(p => `${current[p]?.status ?? " M"} ${p}`) : after.split("\n").filter(l => l && !beforeSet.has(l) && !isLoomState(l.slice(3).trim()));
  if (!changedLines.length) return null;
  const files = parsePorcelain(changedLines.join("\n"));
  const paths = files.map((f) => f.path);

  let added = 0;
  let removed = 0;
  const root = (await git(["rev-parse", "--show-toplevel"], dir)).trim() || dir;
  const numstat = await git(["diff", "HEAD", "--numstat", "--", ...paths], root);
  for (const line of numstat.split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }

  let patch = await git(["diff", "HEAD", "--", ...paths], root);
  const untracked = files.filter((f) => f.status === "??").map((f) => f.path);
  if (untracked.length) {
    patch += (patch ? "\n" : "") + untracked.map((p) => `?? new file: ${p}`).join("\n");
  }
  const truncated = patch.length > PATCH_EVENT_LIMIT;
  return {
    files,
    added,
    removed,
    patch: truncated ? patch.slice(0, PATCH_EVENT_LIMIT) + "\n… (truncated)" : patch,
    truncated,
  };
}

export interface WorkingTree {
  git: boolean;
  branch?: string;
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
}

/** The project's current uncommitted state, for the Changes/Working-tree views. */
export async function workingTree(dir: string): Promise<WorkingTree> {
  const inside = (await git(["rev-parse", "--is-inside-work-tree"], dir)).trim() === "true";
  if (!inside) return { git: false, files: [], patch: "", truncated: false };
  const [branch, porcelain, rawPatch] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], dir),
    porcelainStatus(dir),
    git(["diff", "HEAD"], dir),
  ]);
  const files = parsePorcelain(porcelain);
  let patch = rawPatch;
  const untracked = files.filter((f) => f.status === "??").map((f) => f.path);
  if (untracked.length) {
    patch += (patch ? "\n" : "") + untracked.map((p) => `?? new file: ${p}`).join("\n");
  }
  const truncated = patch.length > PATCH_VIEW_LIMIT;
  return {
    git: true,
    branch: branch.trim(),
    files,
    patch: truncated ? patch.slice(0, PATCH_VIEW_LIMIT) + "\n… (truncated)" : patch,
    truncated,
  };
}

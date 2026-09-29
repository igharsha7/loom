/**
 * Checkpoints: a point you can put the files back to.
 *
 * An agent turn can touch forty files, and the honest answer to "undo that"
 * used to be "read the diff and retype it". `turn_diff` looks like the answer
 * and isn't: its patch is truncated at 12KB, it records an untracked file as
 * the line `?? new file: <path>` with no content in it, and it carries no ref
 * to apply against. It is a thing to look at, not a thing to reverse.
 *
 * So this doesn't reverse anything. Before a turn runs, it writes down what
 * the working tree *was*, and rewinding puts that back.
 *
 * ## Why a commit on a hidden ref
 *
 * The capture has to include untracked files (an agent's first act is often to
 * create one), survive a daemon restart, and cost nothing in the common case
 * where nobody ever rewinds. It also must not touch anything the human can
 * see: not HEAD, not the current branch, not the index, not the stash stack —
 * a checkpoint that rewrote `git status` under someone mid-review would be
 * worse than no checkpoint.
 *
 * A tree written through a *temporary index* satisfies all of it. `git add -A`
 * against `GIT_INDEX_FILE=<tmp>` stages tracked and untracked alike without
 * going near the real index; `write-tree` turns that into a tree object;
 * `commit-tree` parents it on HEAD so the object survives gc; and the commit
 * is kept under `refs/loom/checkpoints/<id>`, which no branch listing shows.
 * This is what `git stash create` does internally, minus the stash stack that
 * belongs to the human.
 *
 * ## A project that isn't a git repository
 *
 * It gets the same checkpoints from Loom's own store: a bare repository at
 * `.loom/checkpoints.git`, driven with `GIT_DIR` and `GIT_WORK_TREE` pointed
 * at the project. Nothing appears in the project itself, and every agent —
 * Codex, Claude Code or any other — gets the same capture and the same
 * rewind, including changes made by shell commands. (Claude Code's own file
 * checkpoints only see its edit tools, and Codex has none, which is why Loom
 * doesn't lean on either.) With no `.gitignore` to lean on, the store excludes
 * the usual heavy and secret paths itself (DEFAULT_EXCLUDES), and a capture
 * that would take in too much new content is skipped rather than stall a turn.
 *
 * ## What is deliberately not captured
 *
 * Ignored files. `git add -A` honours `.gitignore`, so `node_modules`, build
 * output and — the one that matters — `.env` are never read, never written
 * into an object, and never restored. `.loom/` is ignored too, which is the
 * reason a rewind cannot eat the event log: history is what happened, and a
 * rewind that edited it would be a lie with a timestamp.
 *
 * ## Why restoring takes a checkpoint first
 *
 * Rewinding is destructive by definition — it is asking for work to go away.
 * The work it removes is nearly always work you wanted gone, and occasionally
 * it is four files you forgot you had open. So a restore captures the current
 * tree before it touches anything, and says where that landed. Rewind is
 * itself rewindable, or it is a trap.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GitError } from "./git.js";
import { PATCH_EVENT_LIMIT, type TurnDiff } from "./worktree.js";

/** Where checkpoints live. Not under refs/heads, so nothing lists them. */
const REF_PREFIX = "refs/loom/checkpoints";

/** How many to keep. Older ones are unreferenced and git collects them. */
export const KEEP_CHECKPOINTS = 60;

/** What Loom's own store never captures, in a project with no .gitignore of its own to say so. */
export const DEFAULT_EXCLUDES = [
  "/.loom/", ".git/", "node_modules/", ".env", ".env.*", "*.pem", "*.key",
  ".venv/", "venv/", "__pycache__/", ".mypy_cache/", ".pytest_cache/", ".tox/",
  "dist/", "build/", "target/", ".next/", ".nuxt/", ".cache/", ".parcel-cache/", ".turbo/", "coverage/",
  ".gradle/", ".idea/", ".DS_Store", "*.log",
];

/** New content one capture into Loom's store may take in; beyond it the capture is skipped. */
export const STORE_LIMITS = { files: 20_000, bytes: 256 * 1024 * 1024, listMs: 15_000 };

/** "git": the project's own repository. "loom": Loom's store, for a project that isn't one. */
export type CheckpointStore = "git" | "loom";

export interface Checkpoint {
  /** Sortable, unique, and readable in a ref name. */
  id: string;
  /** What was about to happen — the prompt, the goal, "before rewind". */
  label: string;
  /** The commit holding the captured tree. */
  commit: string;
  at: number;
  /** The branch HEAD was on, for saying where you are going back to. */
  branch: string | null;
  /** Files that differed from HEAD (Loom's store: from the previous checkpoint) when it was taken. */
  dirty: number;
  store: CheckpointStore;
}

/** A restore's report: what it put back, and how to undo the putting back. */
export interface RestoreResult {
  restored: Checkpoint;
  /** The checkpoint taken of the tree the restore replaced. */
  undo: Checkpoint;
  /** Paths whose content the working tree no longer agrees with. */
  changed: string[];
}

interface Store {
  kind: CheckpointStore;
  dir: string;
  /** How git finds this store's objects and refs. */
  env: Record<string, string>;
  /** Where temporary indexes go. */
  scratch: string;
}

function run(args: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          reject(new GitError(detail.split("\n").find((l) => l.trim())?.trim() || `git ${args[0]} failed`, detail));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

async function quiet(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  try {
    return (await run(args, cwd, env)).trim();
  } catch {
    return "";
  }
}

const trimDir = (dir: string) => dir.replace(/\/+$/, "");
const loomStorePath = (dir: string) => path.join(trimDir(dir), ".loom", "checkpoints.git");

function gitStore(dir: string): Store {
  return { kind: "git", dir, env: {}, scratch: `${trimDir(dir)}/.git` };
}

function loomStore(dir: string): Store {
  const gitDir = loomStorePath(dir);
  return { kind: "loom", dir, env: { GIT_DIR: gitDir, GIT_WORK_TREE: trimDir(dir) }, scratch: gitDir };
}

/** Loom's store for `dir`, created on first use with its excludes. */
async function openLoomStore(dir: string): Promise<Store> {
  const store = loomStore(dir);
  const gitDir = store.env.GIT_DIR!;
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    await run(["init", "-q", "--bare", gitDir], dir);
  }
  const exclude = path.join(gitDir, "info", "exclude");
  const wanted = `# Loom's checkpoint store: never captured, never restored\n${DEFAULT_EXCLUDES.join("\n")}\n`;
  if (!fs.existsSync(exclude) || fs.readFileSync(exclude, "utf8") !== wanted) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, wanted);
  }
  return store;
}

/** Whether `dir` is in a git repository with a commit to parent checkpoints on; its HEAD when so. */
async function repoHead(dir: string): Promise<string | null> {
  if ((await quiet(["rev-parse", "--is-inside-work-tree"], dir)) !== "true") return null;
  return (await quiet(["rev-parse", "HEAD"], dir)) || null;
}

/** Every store that may hold checkpoints for `dir`. */
async function storesOf(dir: string): Promise<Store[]> {
  const stores: Store[] = [];
  if ((await quiet(["rev-parse", "--is-inside-work-tree"], dir)) === "true") stores.push(gitStore(dir));
  if (fs.existsSync(path.join(loomStorePath(dir), "HEAD"))) stores.push(loomStore(dir));
  return stores;
}

/** A temporary index path for one operation. Never the repository's own. */
function tmpIndex(store: Store, id: string): string {
  return `${store.scratch}/loom-checkpoint-${id}.index`;
}

function dropIndex(index: string): void {
  // The temporary index is scratch; leaving one behind would be litter, not a failure.
  try {
    fs.rmSync(index, { force: true });
  } catch {
    /* disposable */
  }
}

/**
 * Ids are minted from the clock and have to survive two captures in the same
 * millisecond — a restore takes its undo checkpoint immediately before the
 * one it is restoring, and on a fast machine those are the same tick.
 */
let lastStamp = 0;
function newId(): string {
  const now = Math.max(Date.now(), lastStamp + 1);
  lastStamp = now;
  return `c${now.toString(36)}`;
}

/** When a checkpoint was captured (epoch ms), read from its id; null for an id that isn't one. */
export function capturedAt(id: string): number | null {
  if (!/^c[a-z0-9]+$/.test(id)) return null;
  const ms = parseInt(id.slice(1), 36);
  return Number.isFinite(ms) ? ms : null;
}

async function latestCommit(store: Store): Promise<string | null> {
  const out = await quiet(["for-each-ref", "--sort=-refname", "--count=1", "--format=%(objectname)", REF_PREFIX], store.dir, store.env);
  return out || null;
}

/**
 * Would this capture take in too much new content? Loom's store has no
 * .gitignore written by someone who knows the project, so a folder of media
 * or a dataset is skipped rather than copied into `.loom/` before every turn.
 */
async function tooMuchNew(store: Store, env: Record<string, string>): Promise<boolean> {
  let listed: string;
  try {
    listed = await run(["ls-files", "-z", "--others", "--exclude-standard", "--", "."], store.dir, env, STORE_LIMITS.listMs);
  } catch {
    return true; // too slow to even list
  }
  const files = listed.split("\0").filter(Boolean);
  if (files.length > STORE_LIMITS.files) return true;
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(store.dir, f)).size;
    } catch {
      /* gone meanwhile */
    }
    if (bytes > STORE_LIMITS.bytes) return true;
  }
  return false;
}

/** Write the current working tree as a tree object through a temporary index seeded from `seed`. */
async function writeTree(store: Store, id: string, seed: string | null, guard: boolean): Promise<string | null> {
  const index = tmpIndex(store, id);
  const env = { ...store.env, GIT_INDEX_FILE: index };
  try {
    // Start from the seed so the tree is seed-plus-changes rather than
    // whatever happens to be staged, then take everything: modifications,
    // deletions and new files alike. Excludes still apply, which is what
    // keeps .env and node_modules out of the object store.
    if (seed) await run(["read-tree", seed], store.dir, env);
    if (guard && (await tooMuchNew(store, env))) return null;
    await run(["add", "-A", "--", "."], store.dir, env);
    return (await run(["write-tree"], store.dir, env)).trim();
  } finally {
    dropIndex(index);
  }
}

/**
 * Write down what the working tree is right now.
 *
 * In a git repository the checkpoint goes to that repository, parented on
 * HEAD; anywhere else (or in a repository with no commit yet), to Loom's own
 * store. `options.store` pins the store — a restore's undo point goes where
 * the checkpoint it undoes lives. Returns null when no checkpoint could be
 * taken: git missing, or too much new content for Loom's store.
 */
export async function capture(dir: string, label: string, options: { store?: CheckpointStore } = {}): Promise<Checkpoint | null> {
  let store: Store;
  let head: string | null = null;
  try {
    head = options.store === "loom" ? null : await repoHead(dir);
    if (options.store === "git" && !head) return null;
    store = head ? gitStore(dir) : await openLoomStore(dir);
  } catch {
    return null;
  }

  const id = newId();
  try {
    const seed = head ?? (await latestCommit(store));
    const tree = await writeTree(store, id, seed, store.kind === "loom");
    if (!tree) return null;
    const commit = (
      await run(
        [
          "-c",
          "user.name=Loom",
          "-c",
          "user.email=loom@loom.local",
          "commit-tree",
          tree,
          ...(head ? ["-p", head] : []),
          "-m",
          `loom checkpoint: ${label.replace(/\s+/g, " ").trim().slice(0, 120) || "unlabelled"}`,
        ],
        dir,
        store.env,
      )
    ).trim();
    await run(["update-ref", `${REF_PREFIX}/${id}`, commit], dir, store.env);

    const dirty = seed ? (await quiet(["diff", "--name-only", `${seed}..${commit}`], dir, store.env)).split("\n").filter(Boolean).length
      : (await quiet(["ls-tree", "-r", "--name-only", commit], dir, store.env)).split("\n").filter(Boolean).length;
    const branch = head ? (await quiet(["rev-parse", "--abbrev-ref", "HEAD"], dir)) || null : null;
    const cp: Checkpoint = {
      id,
      label: label.trim().slice(0, 200),
      commit,
      at: Date.now(),
      branch: branch === "HEAD" ? null : branch,
      dirty,
      store: store.kind,
    };
    await pruneStore(store, KEEP_CHECKPOINTS);
    return cp;
  } catch {
    // A checkpoint is a courtesy taken on a hot path. It must never be the
    // reason a turn doesn't run.
    return null;
  }
}

async function listStore(store: Store): Promise<Checkpoint[]> {
  const out = await quiet(
    ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(subject)%09%(committerdate:unix)", REF_PREFIX],
    store.dir,
    store.env,
  );
  if (!out) return [];
  const rows: Checkpoint[] = [];
  for (const line of out.split("\n")) {
    const [ref, commit, subject, when] = line.split("\t");
    if (!ref || !commit) continue;
    rows.push({
      id: ref.slice(ref.lastIndexOf("/") + 1),
      label: (subject ?? "").replace(/^loom checkpoint: /, ""),
      commit,
      at: Number(when) * 1000 || 0,
      branch: null,
      dirty: 0,
      store: store.kind,
    });
  }
  return rows;
}

/** Every checkpoint this project holds, newest first. */
export async function list(dir: string): Promise<Checkpoint[]> {
  const rows = (await Promise.all((await storesOf(dir)).map(listStore))).flat();
  // Ids are base36 milliseconds, so lexical order is chronological order.
  return rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function find(dir: string, id: string): Promise<Checkpoint | null> {
  if (!/^c[a-z0-9]+$/.test(id)) return null;
  return (await list(dir)).find((c) => c.id === id) ?? null;
}

const storeOf = (dir: string, cp: Checkpoint): Store => (cp.store === "loom" ? loomStore(dir) : gitStore(dir));

/**
 * Put the working tree back to a checkpoint.
 *
 * Two commands do the work. `read-tree -u --reset` makes the index and the
 * working tree agree with the captured tree — restoring what changed and
 * deleting what the checkpoint didn't have. `clean -fd` then removes the
 * directories git leaves behind. Neither is given `-x`, so ignored files are
 * not touched: your `node_modules` survives, and so does your `.env`.
 *
 * HEAD does not move. A checkpoint is a working tree, not a history, and
 * rewinding your files should not rewrite your commits. In Loom's store the
 * index is a temporary one seeded with the tree being replaced, so
 * `read-tree -u` knows which files to delete.
 */
export async function restore(dir: string, id: string): Promise<RestoreResult> {
  const target = await find(dir, id);
  if (!target) throw new GitError(`no checkpoint "${id}" in this project`, "");

  // Before anything is lost: a checkpoint of what is about to be replaced.
  // Without this, rewind is a one-way door, and the one time it matters is
  // the time someone rewinds past work they meant to keep.
  const undo = await capture(dir, `before rewinding to ${target.label.slice(0, 80)}`, { store: target.store });
  if (!undo) throw new GitError("couldn't save the current files before rewinding — nothing was changed", "");
  const store = storeOf(dir, target);

  // What this rewind will actually do, from the two captured trees rather
  // than from `git diff`, which cannot see an untracked file — and an
  // untracked file is precisely what a rewind deletes.
  const changed = (await quiet(["diff", "--name-only", `${undo.commit}..${target.commit}`], dir, store.env))
    .split("\n")
    .filter(Boolean);

  if (store.kind === "git") {
    await run(["read-tree", "-u", "--reset", target.commit], dir);
    await run(["clean", "-f", "-d", "--", "."], dir);
    // read-tree moved the index to the checkpoint's tree as well as the files,
    // which would leave every restored change reading as *staged* — a rewind
    // that silently runs `git add` on your behalf. Putting the index back to
    // HEAD leaves `git status` saying what it would say if you had made those
    // edits by hand: modified, and untracked. --mixed touches the index only.
    await quiet(["reset", "-q", "--mixed", "HEAD"], dir);
  } else {
    const index = tmpIndex(store, `restore-${target.id}`);
    const env = { ...store.env, GIT_INDEX_FILE: index };
    try {
      await run(["read-tree", undo.commit], dir, env);
      await run(["read-tree", "-u", "--reset", target.commit], dir, env);
      await run(["clean", "-f", "-d", "--", "."], dir, env);
    } finally {
      dropIndex(index);
    }
  }
  return { restored: target, undo, changed };
}

/**
 * Put one file back the way a checkpoint had it — or remove it, when the
 * checkpoint didn't have it (the turn created it). Everything else is left
 * alone. Like a full rewind, it takes an undo checkpoint first.
 */
export async function restoreFile(dir: string, id: string, file: string): Promise<{ restored: Checkpoint; undo: Checkpoint; path: string; removed: boolean }> {
  const target = await find(dir, id);
  if (!target) throw new GitError(`no checkpoint "${id}" in this project`, "");
  const rel = file.replace(/^\.?\/+/, "");
  if (!rel || rel.split("/").includes("..")) throw new GitError(`"${file}" isn't a path inside this project`, "");
  const undo = await capture(dir, `before putting back ${rel.slice(0, 80)}`, { store: target.store });
  if (!undo) throw new GitError("couldn't save the current files first — nothing was changed", "");
  const store = storeOf(dir, target);
  const existed = (await quiet(["cat-file", "-t", `${target.commit}:${rel}`], dir, store.env)) === "blob";
  if (store.kind === "git") {
    if (existed) {
      await run(["checkout", target.commit, "--", rel], dir);
    } else {
      await quiet(["rm", "-q", "--cached", "--ignore-unmatch", "--", rel], dir);
      await fs.promises.rm(`${trimDir(dir)}/${rel}`, { force: true });
    }
    // checkout staged it; leave it reading as a plain edit, like a rewind does
    await quiet(["reset", "-q", "HEAD", "--", rel], dir);
  } else if (existed) {
    const index = tmpIndex(store, `file-${target.id}`);
    try {
      await run(["checkout", target.commit, "--", rel], dir, { ...store.env, GIT_INDEX_FILE: index });
    } finally {
      dropIndex(index);
    }
  } else {
    await fs.promises.rm(`${trimDir(dir)}/${rel}`, { force: true });
  }
  return { restored: target, undo, path: rel, removed: !existed };
}

/**
 * What changed since a checkpoint in Loom's store, for the turn's diff card.
 * A git project's turn diff comes from `git status` (core/worktree.ts); a
 * project without git has none, so this compares the checkpoint with the tree
 * as it is now — which also gives new files their content. Null for a git
 * checkpoint, or when nothing changed.
 */
export async function diffSince(dir: string, id: string): Promise<TurnDiff | null> {
  const target = await find(dir, id);
  if (!target || target.store !== "loom") return null;
  const store = loomStore(dir);
  try {
    const now = await writeTree(store, `diff-${newId()}`, target.commit, false);
    if (!now) return null;
    const lines = (await run(["diff", "--name-status", "--no-renames", target.commit, now], dir, store.env)).split("\n").filter(Boolean);
    if (!lines.length) return null;
    const files = lines.map((line) => {
      const [code, file] = line.split("\t");
      return { status: code === "A" ? "??" : code === "D" ? " D" : " M", path: file ?? "" };
    });
    let added = 0;
    let removed = 0;
    for (const line of (await run(["diff", "--numstat", "--no-renames", target.commit, now], dir, store.env)).split("\n")) {
      const [a, r] = line.split("\t");
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    const patch = await run(["diff", "--no-renames", target.commit, now], dir, store.env);
    const truncated = patch.length > PATCH_EVENT_LIMIT;
    return { files, added, removed, patch: truncated ? patch.slice(0, PATCH_EVENT_LIMIT) + "\n… (truncated)" : patch, truncated };
  } catch {
    return null;
  }
}

async function pruneStore(store: Store, keep: number): Promise<number> {
  const all = (await listStore(store)).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const drop = all.slice(Math.max(0, keep));
  for (const c of drop) await quiet(["update-ref", "-d", `${REF_PREFIX}/${c.id}`], store.dir, store.env);
  // A project's own repository collects its garbage on its own schedule; Loom's
  // store has nobody else to do it.
  if (drop.length && store.kind === "loom") await quiet(["gc", "--auto", "--quiet"], store.dir, store.env);
  return drop.length;
}

/** Drop all but the newest `keep` in each store. The commits become unreferenced. */
export async function prune(dir: string, keep = KEEP_CHECKPOINTS): Promise<number> {
  let dropped = 0;
  for (const store of await storesOf(dir)) dropped += await pruneStore(store, keep);
  return dropped;
}

/** Remove every checkpoint. For `loom rewind --forget`. */
export async function forgetAll(dir: string): Promise<number> {
  return prune(dir, 0);
}

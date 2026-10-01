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
 * into an object, and never restored. `.loom/` is excluded even if tracked, which is the
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

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
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
  prefix?: string;
  refs: string;
}

function run(args: string[], cwd: string, env?: Record<string, string>, timeoutMs = 30_000, allowNoMatch = false, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}) },
      (err, stdout, stderr) => {
        if (err && !(allowNoMatch && (err as { code?: unknown }).code === 1)) {
          const detail = String(stderr || err.message).trim();
          reject(new GitError(detail.split("\n").find((l) => l.trim())?.trim() || `git ${args[0]} failed`, detail));
          return;
        }
        resolve(String(stdout));
      },
    );
    if (input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
  });
}

/** Drain large patches while retaining only the display budget. */
function displayPatch(args: string[], store: Store): Promise<{ patch: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: store.dir, env: { ...process.env, ...store.env }, stdio: ["ignore", "pipe", "pipe"] });
    let patch = "", truncated = false, stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (patch.length + chunk.length > PATCH_EVENT_LIMIT) truncated = true;
      patch += chunk.slice(0, Math.max(0, PATCH_EVENT_LIMIT - patch.length));
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 2000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (code !== 0) reject(new GitError("patch unavailable", stderr));
      else resolve({ patch: patch + (truncated ? "\n… (truncated)" : ""), truncated }); });
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

async function gitStore(dir: string): Promise<Store> {
  const prefix = (await run(["rev-parse", "--show-prefix"], dir)).trimEnd();
  const store: Store = { kind: "git", dir, prefix, refs: prefix ? `${REF_PREFIX}/projects/${createHash("sha256").update(prefix).digest("hex")}` : REF_PREFIX,
    env: {}, scratch: (await run(["rev-parse", "--absolute-git-dir"], dir)).trim() };
  if (prefix) await migrateLegacy(store);
  return store;
}

/** Old refs have no project field. Migrate ids recorded in this project's own
 * history; changed paths alone cannot distinguish a root capture from a subproject.
 * An explicit legacy id remains usable when its history is no longer available. */
async function migrateLegacy(store: Store): Promise<void> {
  const legacy = await listStore({ ...store, refs: REF_PREFIX });
  if (!legacy.length) return;
  const ids = new Set<string>();
  const remember = (payload: Record<string, unknown>) => {
    if (typeof payload.cwd === "string" && path.resolve(payload.cwd) !== path.resolve(store.dir)) return;
    for (const key of ["id", "undo"]) if (typeof payload[key] === "string") ids.add(payload[key] as string);
  };
  const dbFile = path.join(store.dir, ".loom", "log.db");
  if (fs.existsSync(dbFile)) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try { for (const row of db.prepare("SELECT payload FROM events WHERE kind = 'checkpoint'").all()) remember(JSON.parse(String(row.payload))); }
      finally { db.close(); }
    } catch { /* JSONL and an explicit legacy id remain available. */ }
  }
  const jsonl = path.join(store.dir, ".loom", "log.jsonl");
  if (fs.existsSync(jsonl)) for (const line of fs.readFileSync(jsonl, "utf8").split("\n")) {
    try { const event = JSON.parse(line); if (event.kind === "checkpoint") remember(event.payload); } catch { /* incomplete tail */ }
  }
  try {
    const pending = JSON.parse(fs.readFileSync(path.join(store.dir, ".loom", "rewind-pending.json"), "utf8"));
    if (!pending.workspace?.dir || path.resolve(pending.workspace.dir) === path.resolve(store.dir)) {
      for (const cp of [pending.prepared?.target, pending.prepared?.undo]) if (typeof cp?.id === "string") ids.add(cp.id);
    }
  } catch { /* no readable recovery journal */ }
  for (const cp of legacy) {
    if (!ids.has(cp.id)) continue;
    // Captures from this version already have a namespace; a root capture's
    // changes happening to be in a subdirectory do not transfer ownership.
    if ((await quiet(["show", "-s", "--format=%B", cp.commit], store.dir)).includes("\nLoom-Project: ")) continue;
    await moveLegacy(store, cp);
  }
}

async function moveLegacy(store: Store, cp: Checkpoint): Promise<void> {
  // One ref transaction: a crash cannot hide or lose the old checkpoint.
  try {
    await run(["update-ref", "--stdin"], store.dir, store.env, 30_000, false,
      `start\ncreate ${store.refs}/${cp.id} ${cp.commit}\ndelete ${REF_PREFIX}/${cp.id} ${cp.commit}\nprepare\ncommit\n`);
  } catch (error) {
    // Another operation may have migrated the same id while we read history.
    if ((await quiet(["rev-parse", `${store.refs}/${cp.id}`], store.dir, store.env)) !== cp.commit) throw error;
  }
}

function loomStore(dir: string): Store {
  const gitDir = loomStorePath(dir);
  return { kind: "loom", dir, refs: REF_PREFIX, env: { GIT_DIR: gitDir, GIT_WORK_TREE: trimDir(dir) }, scratch: gitDir };
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
  if ((await quiet(["rev-parse", "--is-inside-work-tree"], dir)) === "true") stores.push(await gitStore(dir));
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
  return (await listStore(store)).sort((a, b) => b.id.localeCompare(a.id))[0]?.commit ?? null;
}

/**
 * Would this capture take in too much new content? Loom's store has no
 * .gitignore written by someone who knows the project, so a folder of media
 * or a dataset is skipped rather than copied into `.loom/` before every turn.
 */
async function tooMuchNew(store: Store, env: Record<string, string>): Promise<boolean> {
  let listed: string;
  try {
    listed = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], store.dir, env, STORE_LIMITS.listMs);
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
    const listed = (await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], store.dir, env)).split("\0").filter(Boolean);
    const ignored = new Set((await run(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], store.dir, env)).split("\0").filter(Boolean));
    const files = listed.filter(p => !protectedPath(p) && !ignored.has(p));
    if (files.length) await run(["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], store.dir, env, 30_000, false, files.join("\0") + "\0");
    const entries = await run(["ls-files", "--stage", "-z", "--", "."], store.dir, env);
    if (entries.split("\0").some(entry => entry.startsWith("160000 ")))
      throw new GitError("checkpoints cannot capture submodules or embedded repositories; move them outside this project before rewinding", "");
    // A tracked .loom in HEAD is just as unsafe as unignored bookkeeping.
    const excluded = listed.filter(p => protectedPath(p) || ignored.has(p));
    if (excluded.length) await run(["--literal-pathspecs", "rm", "-f", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], store.dir, env, 30_000, false, excluded.join("\0") + "\0");
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
export async function capture(dir: string, label: string, options: { store?: CheckpointStore; prune?: boolean } = {}): Promise<Checkpoint | null> {
  let store: Store;
  let head: string | null = null;
  try {
    head = options.store === "loom" ? null : await repoHead(dir);
    if (options.store === "git" && !head) return null;
    store = head ? await gitStore(dir) : await openLoomStore(dir);
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
          "-m", `Loom-Project: ${store.prefix || "."}`,
        ],
        dir,
        store.env,
      )
    ).trim();
    await run(["update-ref", `${store.refs}/${id}`, commit], dir, store.env);

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
    if (options.prune !== false) await pruneStore(store, KEEP_CHECKPOINTS);
    return cp;
  } catch (error) {
    if (error instanceof GitError && /submodules or embedded/.test(error.message)) throw error;
    // A checkpoint is a courtesy taken on a hot path. It must never be the
    // reason a turn doesn't run.
    return null;
  }
}

async function listStore(store: Store): Promise<Checkpoint[]> {
  const out = await quiet(
    ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(subject)%09%(committerdate:unix)", store.refs],
    store.dir,
    store.env,
  );
  if (!out) return [];
  const rows: Checkpoint[] = [];
  for (const line of out.split("\n")) {
    const [ref, commit, subject, when] = line.split("\t");
    if (!ref || !commit || ref.slice(0, ref.lastIndexOf("/")) !== store.refs) continue;
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
  const found = (await list(dir)).find((c) => c.id === id);
  if (found) return found;
  if ((await quiet(["rev-parse", "--is-inside-work-tree"], dir)) === "true") {
    const store = await gitStore(dir);
    if (store.prefix) {
      const legacy = (await listStore({ ...store, refs: REF_PREFIX })).find(c => c.id === id);
      if (legacy && !(await quiet(["show", "-s", "--format=%B", legacy.commit], dir)).includes("\nLoom-Project: ")) {
        await moveLegacy(store, legacy); return legacy;
      }
    }
  }
  return null;
}

const storeOf = async (dir: string, cp: Checkpoint): Promise<Store> => (cp.store === "loom" ? loomStore(dir) : await gitStore(dir));

const protectedPath = (rel: string) => rel.split("/").some(p => p.toLowerCase() === ".loom" || p.toLowerCase() === ".git");
async function safePath(dir: string, rel: string, checkedParents = new Set<string>()): Promise<void> {
  if (!rel || path.isAbsolute(rel) || rel.split("/").some(p => p === ".." || !p) || protectedPath(rel))
    throw new GitError(`"${rel}" isn't a path inside this project`, "");
  let parent = dir;
  for (const part of rel.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    if (checkedParents.has(parent)) continue;
    try { if ((await fs.promises.lstat(parent)).isSymbolicLink()) throw new GitError(`"${rel}" has a symlink parent`, ""); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    checkedParents.add(parent);
  }
}

/**
 * Put the working tree back to a checkpoint.
 *
 * Only paths in the captured trees move; an ignored file or Loom's journal
 * cannot be removed by a broad clean/read-tree. A temporary index keeps checkout
 * away from the user's staging area. HEAD does not move.
 */
export async function prepareRestore(dir: string, id: string, journal?: string): Promise<{ target: Checkpoint; undo: Checkpoint }> {
  const target = await find(dir, id);
  if (!target) throw new GitError(`no checkpoint "${id}" in this project`, "");

  // Before anything is lost: a checkpoint of what is about to be replaced.
  // Without this, rewind is a one-way door, and the one time it matters is
  // the time someone rewinds past work they meant to keep.
  const store = await storeOf(dir, target);
  if ((await run(["ls-tree", "-r", target.commit, "--", "."], dir, store.env)).split("\n").some(entry => entry.startsWith("160000 ")))
    throw new GitError("checkpoints cannot restore submodules or embedded repositories", "");
  const undo = await capture(dir, `before rewinding to ${target.label.slice(0, 80)}`, { store: target.store, prune: false });
  if (!undo) throw new GitError("couldn't save the current files before rewinding — nothing was changed", "");
  await restorePaths(dir, target, undo);
  // Separate recovery refs retain both trees without parenting undo commits on
  // targets. They live only until the restore and its conversation journal settle.
  const intent = journal ? (await run(["hash-object", "-w", "--stdin"], dir, store.env, 30_000, false,
    JSON.stringify({ journal: path.resolve(journal), at: Date.now() }))).trim() : undefined;
  await run(["update-ref", "--stdin"], dir, store.env, 30_000, false,
    `start\nupdate ${store.refs}/recovery/${undo.id}/target ${target.commit}\nupdate ${store.refs}/recovery/${undo.id}/undo ${undo.commit}\n` +
    (intent ? `update ${store.refs}/recovery/${undo.id}/journal ${intent}\n` : "") + "prepare\ncommit\n");
  return { target, undo };
}

async function restorePaths(dir: string, target: Checkpoint, undo: Checkpoint): Promise<string[]> {
  const store = await storeOf(dir, target);
  for (const cp of [target, undo]) if ((await run(["ls-tree", "-r", cp.commit, "--", "."], dir, store.env)).split("\n").some(entry => entry.startsWith("160000 ")))
    throw new GitError("checkpoints cannot restore submodules or embedded repositories", "");
  const changed = (await run(["diff", "--relative", "--no-renames", "--name-only", "-z", `${undo.commit}..${target.commit}`, "--", "."], dir, store.env)).split("\0").filter(Boolean);
  const paths: string[] = [];
  const ignored = new Set(changed.length ? (await run(["check-ignore", "--no-index", "-z", "--stdin"], dir, store.env, 30_000, true, changed.join("\0") + "\0")).split("\0").filter(Boolean) : []);
  // Cache only within this pass; mutation preflight must check parents anew.
  const checkedParents = new Set<string>();
  for (const rel of changed) {
    if (protectedPath(rel) || ignored.has(rel)) continue;
    await safePath(dir, rel, checkedParents);
    paths.push(rel);
  }
  return paths;
}

export async function restore(dir: string, id: string, prepared?: { target: Checkpoint; undo: Checkpoint }, beforeMutation?: () => void): Promise<RestoreResult> {
  const { target, undo } = prepared ?? await prepareRestore(dir, id);
  const store = await storeOf(dir, target);

  // Recheck immediately before mutation, including on journal retries.
  const paths = await restorePaths(dir, target, undo);
  const present = new Set((await run(["ls-tree", "-rz", "--name-only", "--full-tree", target.commit], dir, store.env)).split("\0").filter(p => !store.prefix || p.startsWith(store.prefix)).map(p => store.prefix ? p.slice(store.prefix.length) : p));
  if (paths.length) beforeMutation?.();
  for (const rel of paths.filter(p => !present.has(p)).sort((a, b) => b.length - a.length)) {
    await fs.promises.rm(path.join(dir, rel), { force: true });
    for (let parent = path.dirname(path.join(dir, rel)); parent !== path.resolve(dir); parent = path.dirname(parent)) {
      try { await fs.promises.rmdir(parent); } catch { break; } // only empty directories; ignored files survive
    }
  }
  const index = tmpIndex(store, `restore-${target.id}`);
  try {
    const files = paths.filter(p => present.has(p));
    if (files.length) {
      const env = { ...store.env, GIT_INDEX_FILE: index };
      await run(["read-tree", target.commit], dir, env);
      // checkout-index looks up literal names, avoiding Git pathspec matching
      // against every entry for each of 20k paths. Run at the repository root.
      const root = store.prefix ? path.resolve(dir, ...store.prefix.split("/").filter(Boolean).map(() => "..")) : dir;
      await run(["checkout-index", "--force", "-z", "--stdin"], root, env, 30_000, false,
        files.map(file => `${store.prefix ?? ""}${file}`).join("\0") + "\0");
    }

  } finally { dropIndex(index); }
  // The daemon's mutation callback means its conversation recovery still owns
  // these pins; it releases them after removing the journal.
  if (!beforeMutation) await releasePins(store, undo.id);
  return { restored: target, undo, changed: paths };
}

/**
 * Put one file back the way a checkpoint had it — or remove it, when the
 * checkpoint didn't have it (the turn created it). Everything else is left
 * alone. Like a full rewind, it takes an undo checkpoint first.
 */
export async function restoreFile(dir: string, id: string, file: string): Promise<{ restored: Checkpoint; undo: Checkpoint; path: string; removed: boolean }> {
  const target = await find(dir, id);
  if (!target) throw new GitError(`no checkpoint "${id}" in this project`, "");
  const rel = file.replace(/^\.\//, "");
  await safePath(dir, rel);
  const targetStore = await storeOf(dir, target);
  if ((await run(["ls-tree", "-r", target.commit, "--", "."], dir, targetStore.env)).split("\n").some(entry => entry.startsWith("160000 ")))
    throw new GitError("checkpoints cannot restore submodules or embedded repositories", "");
  // Ignored content has no undo blob; absence from a tree cannot mean created.
  if ((await run(["check-ignore", "--no-index", "--", rel], dir, targetStore.env, undefined, true)))
    throw new GitError(`"${file}" is excluded from checkpoints`, "");
  const undo = await capture(dir, `before putting back ${rel.slice(0, 80)}`, { store: target.store, prune: false });
  if (!undo) throw new GitError("couldn't save the current files first — nothing was changed", "");
  const store = await storeOf(dir, target);
  const present = (await run(["ls-tree", "-rz", "--name-only", "--full-tree", target.commit], dir, store.env)).split("\0");
  const existed = present.includes(`${store.prefix ?? ""}${rel}`);
  if (existed) {
    const index = tmpIndex(store, `file-${target.id}`);
    try {
      await run(["--literal-pathspecs", "checkout", target.commit, "--", rel], dir, { ...store.env, GIT_INDEX_FILE: index });
    } finally { dropIndex(index); }
  } else {
    await fs.promises.rm(path.join(dir, rel), { force: true });
  }
  return { restored: target, undo, path: rel, removed: !existed };
}

/**
 * What changed since a checkpoint in Loom's store, for the turn's diff card.
 * Both stores compare content with the checkpoint, so edits to a file already
 * dirty before the turn are attributed too. Null when nothing changed.
 */
export async function diffSince(dir: string, id: string): Promise<TurnDiff | null> {
  const target = await find(dir, id);
  if (!target) return null;
  const store = await storeOf(dir, target);
  try {
    const now = await writeTree(store, `diff-${newId()}`, target.commit, store.kind === "loom");
    if (!now) return null;
    const lines = (await run(["diff", "--relative", "--name-status", "-z", "--no-renames", target.commit, now, "--", "."], dir, store.env)).split("\0").filter(Boolean);
    if (!lines.length) return null;
    const files = [];
    for (let i = 0; i < lines.length; i += 2) {
      const code = lines[i];
      files.push({ status: code === "A" ? "??" : code === "D" ? " D" : " M", path: lines[i + 1]! });
    }
    let added = 0;
    let removed = 0;
    for (const line of (await run(["diff", "--relative", "--numstat", "--no-renames", target.commit, now, "--", "."], dir, store.env)).split("\n")) {
      const [a, r] = line.split("\t");
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    const preview = await displayPatch(["diff", "--relative", "--no-renames", target.commit, now, "--", "."], store)
      .catch(() => ({ patch: "Patch preview unavailable", truncated: true }));
    return { files, added, removed, ...preview };
  } catch {
    return null;
  }
}

async function releasePins(store: Store, id: string): Promise<void> {
  await run(["update-ref", "--stdin"], store.dir, store.env, 30_000, false,
    `start\ndelete ${store.refs}/recovery/${id}/target\ndelete ${store.refs}/recovery/${id}/undo\ndelete ${store.refs}/recovery/${id}/journal\nprepare\ncommit\n`);
}

/** Release a completed or explicitly abandoned recovery, including old journals. */
export async function releaseRestore(dir: string, prepared: { target: Checkpoint; undo: Checkpoint }): Promise<void> {
  for (const store of await storesOf(dir)) {
    if (store.kind === prepared.undo.store) await releasePins(store, prepared.undo.id);
  }
}

async function pruneStore(store: Store, keep: number): Promise<number> {
  const all = (await listStore(store)).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // A crash between preparation and journal publication must not leave an
  // immortal pin. Give publication a minute, then collect pins without intent.
  const recoveries = (await run(["for-each-ref", "--format=%(refname)%09%(objectname)", `${store.refs}/recovery/`], store.dir, store.env)).trim().split("\n");
  for (const row of keep === 0 ? [] : recoveries) {
    const [ref, object] = row.split("\t");
    if (!ref?.endsWith("/journal") || !object) continue;
    const intent = JSON.parse(await run(["cat-file", "blob", object], store.dir, store.env)) as { journal: string; at: number };
    if (!fs.existsSync(intent.journal) && Date.now() - intent.at > 60_000) {
      const id = ref.split("/").at(-2)!;
      await releasePins(store, id);
    }
  }
  const pinned = new Set((await quiet(["for-each-ref", "--format=%(objectname)", `${store.refs}/recovery/`], store.dir, store.env)).split("\n"));
  // Older versions have journals but no recovery refs. Honour those until they
  // are retried, including journals in linked checkouts sharing this repository.
  const dirs = new Set([store.dir]);
  if (store.kind === "git") {
    const worktrees = await quiet(["worktree", "list", "--porcelain"], store.dir);
    for (const line of worktrees.split("\n")) if (line.startsWith("worktree ")) {
      const root = line.slice(9); dirs.add(root);
      if (store.prefix) dirs.add(path.join(root, store.prefix));
    }
  }
  for (const dir of dirs) {
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(dir, ".loom", "rewind-pending.json"), "utf8"));
      for (const cp of [journal.prepared?.target, journal.prepared?.undo]) if (typeof cp?.commit === "string") pinned.add(cp.commit);
    } catch { /* no readable journal */ }
  }
  const drop = all.slice(Math.max(0, keep)).filter(c => keep === 0 || !pinned.has(c.commit));
  for (const c of drop) await quiet(["update-ref", "-d", `${store.refs}/${c.id}`], store.dir, store.env);
  if (keep === 0) {
    const refs = (await quiet(["for-each-ref", "--format=%(refname)", `${store.refs}/recovery/`], store.dir, store.env)).split("\n").filter(Boolean);
    for (const ref of refs) await run(["update-ref", "-d", ref], store.dir, store.env);
  }
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

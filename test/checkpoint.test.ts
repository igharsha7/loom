/**
 * Checkpoints, against real repositories.
 *
 * Every test here makes a git repo, writes real files, captures, changes the
 * files for real, and rewinds. Nothing is mocked, because the whole feature is
 * a claim about what git does to a working directory — and the failure mode
 * being guarded against is "it deleted something it shouldn't have", which a
 * mock cannot have an opinion about.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { capture, diffSince, find, forgetAll, list, prune, restore, restoreFile, STORE_LIMITS } from "../src/core/checkpoint.js";
import { tmpDir } from "./helpers.js";
import { turnSnapshot, diffSinceSnapshot } from "../src/core/worktree.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const read = (dir: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
};
const write = (dir: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

/** A repo with one commit, a .gitignore, and an ignored secret in it. */
function repo(): string {
  const dir = tmpDir("ckpt");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  write(dir, ".gitignore", ".env\nnode_modules/\n.loom/\n");
  write(dir, "app.ts", "export const port = 3000;\n");
  write(dir, "README.md", "# a project\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  // Things that must survive every rewind untouched.
  write(dir, ".env", "SECRET=hunter2\n");
  write(dir, "node_modules/left/index.js", "module.exports = 1;\n");
  write(dir, ".loom/events.db", "pretend this is the log\n");
  return dir;
}

describe("taking a checkpoint", () => {
  it("captures tracked changes and brand new files alike", async () => {
    const dir = repo();
    write(dir, "app.ts", "export const port = 8080;\n"); // modified
    write(dir, "notes.md", "an untracked file\n"); // never seen by git

    const cp = (await capture(dir, "before the turn"))!;
    expect(cp).toBeTruthy();
    expect(cp.label).toBe("before the turn");
    expect(cp.branch).toBe("main");
    // Two files differ from HEAD: the edit and the new file.
    expect(cp.dirty).toBe(2);

    // The captured commit really holds both, at the content they had.
    const inTree = git(dir, "ls-tree", "-r", "--name-only", cp.commit).split("\n").filter(Boolean);
    expect(inTree).toContain("app.ts");
    expect(inTree).toContain("notes.md");
    expect(git(dir, "show", `${cp.commit}:app.ts`)).toBe("export const port = 8080;\n");
    expect(git(dir, "show", `${cp.commit}:notes.md`)).toBe("an untracked file\n");
  });

  /**
   * The one that would be a security incident rather than a bug. `.env` is in
   * .gitignore, so it must never reach the object store — not on capture, and
   * therefore not on any restore either.
   */
  it("never reads an ignored file, least of all .env", async () => {
    const dir = repo();
    const cp = (await capture(dir, "seed"))!;
    const inTree = git(dir, "ls-tree", "-r", "--name-only", cp.commit).split("\n").filter(Boolean);
    expect(inTree).not.toContain(".env");
    expect(inTree.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(inTree.some((f) => f.startsWith(".loom/"))).toBe(false);
    // And git itself agrees there is no such blob to show.
    expect(() => git(dir, "show", `${cp.commit}:.env`)).toThrow();
  });

  /**
   * A checkpoint that moved HEAD, dirtied the index or pushed onto the stash
   * would be doing something to the repository the human didn't ask for.
   */
  it("leaves HEAD, the branch, the index and the stash exactly as they were", async () => {
    const dir = repo();
    write(dir, "app.ts", "export const port = 8080;\n");
    write(dir, "staged.txt", "deliberately staged\n");
    git(dir, "add", "staged.txt");

    const headBefore = git(dir, "rev-parse", "HEAD").trim();
    const statusBefore = git(dir, "status", "--porcelain");
    const branchesBefore = git(dir, "branch", "--list");

    await capture(dir, "no side effects please");

    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(git(dir, "branch", "--list")).toBe(branchesBefore);
    expect(git(dir, "stash", "list").trim()).toBe("");
    // The checkpoint ref exists but is not a branch anyone will see.
    expect(git(dir, "branch", "--list")).not.toContain("checkpoint");
    expect(fs.readdirSync(path.join(dir, ".git")).some((f) => f.startsWith("loom-checkpoint-"))).toBe(false);
  });

  it("keeps a project with no repository, or no commit yet, in Loom's own store", async () => {
    const plain = tmpDir("norepo");
    write(plain, "a.txt", "a\n");
    expect(await capture(plain, "x")).toMatchObject({ store: "loom" });
    // A repository with no commits: no HEAD to parent on, so Loom's store too.
    const fresh = tmpDir("empty");
    git(fresh, "init", "-q", "-b", "main");
    write(fresh, "a.txt", "a\n");
    expect(await capture(fresh, "x")).toMatchObject({ store: "loom" });
    // …and the project's own repository is left exactly as it was.
    expect(git(fresh, "status", "--porcelain")).toContain("?? a.txt");
    expect(git(fresh, "for-each-ref")).toBe("");
  });
});

describe("rewinding to a checkpoint", () => {
  it("puts back what was edited, deletes what was added, and restores what was deleted", async () => {
    const dir = repo();
    write(dir, "keep.md", "written before the checkpoint\n");
    const cp = (await capture(dir, "before the agent ran"))!;

    // Now an agent does its worst.
    write(dir, "app.ts", "export const port = 9999;\n"); // edited
    write(dir, "generated.ts", "// forty files of this\n"); // created
    fs.rmSync(path.join(dir, "README.md")); // deleted
    fs.rmSync(path.join(dir, "keep.md")); // deleted, and untracked

    const out = await restore(dir, cp.id);

    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");
    expect(read(dir, "generated.ts")).toBeNull();
    expect(read(dir, "README.md")).toBe("# a project\n");
    expect(read(dir, "keep.md")).toBe("written before the checkpoint\n");
    expect(out.restored.id).toBe(cp.id);
    expect(out.changed.sort()).toEqual(["README.md", "app.ts", "generated.ts", "keep.md"]);
  });

  /** The rule that makes rewind safe to click: it is itself rewindable. */
  it("saves the files it is about to replace, so a rewind can be rewound", async () => {
    const dir = repo();
    const before = (await capture(dir, "the start"))!;
    write(dir, "app.ts", "export const port = 9999;\n");
    write(dir, "work-i-forgot-about.ts", "an hour of typing\n");

    const first = await restore(dir, before.id);
    // The rewind did what it said.
    expect(read(dir, "work-i-forgot-about.ts")).toBeNull();
    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");

    // …and handed back the way out.
    expect(first.undo.id).not.toBe(before.id);
    expect(first.undo.label).toContain("before rewinding to");
    await restore(dir, first.undo.id);
    expect(read(dir, "work-i-forgot-about.ts")).toBe("an hour of typing\n");
    expect(read(dir, "app.ts")).toBe("export const port = 9999;\n");
  });

  it("leaves ignored files alone — .env, node_modules and the event log", async () => {
    const dir = repo();
    const cp = (await capture(dir, "before"))!;
    write(dir, "app.ts", "changed\n");
    // Things written after the checkpoint that are nobody's business.
    write(dir, ".env", "SECRET=rotated\n");
    write(dir, "node_modules/new-dep/index.js", "1\n");
    write(dir, ".loom/events.db", "a hundred more events\n");

    await restore(dir, cp.id);

    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n"); // rewound
    expect(read(dir, ".env")).toBe("SECRET=rotated\n"); // untouched
    expect(read(dir, "node_modules/new-dep/index.js")).toBe("1\n"); // untouched
    expect(read(dir, ".loom/events.db")).toBe("a hundred more events\n"); // untouched
  });

  /**
   * A checkpoint restores files, not history. Moving HEAD would turn "undo
   * what the agent wrote" into "undo three of my commits", which is not what
   * anybody clicking Rewind is asking for.
   */
  it("does not move HEAD or touch the branch", async () => {
    const dir = repo();
    const cp = (await capture(dir, "before"))!;
    write(dir, "later.ts", "work worth keeping\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "a commit made after the checkpoint");
    const head = git(dir, "rev-parse", "HEAD").trim();
    const log = git(dir, "log", "--oneline");

    write(dir, "app.ts", "scribble\n");
    await restore(dir, cp.id);

    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "log", "--oneline")).toBe(log);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("refuses an id it does not have, and changes nothing", async () => {
    const dir = repo();
    write(dir, "app.ts", "mine\n");
    await expect(restore(dir, "cnope")).rejects.toThrow(/no checkpoint/);
    await expect(restore(dir, "../../etc/passwd")).rejects.toThrow(/no checkpoint/);
    expect(read(dir, "app.ts")).toBe("mine\n");
  });
});

describe("putting back one file", () => {
  it("restores that file, removes one the turn created, and leaves everything else as it is", async () => {
    const dir = repo();
    const cp = (await capture(dir, "before the turn"))!;
    write(dir, "app.ts", "export const port = 9999;\n");
    write(dir, "README.md", "# rewritten\n");
    write(dir, "added.ts", "new\n");
    const one = await restoreFile(dir, cp.id, "app.ts");
    expect(one.removed).toBe(false);
    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");
    expect(read(dir, "README.md")).toBe("# rewritten\n"); // untouched
    const gone = await restoreFile(dir, cp.id, "added.ts");
    expect(gone.removed).toBe(true);
    expect(read(dir, "added.ts")).toBeNull();
    // it reads as a plain edit, not staged
    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("");
    // and the version it replaced was saved first
    expect(await find(dir, one.undo.id)).not.toBeNull();
    expect(read(dir, ".env")).toBe("SECRET=hunter2\n");
  });

  it("refuses a path outside the project", async () => {
    const dir = repo();
    const cp = (await capture(dir, "x"))!;
    await expect(restoreFile(dir, cp.id, "../outside.txt")).rejects.toThrow(/isn't a path inside/);
  });
});

describe("keeping the list short", () => {
  it("lists newest first, finds one by id, and prunes the rest away", async () => {
    const dir = repo();
    const made = [];
    for (const n of [1, 2, 3, 4, 5]) {
      write(dir, "app.ts", `step ${n}\n`);
      made.push((await capture(dir, `step ${n}`))!);
    }
    const all = await list(dir);
    expect(all).toHaveLength(5);
    expect(all[0]!.id).toBe(made[4]!.id); // newest first
    expect(all[0]!.label).toBe("step 5");
    expect((await find(dir, made[0]!.id))!.label).toBe("step 1");

    expect(await prune(dir, 2)).toBe(3);
    const kept = await list(dir);
    expect(kept.map((c) => c.label)).toEqual(["step 5", "step 4"]);
    // A pruned checkpoint is gone from the answer, not silently still there.
    expect(await find(dir, made[0]!.id)).toBeNull();

    expect(await forgetAll(dir)).toBe(2);
    expect(await list(dir)).toEqual([]);
  });

  /**
   * Two captures in the same millisecond used to collide — which is exactly
   * what a restore does, since it checkpoints the current tree immediately
   * before restoring another one.
   */
  it("gives two checkpoints taken in the same tick different ids", async () => {
    const dir = repo();
    const a = (await capture(dir, "a"))!;
    const b = (await capture(dir, "b"))!;
    expect(a.id).not.toBe(b.id);
    expect((await list(dir)).map((c) => c.label)).toEqual(["b", "a"]);
  });
});

/**
 * `read-tree --reset` moves the index as well as the files, which left every
 * restored change reading as staged — a rewind that had quietly run `git add`
 * over your repository.
 */
describe("what git status says afterwards", () => {
  it("leaves changes unstaged and new files untracked, as if you had typed them", async () => {
    const dir = repo();
    write(dir, "app.ts", "export const port = 8080;\n");
    write(dir, "extra.ts", "new and untracked\n");
    const cp = (await capture(dir, "before"))!;

    // Wander off, then come back.
    write(dir, "app.ts", "export const port = 1;\n");
    fs.rmSync(path.join(dir, "extra.ts"));
    await restore(dir, cp.id);

    const status = git(dir, "status", "--porcelain").split("\n").filter(Boolean).sort();
    expect(status).toEqual([" M app.ts", "?? extra.ts"]);
    // Nothing staged: the first column is a space or a ?, never M or A.
    expect(status.every((l) => l[0] === " " || l[0] === "?")).toBe(true);
    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("");
  });
});


/** A folder that isn't a git repository, with things a rewind must never touch. */
function plainProject(): string {
  const dir = tmpDir("plain");
  write(dir, "app.ts", "export const port = 3000;\n");
  write(dir, "src/util.ts", "export const one = 1;\n");
  write(dir, ".env", "SECRET=hunter2\n");
  write(dir, "node_modules/left/index.js", "module.exports = 1;\n");
  write(dir, ".loom/events.db", "pretend this is the log\n");
  return dir;
}

describe("Loom's own store (a project without git)", () => {
  it("captures, rewinds and undoes the rewind, leaving excluded files and .loom alone", async () => {
    const dir = plainProject();
    const cp = (await capture(dir, "before the turn"))!;
    expect(cp.store).toBe("loom");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", cp.commit], { cwd: dir, encoding: "utf8",
      env: { ...process.env, GIT_DIR: path.join(dir, ".loom", "checkpoints.git") } }).split("\n").filter(Boolean);
    expect(tree.sort()).toEqual(["app.ts", "src/util.ts"]);

    // The turn: an edit, a new file, a deletion, and one by a shell command.
    write(dir, "app.ts", "export const port = 8080;\n");
    write(dir, "generated/out.ts", "made by the agent\n");
    fs.rmSync(path.join(dir, "src/util.ts"));
    execFileSync("sh", ["-c", "echo appended >> app.ts"], { cwd: dir });
    write(dir, "node_modules/left/index.js", "module.exports = 2;\n");

    const out = await restore(dir, cp.id);
    expect(out.changed.sort()).toEqual(["app.ts", "generated/out.ts", "src/util.ts"]);
    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");
    expect(read(dir, "src/util.ts")).toBe("export const one = 1;\n");
    expect(read(dir, "generated/out.ts")).toBeNull();
    expect(fs.existsSync(path.join(dir, "generated"))).toBe(false);
    expect(read(dir, ".env")).toBe("SECRET=hunter2\n");
    expect(read(dir, "node_modules/left/index.js")).toBe("module.exports = 2;\n");
    expect(read(dir, ".loom/events.db")).toBe("pretend this is the log\n");

    // Undo: the turn's work comes back.
    await restore(dir, out.undo.id);
    expect(read(dir, "app.ts")).toBe("export const port = 8080;\nappended\n");
    expect(read(dir, "generated/out.ts")).toBe("made by the agent\n");
    expect(read(dir, "src/util.ts")).toBeNull();
  });

  it("puts one file back, or removes one the turn created", async () => {
    const dir = plainProject();
    const cp = (await capture(dir, "before"))!;
    write(dir, "app.ts", "changed\n");
    write(dir, "new.ts", "new\n");
    write(dir, "src/util.ts", "changed too\n");
    await restoreFile(dir, cp.id, "app.ts");
    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");
    expect(read(dir, "src/util.ts")).toBe("changed too\n");
    expect(await restoreFile(dir, cp.id, "new.ts")).toMatchObject({ removed: true });
    expect(read(dir, "new.ts")).toBeNull();
  });

  it("says what a turn changed, with new files' content", async () => {
    const dir = plainProject();
    const cp = (await capture(dir, "before"))!;
    expect(await diffSince(dir, cp.id)).toBeNull();
    write(dir, "app.ts", "export const port = 8080;\n");
    write(dir, "fresh.ts", "hello\n");
    fs.rmSync(path.join(dir, "src/util.ts"));
    const diff = (await diffSince(dir, cp.id))!;
    expect(diff.files).toEqual([{ status: " M", path: "app.ts" }, { status: "??", path: "fresh.ts" }, { status: " D", path: "src/util.ts" }]);
    expect(diff).toMatchObject({ added: 2, removed: 2, truncated: false });
    expect(diff.patch).toContain("+hello");
    // A git project's turn diff comes from git status, not from here.
    const gitDir = repo();
    const gitCp = (await capture(gitDir, "x"))!;
    write(gitDir, "app.ts", "changed\n");
    expect((await diffSince(gitDir, gitCp.id))!.files.map(f => f.path)).toEqual(["app.ts"]);
  });

  it("skips a capture that would take in too much new content", async () => {
    const dir = plainProject();
    const was = STORE_LIMITS.files;
    STORE_LIMITS.files = 3;
    try {
      for (const n of [1, 2, 3, 4]) write(dir, `data/${n}.csv`, "x\n");
      expect(await capture(dir, "too much")).toBeNull();
    } finally {
      STORE_LIMITS.files = was;
    }
    expect(await capture(dir, "fine")).toMatchObject({ store: "loom" });
  });

  it("lists, prunes and forgets checkpoints in Loom's store", async () => {
    const dir = plainProject();
    for (const n of [1, 2, 3]) { write(dir, "app.ts", `step ${n}\n`); await capture(dir, `step ${n}`); }
    expect((await list(dir)).map((c) => [c.label, c.store])).toEqual([["step 3", "loom"], ["step 2", "loom"], ["step 1", "loom"]]);
    expect(await prune(dir, 1)).toBe(2);
    expect(await forgetAll(dir)).toBe(1);
    expect(await list(dir)).toEqual([]);
  });
});

describe("checkpoint safety regressions", () => {
  it("refuses deletion through a directory symlink (#1)", async () => {
    const dir = repo(), outside = tmpDir("outside");
    write(outside, "victim.txt", "keep me");
    fs.symlinkSync(outside, path.join(dir, "escape"));
    const cp = (await capture(dir, "symlink"))!;
    await expect(restoreFile(dir, cp.id, "escape/victim.txt")).rejects.toThrow(/symlink/);
    expect(read(outside, "victim.txt")).toBe("keep me");
  });
  it("refuses excluded single-file restores without losing the file (#2)", async () => {
    for (const dir of [repo(), tmpDir("excluded")]) {
      write(dir, ".env", "SECRET=keep");
      const cp = (await capture(dir, "secret"))!;
      await expect(restoreFile(dir, cp.id, ".env")).rejects.toThrow(/excluded/);
      expect(read(dir, ".env")).toBe("SECRET=keep");
    }
  });
  it("protects unignored and tracked Loom bookkeeping (#3)", async () => {
    const dir = repo();
    write(dir, ".gitignore", ".env\nnode_modules/\n");
    git(dir, "add", "-f", ".loom/events.db"); git(dir, "commit", "-qm", "tracked bookkeeping");
    const cp = (await capture(dir, "before"))!;
    expect(git(dir, "ls-tree", "-r", "--name-only", cp.commit)).not.toContain(".loom/");
    // An old checkpoint may still contain the journal; restore must protect it too.
    git(dir, "update-ref", `refs/loom/checkpoints/${cp.id}`, git(dir, "rev-parse", "HEAD").trim());
    write(dir, ".loom/events.db", "new journal"); write(dir, "app.ts", "changed");
    await restore(dir, cp.id);
    expect(read(dir, ".loom/events.db")).toBe("new journal");
    await expect(restoreFile(dir, cp.id, ".loom/events.db")).rejects.toThrow(/inside/);
  });
  it("captures and restores a linked worktree (#19)", async () => {
    const dir = repo(), linked = path.join(tmpDir("linked"), "work");
    git(dir, "worktree", "add", "-qb", "linked", linked);
    const cp = (await capture(linked, "linked"))!;
    expect(cp).toBeTruthy(); write(linked, "app.ts", "changed");
    await restore(linked, cp.id);
    expect(read(linked, "app.ts")).toContain("3000");
    git(dir, "worktree", "remove", "--force", linked);
  });
  it("attributes content changes to an already-dirty file (#25)", async () => {
    const dir = repo(); write(dir, "app.ts", "before\n");
    const cp = (await capture(dir, "dirty"))!;
    write(dir, "app.ts", "after\n");
    const diff = (await diffSince(dir, cp.id))!;
    expect(diff.files.map(f => f.path)).toEqual(["app.ts"]);
    expect(diff.patch).toContain("-before"); expect(diff.patch).toContain("+after");
  });
});

 it("attributes already-dirty edits even without a checkpoint (#25)", async () => {
   const dir = repo(); write(dir, "app.ts", "before\n");
   const snapshot = await turnSnapshot(dir); write(dir, "app.ts", "after\n");
   expect((await diffSinceSnapshot(dir, snapshot))!.files.map(f => f.path)).toEqual(["app.ts"]);
 });

describe("port audit checkpoint regressions", () => {
  it("restores project-relative paths inside a repository subdirectory (#2)", async () => {
    const root = repo(), dir = path.join(root, "nested");
    write(dir, "app/file.txt", "before");
    write(root, "outside.txt", "outside");
    const cp = (await capture(dir, "nested"))!;
    write(dir, "app/file.txt", "after");
    await restoreFile(dir, cp.id, "app/file.txt");
    expect(read(dir, "app/file.txt")).toBe("before");
    write(dir, "app/file.txt", "after again");
    await restore(dir, cp.id);
    expect(read(dir, "app/file.txt")).toBe("before");
    expect(read(root, "outside.txt")).toBe("outside");
    expect(read(dir, "nested/app/file.txt")).toBeNull();
  });
  it("never overwrites newly ignored content or carries it into later captures (#3)", async () => {
    for (const dir of [repo(), tmpDir("ignore-store")]) {
      write(dir, "private.txt", "captured");
      const cp = (await capture(dir, "before ignore"))!;
      write(dir, ".gitignore", "private.txt\n.loom/\n");
      write(dir, "private.txt", "current secret");
      const later = (await capture(dir, "ignored now"))!;
      const env = later.store === "loom" ? ["--git-dir", path.join(dir, ".loom/checkpoints.git")] : [];
      expect(git(dir, ...env, "ls-tree", "-r", "--name-only", later.commit)).not.toContain("private.txt");
      await restore(dir, cp.id);
      expect(read(dir, "private.txt")).toBe("current secret");
    }
  });
  it("preserves staged versions distinct from HEAD and the worktree (#4)", async () => {
    const dir = repo(), cp = (await capture(dir, "before"))!;
    write(dir, "app.ts", "staged version"); git(dir, "add", "app.ts");
    write(dir, "app.ts", "working version");
    const index = git(dir, "write-tree");
    await restore(dir, cp.id);
    expect(git(dir, "write-tree")).toBe(index);
    await restoreFile(dir, cp.id, "app.ts");
    expect(git(dir, "show", ":app.ts")).toBe("staged version");
  });
  it("preserves whitespace in the first changed filename (#23)", async () => {
    const dir = repo(); write(dir, " leading.txt", "before");
    const cp = (await capture(dir, "spaces"))!;
    write(dir, " leading.txt", "after");
    expect((await restore(dir, cp.id)).changed).toContain(" leading.txt");
    expect(read(dir, " leading.txt")).toBe("before");
  });
  it("enforces the store cap while computing a turn diff (#21)", async () => {
    const dir = tmpDir("diff-cap"), cp = (await capture(dir, "empty"))!;
    const old = STORE_LIMITS.bytes; STORE_LIMITS.bytes = 10;
    try { write(dir, "big.txt", "x".repeat(11)); expect(await diffSince(dir, cp.id)).toBeNull(); }
    finally { STORE_LIMITS.bytes = old; }
    expect(git(dir, "--git-dir", path.join(dir, ".loom/checkpoints.git"), "count-objects", "-v")).toContain("count: 2");
  });
  it("bounds pre-turn hashing of oversized dirty files (#21)", async () => {
    const dir = repo();
    const fd = fs.openSync(path.join(dir, "huge.bin"), "w");
    fs.ftruncateSync(fd, 257 * 1024 * 1024); fs.closeSync(fd);
    expect(await turnSnapshot(dir)).toBe("");
  });
});

vi.mock("node:child_process", { spy: true });
import * as childProcess from "node:child_process";

it.each(["diff", "ls-tree"])("fails restore before touching files when git %s fails (#5)", async command => {
  const dir = repo(), cp = (await capture(dir, "before"))!;
  write(dir, "app.ts", "keep this");
  const exec = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile;
  const spy = vi.spyOn(childProcess, "execFile").mockImplementation(((...args: unknown[]) => {
    const argv = args[1] as string[];
    if (argv[0] === command && (command !== "diff" || argv.includes("-z"))) {
      (args[3] as Function)(new Error("injected git failure"), "", "injected git failure");
      return {};
    }
    return Reflect.apply(exec, childProcess, args);
  }) as typeof childProcess.execFile);
  try {
    await expect(command === "diff" ? restore(dir, cp.id) : restoreFile(dir, cp.id, "app.ts")).rejects.toThrow("injected git failure");
    expect(read(dir, "app.ts")).toBe("keep this");
  } finally { spy.mockRestore(); }
});

it("returns project-relative turn paths inside a parent repository (audit #13)", async () => {
  const root = repo(), dir = path.join(root, "apps", "web");
  write(dir, "file.ts", "before\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "nested");
  const cp = (await capture(dir, "nested"))!;
  write(dir, "file.ts", "after\n");
  const diff = (await diffSince(dir, cp.id))!;
  expect(diff.files.map(f => f.path)).toEqual(["file.ts"]);
  await restoreFile(dir, cp.id, diff.files[0]!.path);
  expect(read(dir, "file.ts")).toBe("before\n");
});

it("prepares an undo point without pruning the target (audit #2)", async () => {
  const dir = repo(), cp = (await capture(dir, "oldest"))!;
  // Fill the retention window; the next ordinary capture would prune cp.
  for (let i = 1; i < 60; i++) await capture(dir, `point ${i}`);
  const { prepareRestore } = await import("../src/core/checkpoint.js");
  const prepared = await prepareRestore(dir, cp.id);
  expect(await find(dir, cp.id)).not.toBeNull();
  await restore(dir, cp.id, prepared);
});

it("diffs ordinary git repos above the Loom-store limits (#8)", async () => {
  const dir = repo(), cp = (await capture(dir, "before"))!;
  const oldFiles = STORE_LIMITS.files, oldBytes = STORE_LIMITS.bytes;
  STORE_LIMITS.files = 1; STORE_LIMITS.bytes = 1;
  try {
    write(dir, "app.ts", "export const port = 9000;\n");
    expect(await diffSince(dir, cp.id)).toMatchObject({ files: [{ path: "app.ts" }], added: 1, removed: 1 });
  } finally { STORE_LIMITS.files = oldFiles; STORE_LIMITS.bytes = oldBytes; }
});

it("hashes and diffs repo-relative porcelain paths from a project subdirectory (#10)", async () => {
  const dir = repo(), sub = path.join(dir, "nested");
  write(dir, "nested/code.txt", "one\n"); git(dir, "add", "nested/code.txt"); git(dir, "commit", "-qm", "nested");
  write(dir, "nested/code.txt", "two\n");
  const before = await turnSnapshot(sub);
  expect(JSON.parse(before).loomTurnTree["nested/code.txt"].hash).not.toBe("missing");
  write(dir, "nested/code.txt", "three\n");
  const diff = await diffSinceSnapshot(sub, before);
  expect(diff?.files).toEqual([{ status: " M", path: "code.txt" }]);
  expect(diff?.patch).toContain("+three");
});

it("isolates sibling project checkpoint lists, restore and retention (finding #6)", async () => {
  const dir = repo();
  write(dir, "a/file.txt", "A"); write(dir, "b/file.txt", "B");
  git(dir, "add", "a", "b"); git(dir, "commit", "-qm", "siblings");
  const a = path.join(dir, "a"), b = path.join(dir, "b");
  const ca = (await capture(a, "A"))!, cb = (await capture(b, "B"))!;
  const { prepareRestore } = await import("../src/core/checkpoint.js");
  write(dir, "a/file.txt", "A2");
  const prepared = await prepareRestore(a, ca.id);
  expect((await list(a)).map(c => c.id)).not.toContain(cb.id);
  expect((await list(dir)).map(c => c.id)).not.toContain(ca.id);
  await expect(restore(a, cb.id)).rejects.toThrow(/no checkpoint/);
  await prune(b, 0);
  expect(await find(a, ca.id)).not.toBeNull();
  expect(await find(a, prepared.undo.id)).not.toBeNull();
  await prune(a, 1);
  expect(await find(a, prepared.undo.id)).not.toBeNull();
  git(dir, "gc", "--prune=now");
  git(dir, "cat-file", "-e", ca.commit);
  await restore(a, ca.id, prepared);
  expect(read(a, "file.txt")).toBe("A");
});

it.each([false, true])("refuses embedded repos and submodules explicitly, tracked=%s (finding #12)", async tracked => {
  const dir = repo(), nested = path.join(dir, "embedded");
  fs.mkdirSync(nested);
  git(nested, "init", "-q"); git(nested, "config", "user.email", "t@t"); git(nested, "config", "user.name", "t");
  write(nested, "file.txt", "one"); git(nested, "add", "."); git(nested, "commit", "-qm", "inner");
  if (tracked) { git(dir, "add", "embedded"); git(dir, "commit", "-qm", "gitlink"); }
  await expect(capture(dir, "incomplete")).rejects.toThrow(/submodules or embedded/);
  expect(read(nested, "file.txt")).toBe("one");
});

it("restores many paths with batched Git preflight and staging (finding #15)", async () => {
  const dir = repo();
  for (let i = 0; i < 20_000; i++) write(dir, `many/${i}.txt`, "before\n");
  const cp = (await capture(dir, "many"))!;
  for (let i = 0; i < 20_000; i++) write(dir, `many/${i}.txt`, "after\n");
  const start = vi.mocked(execFile).mock.calls.length;
  const lstat = vi.spyOn(fs.promises, "lstat");
  try {
    const result = await restore(dir, cp.id);
    const launches = vi.mocked(execFile).mock.calls.slice(start);
    expect(result.changed).toHaveLength(20_000);
    expect(launches.length).toBeLessThan(45);
    expect(launches.filter(call => (call[1] as string[]).includes("check-ignore"))).toHaveLength(2);
    expect(launches.filter(call => (call[1] as string[]).includes("checkout-index"))).toHaveLength(1);
    expect(lstat.mock.calls.filter(call => String(call[0]) === path.join(dir, "many"))).toHaveLength(2);
    for (let i = 0; i < 20_000; i++) expect(read(dir, `many/${i}.txt`)).toBe("before\n");
  } finally { lstat.mockRestore(); }
  // The budget includes 40k fixture writes under the full suite's disk load.
  // Batching and every restored file are verified independently of elapsed time.
}, 120_000);

it("retains files and counts when a text patch exceeds 64 MiB (finding #16)", async () => {
  const dir = repo(), cp = (await capture(dir, "before large text"))!;
  write(dir, "large.txt", "x".repeat(65 * 1024 * 1024) + "\n");
  const diff = await diffSince(dir, cp.id);
  expect(diff).toMatchObject({ files: [{ path: "large.txt" }], added: 1, removed: 0, truncated: true });
  expect(diff!.patch.length).toBeLessThan(13_000);
}, 30_000);

it("returns literal project-relative fallback paths, including newline names (finding #14)", async () => {
  const dir = repo(), sub = path.join(dir, "nested"); fs.mkdirSync(sub);
  const before = await turnSnapshot(sub);
  write(sub, " report\nname.txt", "new\n"); write(dir, "outside.txt", "outside\n");
  const diff = await diffSinceSnapshot(sub, before);
  expect(diff?.files).toEqual([{ status: "??", path: " report\nname.txt" }]);
  const { stageAndCommitFiles } = await import("../src/core/git.js");
  await stageAndCommitFiles(sub, diff!.files.map(f => f.path), "nested turn");
  expect(git(dir, "show", "HEAD:nested/ report\nname.txt")).toBe("new\n");
});

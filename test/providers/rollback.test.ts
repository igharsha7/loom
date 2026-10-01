/**
 * Phase 4 — checkpoints and revert, against the protocol fakes. A rewind to a
 * checkpoint puts the files back and rolls the chat's native conversations
 * back with them: Codex reverts its thread before the dropped turn, Claude
 * forks its session before it. When that can't be done, nothing is touched.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../../src/daemon/runtime.js";
import { ClaudeCodeAdapter, CodexAdapter, stopAllProviderSessions } from "../../src/providers/agent.js";
import type { ClaudeHistory } from "../../src/providers/claude/adapter.js";
import { readProjectConfig, writeProjectConfig } from "../../src/core/registry.js";
import { MAIN_CHAT } from "../../src/types.js";
import { makeProjectDir } from "../helpers.js";
import { CODEX_OK, callsOf, fakeClaude, fakeCodex, rpcOf, stdinOf, turnsOf } from "../native-fakes.js";

const open: ProjectRuntime[] = [];
afterEach(async () => { await stopAllProviderSessions(); });
afterAll(async () => { for (const rt of open) await rt.close().catch(() => {}); await stopAllProviderSessions(); });

const bindings = (dir: string): Array<Record<string, unknown>> =>
  (JSON.parse(fs.readFileSync(path.join(dir, ".loom", "providers", "sessions.json"), "utf8")) as { bindings: Array<Record<string, unknown>> }).bindings;
const binding = (dir: string, chat = MAIN_CHAT) => bindings(dir).find((b) => b.threadId === chat)!;
const tick = () => new Promise((r) => setTimeout(r, 5));
const turnIds = (bin: string) => turnsOf(bin).map((t) => `turn-${t.pid}-${t.turn}`);

/** A Claude history built from what the fake CLI was sent: each user message, then a reply. */
function claudeHistory(bin: string, forks: Array<{ sessionId: string; upTo: string }>, drop: string[] = []): ClaudeHistory {
  const histories = new Map<string, Awaited<ReturnType<ClaudeHistory["messages"]>>>();
  const history: ClaudeHistory = {
    messages: async session => histories.get(session) ?? stdinOf(bin).filter((m) => m.type === "user" && typeof m.uuid === "string" && !drop.includes(m.uuid as string))
      .flatMap((m) => [{ type: "user", uuid: m.uuid as string, message: m.message }, { type: "assistant", uuid: `reply-${m.uuid as string}`, message: { content: "reply" } }]),
    fork: async (sessionId, dir, upTo) => {
      forks.push({ sessionId, upTo });
      const id = `fork-${forks.length}`, messages = await history.messages(sessionId, dir);
      histories.set(id, messages.slice(0, messages.findIndex(m => m.uuid === upTo) + 1));
      return { sessionId: id };
    },
  };
  return history;
}

describe("codex · conversation rollback", () => {
  it("reverts the thread before the first turn since the checkpoint, and stays warm", async () => {
    const bin = fakeCodex();
    const dir = makeProjectDir({ name: "rb" });
    const agent = new CodexAdapter("codex", dir, { bin });
    await agent.send({ text: "one" });
    await tick();
    const cutoff = Date.now();
    await tick();
    await agent.send({ text: "two" });
    await agent.send({ text: "three" });
    const [first, second] = turnIds(bin);
    expect(binding(dir).turnLedger).toMatchObject({ fromStart: true });

    const step = await agent.planRollback(MAIN_CHAT, cutoff);
    expect(step).toMatchObject({ beforeTurnId: second, turns: 2, provider: "codex" });
    await agent.rollbackConversation(step!);
    expect(rpcOf(bin, "thread/revert")).toEqual([{ threadId: expect.any(String), beforeTurnId: second }]);
    expect((binding(dir).turnLedger as { turns: Array<{ id: string }> }).turns.map((t) => t.id)).toEqual([first]);

    // The same app-server carries on with the rolled-back thread.
    await agent.send({ text: "four" });
    expect(callsOf(bin)).toHaveLength(1);
    await agent.stop();
  });

  it("falls back to thread/rollback on a thread with legacy history", async () => {
    const bin = fakeCodex({ legacyHistory: true });
    const dir = makeProjectDir({ name: "rb" });
    const agent = new CodexAdapter("codex", dir, { bin });
    await agent.send({ text: "one" });
    await tick();
    const cutoff = Date.now();
    await tick();
    await agent.send({ text: "two" });
    await agent.send({ text: "three" });
    await agent.rollbackConversation((await agent.planRollback(MAIN_CHAT, cutoff))!);
    expect(rpcOf(bin, "thread/rollback")).toEqual([{ threadId: expect.any(String), numTurns: 2 }]);
    await agent.stop();
  });

  it("drops the whole native session when every turn is after the checkpoint", async () => {
    const bin = fakeCodex();
    const dir = makeProjectDir({ name: "rb" });
    const agent = new CodexAdapter("codex", dir, { bin });
    const cutoff = Date.now();
    await tick();
    await agent.send({ text: "one" });
    await agent.send({ text: "two" });
    const step = await agent.planRollback(MAIN_CHAT, cutoff);
    expect(step).toMatchObject({ beforeTurnId: null, turns: 2 });
    await agent.rollbackConversation(step!);
    expect(rpcOf(bin, "thread/revert")).toHaveLength(0);
    expect(binding(dir).resumeCursor).toBeNull();
    // The next turn starts a new thread.
    await agent.send({ text: "again" });
    expect(rpcOf(bin, "thread/start")).toHaveLength(2);
    expect(rpcOf(bin, "thread/resume")).toHaveLength(0);
    await agent.stop();
  });

  it("has nothing to roll back when no turn ran since the checkpoint, or in another chat", async () => {
    const bin = fakeCodex();
    const dir = makeProjectDir({ name: "rb" });
    const agent = new CodexAdapter("codex", dir, { bin });
    await agent.send({ text: "one" });
    await tick();
    const cutoff = Date.now();
    await tick();
    await agent.send({ text: "side", chat: "side" });
    expect(await agent.planRollback(MAIN_CHAT, cutoff)).toBeNull();
    expect(await agent.planRollback("side", cutoff)).toMatchObject({ threadId: "side", beforeTurnId: null });
    await agent.stop();
  });

  it("refuses when the turns since the checkpoint aren't on record", async () => {
    const dir = makeProjectDir({ name: "rb" });
    // A binding written before turn ledgers, active after the checkpoint.
    fs.mkdirSync(path.join(dir, ".loom", "providers"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".loom", "providers", "sessions.json"), JSON.stringify({ version: 1, bindings: [{
      threadId: MAIN_CHAT, instanceId: "codex", provider: "codex", status: "stopped", resumeCursor: "thread-old",
      runtimePayload: { cwd: dir }, runtimeMode: "auto-accept-edits", lastSeenAt: Date.now() }] }));
    const agent = new CodexAdapter("codex", dir, { bin: fakeCodex() });
    await expect(agent.planRollback(MAIN_CHAT, Date.now() - 60_000)).rejects.toThrow(/aren't on record/);
    // From the moment it was loaded, its turns are known.
    expect(await agent.planRollback(MAIN_CHAT, Date.now() + 1000)).toBeNull();
    await agent.stop();
  });
});

describe("claude · conversation rollback", () => {
  it("forks the session before the dropped turn and resumes the fork next turn", async () => {
    const bin = fakeClaude();
    const dir = makeProjectDir({ name: "rb" });
    const forks: Array<{ sessionId: string; upTo: string }> = [];
    const agent = new ClaudeCodeAdapter("claude", dir, { bin, claudeHistory: claudeHistory(bin, forks) });
    await agent.send({ text: "one" });
    await tick();
    const cutoff = Date.now();
    await tick();
    await agent.send({ text: "two" });
    const [first, second] = stdinOf(bin).filter((m) => m.type === "user").map((m) => m.uuid as string);
    const session = binding(dir).resumeCursor as string;

    const step = await agent.planRollback(MAIN_CHAT, cutoff);
    expect(step).toMatchObject({ beforeTurnId: second, turns: 1 });
    await agent.rollbackConversation(step!);
    // Kept through the reply to turn one; the original session is untouched.
    expect(forks).toEqual([{ sessionId: session, upTo: `reply-${first}` }]);
    expect(binding(dir)).toMatchObject({ resumeCursor: "fork-1", status: "stopped" });

    await agent.send({ text: "three" });
    const relaunch = callsOf(bin).at(-1)!;
    expect(relaunch.join(" ")).toContain("fork-1");
    expect(relaunch.some((a) => a === "--resume" || a.startsWith("--resume="))).toBe(true);
    await agent.stop();
  });

  it("refuses when the dropped turn isn't in the session history, and changes nothing", async () => {
    const bin = fakeClaude();
    const dir = makeProjectDir({ name: "rb" });
    const forks: Array<{ sessionId: string; upTo: string }> = [];
    const dropped: string[] = [];
    const agent = new ClaudeCodeAdapter("claude", dir, { bin, claudeHistory: claudeHistory(bin, forks, dropped) });
    await agent.send({ text: "one" });
    await tick();
    const cutoff = Date.now();
    await tick();
    await agent.send({ text: "two" });
    // Compaction replaced turn two's message in the native history.
    dropped.push(stdinOf(bin).filter((m) => m.type === "user").at(-1)!.uuid as string);
    const before = binding(dir);
    await expect(agent.planRollback(MAIN_CHAT, cutoff)).rejects.toThrow(/isn't in claude's session history/);
    expect(forks).toHaveLength(0);
    expect(binding(dir).resumeCursor).toBe(before.resumeCursor);
    await agent.stop();
  });
});

// ---------------------------------------------------------------------------
// Through the runtime: files and conversation together
// ---------------------------------------------------------------------------

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
};

async function gitRuntime(bin: string, worktrees = false) {
  const dir = makeProjectDir({ agents: [{ id: "codex", kind: "codex", options: { bin } }] });
  if (worktrees) writeProjectConfig(dir, { ...readProjectConfig(dir), git: { worktreePerAgent: true } });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "app.txt"), "v0\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  const rt = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "rb", dir });
  open.push(rt);
  return { rt, dir };
}

async function turn(rt: ProjectRuntime, text: string, chat?: string) {
  const done = rt.log.list().filter((e) => e.kind === "run_complete").length;
  await rt.sendMessage(text, "codex", chat ? { chat } : {});
  await until(() => !rt.anyBusy() && rt.log.list().filter((e) => e.kind === "run_complete").length > done);
}

const checkpointBefore = (rt: ProjectRuntime, label: string) =>
  String(rt.log.list().find((e) => e.kind === "checkpoint" && e.payload.reason === "before_turn" && e.payload.label === label)!.payload.id);

describe("runtime · rewind", () => {
  it("restores and undoes a linked agent checkout without changing the project checkout (#19)", async () => {
    const { rt, dir } = await gitRuntime(fakeCodex(), true), checkout = rt.agentDir("codex");
    expect(checkout).not.toBe(dir);
    await turn(rt, "first");
    const cp = checkpointBefore(rt, "first"), file = path.join(checkout, "app.txt");
    fs.writeFileSync(path.join(dir, "app.txt"), "project work\n");
    fs.writeFileSync(file, "agent work\n");
    const restored = await rt.rewind(cp, { conversation: false });
    expect(fs.readFileSync(file, "utf8")).toBe("v0\n");
    await rt.rewind(restored.undo.id, { conversation: false });
    expect(fs.readFileSync(file, "utf8")).toBe("agent work\n");
    const single = await rt.rewindFile(cp, "app.txt");
    expect(fs.readFileSync(file, "utf8")).toBe("v0\n");
    await rt.rewindFile(single.undo.id, "app.txt");
    expect(fs.readFileSync(file, "utf8")).toBe("agent work\n");
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("project work\n");
    await rt.close();
    git(dir, "worktree", "remove", "--force", checkout);
  });

  it("puts the files and the chat's conversation back to before a turn", async () => {
    const bin = fakeCodex();
    const { rt, dir } = await gitRuntime(bin);
    await turn(rt, "first");
    fs.writeFileSync(path.join(dir, "app.txt"), "v1\n");
    await turn(rt, "second");
    fs.writeFileSync(path.join(dir, "app.txt"), "v2\n");
    const cp = checkpointBefore(rt, "second");

    const out = await rt.rewind(cp);
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("v1\n");
    expect(out.conversation).toEqual([{ agentId: "codex", provider: "codex", turns: 1 }]);
    expect(rpcOf(bin, "thread/revert")).toHaveLength(1);
    const logged = rt.log.list().filter((e) => e.kind === "checkpoint" && e.payload.reason === "rewound").at(-1)!;
    expect(logged.payload).toMatchObject({ chat: MAIN_CHAT, conversation: [{ agentId: "codex", turns: 1 }] });
  });

  it("refuses before touching files when the conversation can't go back, and rewinds files alone on request", async () => {
    const bin = fakeCodex();
    const { rt, dir } = await gitRuntime(bin);
    await turn(rt, "first");
    await turn(rt, "second");
    fs.writeFileSync(path.join(dir, "app.txt"), "changed\n");
    const cp = checkpointBefore(rt, "second");
    // The ledger is lost: the turns since the checkpoint aren't on record.
    const file = path.join(dir, ".loom", "providers", "sessions.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { bindings: Array<Record<string, unknown>> };
    await stopAllProviderSessions();
    await rt.close();
    for (const b of doc.bindings) { delete b.turnLedger; b.lastSeenAt = Date.now(); }
    fs.writeFileSync(file, JSON.stringify(doc));
    const again = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "rb", dir });
    open.push(again);

    await expect(again.rewind(cp)).rejects.toThrow(/aren't on record.*Nothing was changed/);
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("changed\n");
    const out = await again.rewind(cp, { conversation: false });
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("v0\n");
    expect(out.conversation).toEqual([]);
  });

  it("rolls back only the checkpoint's own chat", async () => {
    const bin = fakeCodex();
    const { rt, dir } = await gitRuntime(bin);
    const side = rt.createChat("side", { agentId: "codex" });
    await turn(rt, "first");
    await turn(rt, "in the side chat", side.id);
    await turn(rt, "second");
    await turn(rt, "more on the side", side.id);
    const cp = checkpointBefore(rt, "second");
    const sideTurns = (binding(dir, side.id).turnLedger as { turns: unknown[] }).turns.length;
    const out = await rt.rewind(cp);
    expect(out.conversation).toEqual([{ agentId: "codex", provider: "codex", turns: 1 }]);
    expect(rpcOf(bin, "thread/revert")).toHaveLength(1);
    expect((binding(dir, side.id).turnLedger as { turns: unknown[] }).turns).toHaveLength(sideTurns);
  });
});

describe("runtime · rewind without git", () => {
  it("checkpoints, shows the turn's changes, and rewinds files and conversation the same way", async () => {
    const bin = fakeCodex({ scripts: [CODEX_OK, [{ spawn: "require('node:fs').writeFileSync('app.txt', 'native edit\\n')" }, { sleep: 100 }, ...CODEX_OK], CODEX_OK] });
    const dir = makeProjectDir({ agents: [{ id: "codex", kind: "codex", options: { bin } }] });
    fs.writeFileSync(path.join(dir, "app.txt"), "v0\n");
    const rt = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "plain", dir });
    open.push(rt);
    await turn(rt, "first");
    fs.writeFileSync(path.join(dir, "app.txt"), "v1\n");
    await turn(rt, "second");
    fs.writeFileSync(path.join(dir, "app.txt"), "v2\n");
    fs.writeFileSync(path.join(dir, "made.txt"), "by the second turn\n");
    await turn(rt, "third");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);

    // Turn cards: what changed, and the point to put it back to. (The test's
    // own writes land between turns, so which card names them is timing.)
    await until(() => rt.log.list().some((e) => e.kind === "turn_diff"));
    const diffs = rt.log.list().filter((e) => e.kind === "turn_diff");
    const ids = new Set(rt.log.list().filter((e) => e.kind === "checkpoint").map((e) => e.payload.id));
    expect(diffs.every((d) => ids.has(d.payload.checkpoint))).toBe(true);
    expect(diffs.some((d) => (d.payload.files as Array<{ path: string }>).some((f) => f.path === "app.txt"))).toBe(true);

    const out = await rt.rewind(checkpointBefore(rt, "second"));
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("v1\n");
    expect(fs.existsSync(path.join(dir, "made.txt"))).toBe(false);
    expect(out.conversation).toEqual([{ agentId: "codex", provider: "codex", turns: 2 }]);
    expect(rpcOf(bin, "thread/revert")).toHaveLength(1);
  });
});


describe("fork boundary regressions", () => {
  it("remaps retained Claude UUIDs so a second rewind succeeds (#12)", async () => {
    const bin = fakeClaude(), dir = makeProjectDir();
    const histories = new Map<string, Awaited<ReturnType<ClaudeHistory["messages"]>>>();
    let seq = 0;
    const history: ClaudeHistory = {
      messages: async session => histories.get(session) ?? stdinOf(bin).filter(m => m.type === "user").flatMap(m =>
        [{ type: "user", uuid: String(m.uuid), message: m.message }, { type: "assistant", uuid: `reply-${m.uuid}`, message: { content: "reply" } }]),
      fork: async (session, cwd, through) => {
        const messages = await history.messages(session, cwd), id = `fork-${++seq}`;
        histories.set(id, messages.slice(0, messages.findIndex(m => m.uuid === through) + 1).map(m => ({ ...m, uuid: `${id}:${m.uuid}` })));
        return { sessionId: id };
      },
    };
    const agent = new ClaudeCodeAdapter("claude", dir, { bin, claudeHistory: history });
    await agent.send({ text: "A" }); await tick(); const beforeB = Date.now(); await tick();
    await agent.send({ text: "B" }); await tick(); const beforeC = Date.now(); await tick();
    await agent.send({ text: "C" });
    await agent.rollbackConversation((await agent.planRollback("main", beforeC))!);
    const kept = (binding(dir).turnLedger as { turns: Array<{ id: string }> }).turns;
    expect(kept.map(t => t.id)).toEqual(histories.get("fork-1")!.filter(m => m.type === "user").map(m => m.uuid));
    await agent.rollbackConversation((await agent.planRollback("main", beforeB))!);
    expect(binding(dir).resumeCursor).toBe("fork-2");
    await agent.stop();
  });
});

it("refuses a compacted-away Claude boundary before restoring any files (#13)", async () => {
  const bin = fakeClaude(), dir = makeProjectDir({ agents: [{ id: "claude", kind: "claude-code", options: { bin } }] });
  fs.writeFileSync(path.join(dir, "app.txt"), "v0");
  const rt = await ProjectRuntime.open({ id: `p-${Math.random()}`, name: "preflight", dir }); open.push(rt);
  const run = async (text: string) => {
    const done = rt.log.list().filter(e => e.kind === "run_complete").length;
    await rt.sendMessage(text, "claude");
    await until(() => !rt.anyBusy() && rt.log.list().filter(e => e.kind === "run_complete").length > done);
  };
  await run("A"); await run("B");
  const missing = String(stdinOf(bin).filter(m => m.type === "user").at(-1)!.uuid);
  const agent = rt.agent("claude") as unknown as { adapter: { options: { history: ClaudeHistory } } };
  agent.adapter.options.history = {
    messages: async () => stdinOf(bin).filter(m => m.type === "user" && m.uuid !== missing).map(m => ({ type: "user", uuid: String(m.uuid) })),
    fork: async () => { throw new Error("must not fork"); },
  };
  fs.writeFileSync(path.join(dir, "app.txt"), "keep this work");
  const cp = String(rt.log.list().find(e => e.payload.reason === "before_turn" && e.payload.label === "B")!.payload.id);
  await expect(rt.rewind(cp)).rejects.toThrow(/Nothing was changed/);
  expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("keep this work");
});

import { ClaudeProviderAdapter } from "../../src/providers/claude/adapter.js";
import { vi } from "vitest";

it("aligns Claude fork conversation bodies from the retained end (#10)", async () => {
  const messages = [
    { type: "user", uuid: "A", parent_tool_use_id: null, message: { content: "A" } },
    { type: "assistant", uuid: "reply-A", message: { content: "answer A" } },
    { type: "user", uuid: "tool", parent_tool_use_id: null, message: { content: [{ type: "tool_result", content: "result" }] } },
    { type: "user", uuid: "B", parent_tool_use_id: null, message: { content: "B" } },
  ];
  const forked = [{ type: "user", uuid: "steering", message: { content: "steering prefix" } }, ...messages.slice(0, 3).map(m => ({ ...m, uuid: `fork-${m.uuid}` }))];
  const history: ClaudeHistory = { messages: async id => id === "fork" ? forked : messages, fork: async () => ({ sessionId: "fork" }) };
  const adapter = new ClaudeProviderAdapter("claude", { history });
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set("main", { info: { threadId: "main", cwd: "/repo" }, sessionId: "original", turn: null });
  const stop = vi.spyOn(adapter, "stopSession").mockResolvedValue();
  try {
    expect((await adapter.rollbackThread("main", "B")).turnIds).toEqual({ A: "fork-A" });
    forked[1]!.message = { content: "different body" };
    await expect(adapter.rollbackThread("main", "B")).rejects.toThrow(/does not preserve/);
  } finally { stop.mockRestore(); }
});

import * as checkpoints from "../../src/core/checkpoint.js";

it("does not leave a durable intent for a nonexistent checkpoint (audit #2)", async () => {
  const { rt, dir } = await gitRuntime(fakeCodex());
  await expect(rt.rewind("cp-missing", { conversation: false })).rejects.toThrow(/no checkpoint/);
  expect(fs.existsSync(path.join(dir, ".loom", "rewind-pending.json"))).toBe(false);
  await turn(rt, "still usable");
});

it("restores the saved checkout after its agent is disabled and runtime restarts (audit #3)", async () => {
  const { rt, dir } = await gitRuntime(fakeCodex(), true), checkout = rt.agentDir("codex");
  await turn(rt, "first");
  const cp = checkpointBefore(rt, "first");
  fs.writeFileSync(path.join(dir, "app.txt"), "main work\n");
  fs.writeFileSync(path.join(checkout, "app.txt"), "agent work\n");
  rt.baton.release("codex"); rt.setAgentEnabled("codex", false);
  await rt.close();
  const again = await ProjectRuntime.open(rt.info); open.push(again);
  await again.rewind(cp, { conversation: false });
  expect(fs.readFileSync(path.join(checkout, "app.txt"), "utf8")).toBe("v0\n");
  expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("main work\n");
  await again.close(); git(dir, "worktree", "remove", "--force", checkout);
});

it("retries the saved rollback boundary and retains pre-checkpoint turns (audit #6)", async () => {
  const bin = fakeCodex(), { rt, dir } = await gitRuntime(bin);
  await turn(rt, "first"); await turn(rt, "second");
  const cp = checkpointBefore(rt, "second"), agent = rt.agent("codex") as CodexAdapter;
  const rollback = vi.spyOn(agent, "rollbackConversation").mockRejectedValueOnce(new Error("temporary failure"));
  const first = await rt.rewind(cp);
  expect(first.conversation[0]?.error).toBe("temporary failure");
  const intent = JSON.parse(fs.readFileSync(path.join(dir, ".loom", "rewind-pending.json"), "utf8"));
  expect(intent.steps[0].beforeTurnId).toBe(turnIds(bin)[1]);
  rollback.mockRestore();
  await rt.rewind(cp);
  expect((binding(dir).turnLedger as { turns: unknown[] }).turns).toHaveLength(1);
  expect(binding(dir).resumeCursor).not.toBeNull();
  expect(rpcOf(bin, "thread/revert")[0]?.beforeTurnId).toBe(turnIds(bin)[1]);
});

it("rewinds persisted conversations of disabled agents (audit #7)", async () => {
  const bin = fakeCodex(), { rt, dir } = await gitRuntime(bin);
  await turn(rt, "first"); await turn(rt, "second");
  const cp = checkpointBefore(rt, "second");
  rt.baton.release("codex"); rt.setAgentEnabled("codex", false); await rt.close();
  const again = await ProjectRuntime.open(rt.info); open.push(again);
  const out = await again.rewind(cp);
  expect(out.conversation).toEqual([{ agentId: "codex", provider: "codex", turns: 1 }]);
  expect((binding(dir).turnLedger as { turns: unknown[] }).turns).toHaveLength(1);
  again.setAgentEnabled("codex", true);
  await turn(again, "third");
  expect((binding(dir).turnLedger as { turns: unknown[] }).turns).toHaveLength(2);
});

it("recognizes an already applied Codex cut with a stale durable ledger (#2)", async () => {
  const bin = fakeCodex({ legacyHistory: true }), dir = makeProjectDir();
  const agent = new CodexAdapter("codex", dir, { bin });
  await agent.send({ text: "one" }); await tick(); const cutoff = Date.now(); await tick();
  await agent.send({ text: "two" }); await agent.send({ text: "three" });
  const step = (await agent.planRollback("main", cutoff))!;
  const service = (agent as unknown as { providers: { service: import("../../src/providers/service.js").ProviderService } }).providers.service;
  const original = service.directory.get("main", "codex")!;
  await agent.rollbackConversation(step);
  // Crash/lost acknowledgement before the shortened ledger was persisted.
  service.directory.upsert(original);
  await agent.stop();
  const again = new CodexAdapter("codex", dir, { bin });
  await again.rollbackConversation(step);
  expect((binding(dir).turnLedger as { turns: unknown[] }).turns).toHaveLength(1);
  expect(rpcOf(bin, "thread/rollback")).toHaveLength(1);
  await again.stop();
});

it("validates and rolls back paginated Codex history across every page (#6)", async () => {
  const bin = fakeCodex({ paginatedHistory: true, legacyHistory: true }), dir = makeProjectDir();
  const agent = new CodexAdapter("codex", dir, { bin });
  await agent.send({ text: "one" }); await tick(); const cutoff = Date.now(); await tick();
  await agent.send({ text: "two" }); await agent.send({ text: "three" });
  const step = (await agent.planRollback("main", cutoff))!;
  expect(rpcOf(bin, "thread/turns/list").map(p => p.cursor)).toEqual([null, "1", "2"]);
  await agent.rollbackConversation(step);
  expect(rpcOf(bin, "thread/rollback")[0]?.numTurns).toBe(2);
  await agent.stop();
});

it("escapes failed native rollback using files-only or its undo checkpoint (#3)", async () => {
  for (const undo of [false, true]) {
    const bin = fakeCodex(), { rt, dir } = await gitRuntime(bin);
    await turn(rt, "first"); await turn(rt, "second");
    const cp = checkpointBefore(rt, "second"), agent = rt.agent("codex") as CodexAdapter;
    const rollback = vi.spyOn(agent, "rollbackConversation").mockRejectedValue(new Error("permanent failure"));
    const first = await rt.rewind(cp);
    expect(first.conversation[0]?.error).toBe("permanent failure");
    const out = await rt.rewind(undo ? first.undo.id : cp, undo ? {} : { conversation: false });
    expect(out.conversation).toEqual([]);
    expect(rollback).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(dir, ".loom", "rewind-pending.json"))).toBe(false);
    rollback.mockRestore();
    await turn(rt, "unblocked");
  }
});

it("a symlink-parent restore refusal leaves no blocking rewind journal (#3)", async () => {
  const { rt, dir } = await gitRuntime(fakeCodex());
  fs.mkdirSync(path.join(dir, "folder")); fs.writeFileSync(path.join(dir, "folder", "file"), "old");
  await turn(rt, "checkpoint");
  const cp = checkpointBefore(rt, "checkpoint");
  fs.rmSync(path.join(dir, "folder"), { recursive: true });
  const outside = makeProjectDir(); fs.writeFileSync(path.join(outside, "file"), "safe");
  fs.symlinkSync(outside, path.join(dir, "folder"));
  await expect(rt.rewind(cp, { conversation: false })).rejects.toThrow(/symlink|symbolic link/);
  expect(fs.existsSync(path.join(dir, ".loom", "rewind-pending.json"))).toBe(false);
  expect(fs.readFileSync(path.join(outside, "file"), "utf8")).toBe("safe");
});

it("keeps a persisted files-only origin null on a default retry (#7)", async () => {
  const { rt, dir } = await gitRuntime(fakeCodex()); await turn(rt, "first");
  const cp = checkpointBefore(rt, "first"), journal = path.join(dir, ".loom", "rewind-pending.json");
  fs.writeFileSync(journal, JSON.stringify({ id: cp, origin: null, steps: [] }));
  const out = await rt.rewind(cp);
  expect(out.conversation).toEqual([]);
  const event = rt.log.list().filter(e => e.payload.reason === "rewound").at(-1)!;
  expect(event.payload.dropped).toBeUndefined();
  expect(event.payload.chat).toBeUndefined();
  expect(fs.existsSync(journal)).toBe(false);
});

it("files-only releases pending recovery even if the saved checkout is gone (#3)", async () => {
  const { rt, dir } = await gitRuntime(fakeCodex()); await turn(rt, "first");
  const cp = checkpointBefore(rt, "first"), journal = path.join(dir, ".loom", "rewind-pending.json");
  fs.writeFileSync(journal, JSON.stringify({ id: cp, origin: null, steps: [], workspace: { dir: path.join(dir, "gone") } }));
  fs.writeFileSync(path.join(dir, "app.txt"), "Main must survive\n");
  const out = await rt.rewind(cp, { conversation: false });
  expect(out).toEqual({ recoveryReleased: true, message: expect.stringMatching(/no files were restored/), changed: [], conversation: [] });
  expect(fs.existsSync(journal)).toBe(false);
  expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("Main must survive\n");
  expect(rt.log.list().some(e => e.payload.state === "rewind_recovery_released")).toBe(true);
  await turn(rt, "ordinary recovery");
});

it("captures the full native retained prefix when Loom only knows recent turns (#2)", async () => {
  const bin = fakeCodex(), dir = makeProjectDir(), agent = new CodexAdapter("codex", dir, { bin });
  await agent.send({ text: "old history" }); await tick(); const cutoff = Date.now(); await tick();
  await agent.send({ text: "recent" });
  const service = (agent as unknown as { providers: { service: import("../../src/providers/service.js").ProviderService } }).providers.service;
  const original = service.directory.get("main", "codex")!;
  service.directory.upsert({ ...original, turnLedger: { since: cutoff - 1, fromStart: false, turns: original.turnLedger!.turns.slice(1) } });
  const stale = service.directory.get("main", "codex")!, step = (await agent.planRollback("main", cutoff))!;
  expect(step.retainedTurnIds).toEqual([turnIds(bin)[0]]);
  await agent.rollbackConversation(step); service.directory.upsert(stale);
  await agent.rollbackConversation(step);
  expect(rpcOf(bin, "thread/revert")).toHaveLength(1);
  await agent.stop();
});

it("releases an unreadable rewind journal through files-only (#3)", async () => {
  const { rt, dir } = await gitRuntime(fakeCodex()); await turn(rt, "first");
  const cp = checkpointBefore(rt, "first"), journal = path.join(dir, ".loom", "rewind-pending.json");
  fs.writeFileSync(journal, "{");
  await expect(rt.rewind(cp)).rejects.toThrow(/files-only/);
  await rt.rewind(cp, { conversation: false });
  expect(fs.existsSync(journal)).toBe(false);
});

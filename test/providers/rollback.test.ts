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
import { MAIN_CHAT } from "../../src/types.js";
import { makeProjectDir } from "../helpers.js";
import { callsOf, fakeClaude, fakeCodex, rpcOf, stdinOf, turnsOf } from "../native-fakes.js";

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
  return {
    messages: async () => stdinOf(bin).filter((m) => m.type === "user" && typeof m.uuid === "string" && !drop.includes(m.uuid as string))
      .flatMap((m) => [{ type: "user", uuid: m.uuid as string }, { type: "assistant", uuid: `reply-${m.uuid as string}` }]),
    fork: async (sessionId, _dir, upTo) => { forks.push({ sessionId, upTo }); return { sessionId: `fork-${forks.length}` }; },
  };
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
    await expect(agent.rollbackConversation((await agent.planRollback(MAIN_CHAT, cutoff))!)).rejects.toThrow(/isn't in claude's session history/);
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

async function gitRuntime(bin: string) {
  const dir = makeProjectDir({ agents: [{ id: "codex", kind: "codex", options: { bin } }] });
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

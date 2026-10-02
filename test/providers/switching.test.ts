/**
 * Phase 5 — switching provider within a chat, through the project runtime with
 * Brain continuity on, against the protocol fakes. Each agent gets what its
 * own session lacks; the one switched away from stays parked, warm; the packet
 * is sized by the target's context window; a usage limit offers the switch;
 * and a rewind's dropped turns are left out of what Brain sends.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ContinuityEngine, packetBudget } from "../../src/core/continuity/engine.js";
import * as checkpoints from "../../src/core/checkpoint.js";
import { EventLog } from "../../src/core/eventlog.js";
import { ProjectRuntime } from "../../src/daemon/runtime.js";
import { type HarnessMonitor } from "../../src/core/continuity/capabilities.js";
import { droppedHistory } from "../../src/core/continuity/store.js";
import { followRollback, type RuntimeTurns } from "../../src/daemon/runtime/turns.js";
import { PromptQueue } from "../../src/core/prompt-queue.js";
import type { RuntimeQueue } from "../../src/daemon/runtime/queue.js";
import { stopAllProviderSessions, type ProviderAgent } from "../../src/providers/agent.js";
import { makeProjectDir, waitUntil } from "../helpers.js";
import { callsOf, claudeInit, claudePromptOf, claudeResult, claudeText, codexDone, codexMessage, codexNotify, codexTokens, fakeClaude, fakeCodex, rpcOf, type Step } from "../native-fakes.js";

const open: Array<{ close: () => unknown }> = [];
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close(); await stopAllProviderSessions(); });
afterAll(async () => { await stopAllProviderSessions(); });

const started: Step = codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } });
const codexSays = (text: string, window = 272_000): Step[] => [started, codexMessage(text), codexTokens(1000, 0, 10, window), codexDone()];
const claudeSays = (text: string): Step[] => [claudeInit, claudeText(text), claudeResult()];
const codexPrompts = (bin: string) => rpcOf(bin, "turn/start").map((p) => (p.input as Array<{ text: string }>)[0]!.text);

async function project(options: { continuity?: boolean; git?: boolean; codex?: Step[]; claude?: Step[] } = {}) {
  const codex = fakeCodex({ script: options.codex ?? codexSays("Codex did it.") });
  const claude = fakeClaude({ script: options.claude ?? claudeSays("Claude did it.") });
  const dir = makeProjectDir({ brain: { continuity: options.continuity ?? true, extractor: "off" }, agents: [
    { id: "codex", kind: "codex", options: { bin: codex } }, { id: "claude", kind: "claude-code", options: { bin: claude } }] });
  if (options.git) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
    fs.writeFileSync(path.join(dir, "app.txt"), "v0\n");
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    git("add", "-A"); git("commit", "-qm", "seed");
  }
  const rt = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "switch", dir });
  open.push(rt);
  return { rt, dir, codex, claude };
}

/** Send in a chat and wait for the turn to settle (completed or failed). */
const ended = (rt: ProjectRuntime) => rt.log.list().filter((e) => (e.kind === "run_complete" || e.kind === "error") && e.agentId).length;
async function turn(rt: ProjectRuntime, text: string, chat: string) {
  const done = ended(rt);
  const result = await rt.sendMessage(text, undefined, { chat });
  await waitUntil(() => !rt.anyBusy() && ended(rt) > done && !rt.continuity?.store.activeReceipts().length);
  return result;
}

describe("switching provider within a chat", () => {
  it("routes a parked native message without leaking routing metadata into the journal", async () => {
    const { rt } = await project({ continuity: false });
    const a = rt.createChat("parked").id, b = rt.createChat("foreground").id;
    (rt as unknown as { turns: RuntimeTurns }).turns.turnChat.set("codex", b);
    const agent = rt.agent("codex") as unknown as { beginContinuity: (input: unknown) => void; endContinuity: () => void;
      ingestion: { ingest: (event: unknown) => void } };
    agent.beginContinuity({ continuity: { runId: "B", bindingId: "binding-B", sessionEpoch: 1 } });
    try {
      agent.ingestion.ingest({ eventId: "late", type: "item.completed", provider: "codex", instanceId: "codex", threadId: a,
        turnId: "turn-A", createdAt: Date.now(), payload: { itemType: "assistant_message", detail: "parked reply" } });
      const event = rt.log.list({ kinds: ["message"] }).at(-1)!;
      expect(event.chat).toBe(a);
      expect(event.payload).toEqual({ text: "parked reply" });
    } finally { agent.endContinuity(); }
  });

  it("brings each agent up to date on what it missed, and keeps the other one parked warm", async () => {
    const { rt, codex, claude } = await project({ codex: codexSays("BLUE is noted."), claude: claudeSays("Checked the parser.") });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "Remember the codeword BLUE.", chat);

    await rt.switchChat(chat, "claude");
    await turn(rt, "Check the parser.", chat);
    // Claude's session is new: it gets the chat so far, including Codex's work.
    const toClaude = claudePromptOf(claude);
    expect(toClaude).toContain("does not hold the earlier conversation");
    expect(toClaude).toContain("Remember the codeword BLUE.");
    expect(toClaude).toContain("BLUE is noted.");

    await rt.switchChat(chat, "codex");
    await turn(rt, "Carry on.", chat);
    // Codex's session was parked, not ended: the same app-server, and only what it missed.
    expect(callsOf(codex)).toHaveLength(1);
    const back = codexPrompts(codex).at(-1)!;
    expect(back).toContain("already holds this conversation");
    expect(back).toContain("Checked the parser.");
    expect(back).not.toContain("Remember the codeword BLUE.");
    expect(rt.log.list().filter((e) => e.payload.state === "chat_switched").map((e) => e.payload.to)).toEqual(["claude", "codex"]);
  });

  it("switches Main by moving the baton", async () => {
    const { rt, claude } = await project();
    await turn(rt, "Start here.", "main");
    const out = await rt.switchChat("main", "claude");
    expect(out.from).toBe("codex");
    await turn(rt, "Continue.", "main");
    expect(claudePromptOf(claude)).toContain("Start here.");
  });

  it("sizes the packet by the target's context window", async () => {
    expect(packetBudget("codex")).toBe(27_200);
    expect(packetBudget("claude-code")).toBe(20_000);
    expect(packetBudget("codex", 1_000_000)).toBe(40_000);
    expect(packetBudget("claude-code", 32_000)).toBe(6000);
    const { rt } = await project({ codex: codexSays("ok", 128_000) });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    // Before Codex reported a window, its provider's default; after, its own.
    const one = await turn(rt, "one", chat);
    const two = await turn(rt, "two", chat);
    const budget = (id?: string) => rt.continuity!.store.request(id!)!.targetAddedTokens;
    expect(budget(one.requestId)).toBe(27_200);
    expect(budget(two.requestId)).toBe(12_800);
    expect(rt.contextBudget("codex")).toBe(12_800);
    expect(rt.contextBudget("claude")).toBe(20_000);
  });
});

describe("a usage limit offers the switch", () => {
  const limited: Step[] = [started,
    codexNotify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      rateLimitReachedType: "primary" } }),
    codexDone("failed", "usage limit reached")];

  for (const continuity of [true, false]) {
    it(`names the agents on another provider, and switching resends the message${continuity ? " (continuity)" : ""}`, async () => {
      const { rt, claude } = await project({ continuity, codex: limited, claude: claudeSays("Took over.") });
      const chat = rt.createChat("work", { agentId: "codex" }).id;
      await turn(rt, "Refactor the parser.", chat);
      const offer = rt.log.list().find((e) => e.payload.state === "switch_suggested")!;
      expect(offer).toMatchObject({ agentId: "codex", chat, payload: { reason: "usage_limit", provider: "codex", limit: "primary",
        resetsAt: 1_900_000_000_000, alternatives: [{ agentId: "claude", kind: "claude-code" }] } });
      expect(rt.log.list().filter((e) => e.payload.state === "switch_suggested")).toHaveLength(1);

      const done = ended(rt);
      const out = await rt.switchChat(chat, "claude", { resend: true });
      expect(out.resent?.agentId).toBe("claude");
      await waitUntil(() => ended(rt) > done && !rt.anyBusy() && !rt.continuity?.store.activeReceipts().length);
      expect(claudePromptOf(claude)).toContain("Refactor the parser.");
      expect(rt.chatBinding(chat).agentId).toBe("claude");
    });
  }
});

describe("rewind with Brain continuity", () => {
  it("leaves the dropped turns out of what the next agent is told", async () => {
    const { rt, dir, claude } = await project({ git: true, codex: codexSays("Noted."), claude: claudeSays("Carrying on.") });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "The codeword is BLUE.", chat);
    await turn(rt, "Now the codeword is RED.", chat);
    fs.writeFileSync(path.join(dir, "app.txt"), "red work\n");
    const cp = String(rt.log.list().find((e) => e.kind === "checkpoint" && e.payload.label === "Now the codeword is RED.")!.payload.id);

    const out = await rt.rewind(cp);
    expect(out.conversation).toEqual([{ agentId: "codex", provider: "codex", turns: 1 }]);
    const rewound = rt.log.list().find((e) => e.payload.reason === "rewound")!;
    expect(rewound.payload.dropped).toMatchObject({ from: expect.any(Number) });

    await rt.switchChat(chat, "claude");
    await turn(rt, "Which codewords do you know?", chat);
    const toClaude = claudePromptOf(claude);
    expect(toClaude).toContain("The codeword is BLUE.");
    expect(toClaude).not.toContain("RED");
  });

  it("points Brain's binding at the session a rollback left", async () => {
    const dir = makeProjectDir();
    const log = await EventLog.open(path.join(dir, ".loom"));
    open.push(log);
    const brain = new ContinuityEngine(log, "project");
    const make = (session: string) => brain.store.binding(`slot-${session}`, () => ({ id: `b-${session}`, conversationId: "work", agentInstanceId: "claude",
      harnessKind: "claude-code", workspaceId: "a".repeat(64), compatibilityFingerprint: "b".repeat(64), nativeSessionId: session, sessionEpoch: 3, retention: "unknown" }));
    make("s1");
    // A new epoch either way: the old epoch's accepted packets no longer say what the session holds.
    followRollback(brain, "work", "claude", "fork-1", { workspaceId: "a".repeat(64), previousCursor: "s1" });
    expect(brain.store.bindingById("b-s1")).toMatchObject({ nativeSessionId: "fork-1", sessionEpoch: 4 });
    followRollback(brain, "work", "claude", null, { workspaceId: "a".repeat(64), previousCursor: "fork-1" });
    expect(brain.store.bindingById("b-s1")).toMatchObject({ nativeSessionId: null, sessionEpoch: 5 });
    // A binding with no session, or another agent's or chat's, is left alone.
    followRollback(brain, "work", "claude", null, { workspaceId: "a".repeat(64), previousCursor: "fork-1" });
    followRollback(brain, "other", "claude", null, { workspaceId: "a".repeat(64), previousCursor: "fork-1" });
    followRollback(brain, "work", "codex", null, { workspaceId: "a".repeat(64), previousCursor: "fork-1" });
    expect(brain.store.bindingById("b-s1")).toMatchObject({ sessionEpoch: 5 });
  });
});

// ---------------------------------------------------------------------------
// Fixes from Sol's audit
// ---------------------------------------------------------------------------

const checkpointOf = (rt: ProjectRuntime, label: string) =>
  String(rt.log.list().find((e) => e.kind === "checkpoint" && e.payload.reason === "before_turn" && e.payload.label === label)!.payload.id);

describe("audit fixes", () => {
  it("after rolling back a return turn, the next turn rebuilds what the rollback took away", async () => {
    const { rt, codex } = await project({ git: true, codex: codexSays("Codex noted."), claude: claudeSays("Claude checked the parser.") });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "one: start", chat);
    await rt.switchChat(chat, "claude");
    await turn(rt, "two: check the parser", chat);
    await rt.switchChat(chat, "codex");
    await turn(rt, "three: carry on", chat);
    // Codex learned about Claude's turn only in the turn being rewound.
    expect(codexPrompts(codex).at(-1)).toContain("two: check the parser");
    await rt.rewind(checkpointOf(rt, "three: carry on"));
    await turn(rt, "four: and now?", chat);
    const four = codexPrompts(codex).at(-1)!;
    expect(four).toContain("does not hold the earlier conversation");
    expect(four).toContain("two: check the parser");
    expect(four).toContain("Claude checked the parser.");
    expect(four).not.toContain("three: carry on");
  });

  it("stops a turn still being prepared, and one in a chat nobody is pinned to", async () => {
    const { rt, codex } = await project({ codex: [{ sleep: 3000 }, ...codexSays("late")] });
    const brain = rt.continuity!;
    const prepare = brain.prepare.bind(brain);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(brain, "prepare").mockImplementation(async (...args) => { await held; return prepare(...args); });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    const sending = rt.sendMessage("prepare me", undefined, { chat }).catch((e: Error) => e);
    await waitUntil(() => spy.mock.calls.length > 0);
    const switching = rt.switchChat(chat, "claude");
    release();
    await switching;
    await sending;
    expect(rpcOf(codex, "turn/start")).toHaveLength(0);
    expect(rt.chatBinding(chat).agentId).toBe("claude");
    spy.mockRestore();
  });

  it("interrupts the agent answering in an unpinned chat", async () => {
    const { rt, codex } = await project({ continuity: false, codex: [started, { sleep: 5000 }, ...codexSays("late")] });
    const chat = rt.createChat("loose").id;
    await rt.sendMessage("take a while", "codex", { chat });
    await waitUntil(() => rpcOf(codex, "turn/start").length > 0);
    const out = await rt.switchChat(chat, "claude");
    expect(out.from).toBe("codex");
    expect(rpcOf(codex, "turn/interrupt")).toHaveLength(1);
    expect(rt.anyBusy()).toBe(false);
  });

  it("resends the last message still in the conversation, not one a rewind dropped", async () => {
    const { rt, claude } = await project({ continuity: false, git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "first request", chat);
    await turn(rt, "second request", chat);
    await rt.rewind(checkpointOf(rt, "second request"));
    const done = ended(rt);
    await rt.switchChat(chat, "claude", { resend: true });
    await waitUntil(() => ended(rt) > done && !rt.anyBusy());
    expect(claudePromptOf(claude)).toContain("first request");
    expect(claudePromptOf(claude)).not.toContain("second request");
  });

  it("with continuity, refuses to switch over queued requests for another agent", async () => {
    const { rt } = await project({ codex: [{ sleep: 1500 }, ...codexSays("slow")] });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await rt.sendMessage("running", undefined, { chat });
    const queued = await rt.sendMessage("queued behind it", undefined, { chat });
    expect(queued.queued).toBe(1);
    await expect(rt.switchChat(chat, "claude", { resend: true })).rejects.toThrow(/1 queued message/);
    expect(rt.chatBinding(chat).agentId).toBe("codex");
  });

  it("without continuity, queued messages follow the chat to its new agent", async () => {
    const { rt, claude } = await project({ continuity: false, codex: [started, { sleep: 5000 }, ...codexSays("slow")], claude: claudeSays("Claude has it.") });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await rt.sendMessage("running", undefined, { chat });
    await rt.sendMessage("queued behind it", undefined, { chat });
    const out = await rt.switchChat(chat, "claude");
    expect(out.requeued).toBe(1);
    await waitUntil(() => claudePromptOf(claude).includes("queued behind it"));
  });

  it("retires reviewed context that rests on a dropped turn", async () => {
    const { rt, claude } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "The codeword is BLUE.", chat);
    await turn(rt, "Decision: use RED from now on.", chat);
    const brain = rt.continuity!;
    const red = rt.log.list({ chat }).find((e) => e.kind === "message" && e.payload.text === "Decision: use RED from now on.")!;
    brain.putItem({ id: "use-red", revision: 1, conversationId: chat, kind: "decision", text: "Use RED.", origin: "user", status: "accepted",
      sources: [brain.store.source(red, rt.info.id)], supersedes: null });
    await rt.rewind(checkpointOf(rt, "Decision: use RED from now on."));
    expect(brain.store.items(chat).find((i) => i.id === "use-red")).toMatchObject({ status: "superseded", revision: 2 });
    expect(rt.log.list().some((e) => e.payload.state === "brain_items_retired")).toBe(true);
    await rt.switchChat(chat, "claude");
    await turn(rt, "Which codeword?", chat);
    expect(claudePromptOf(claude)).toContain("The codeword is BLUE.");
    expect(claudePromptOf(claude)).not.toContain("RED");
  });

  it("offers a switch once per limit per turn, however the reports alternate", async () => {
    const limit = (reached: string): Step => codexNotify("account/rateLimits/updated", { rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: { usedPercent: 100, windowDurationMins: 10080 }, rateLimitReachedType: reached } });
    const { rt } = await project({ continuity: false, codex: [started, limit("rate_limit_reached"), limit("workspace_member_credits_depleted"), limit("rate_limit_reached"), limit("workspace_member_credits_depleted"), codexDone("failed", "limit")] });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "go", chat);
    const offers = rt.log.list().filter((e) => e.payload.state === "switch_suggested").map((e) => e.payload.limit);
    expect(offers).toEqual(["rate_limit_reached", "workspace_member_credits_depleted"]);
  });
});


/** Gates expose the await boundaries without relying on native process timing. */
const gate = () => { let release!: () => void; const held = new Promise<void>(r => { release = r; }); return { held, release }; };
const internals = (rt: ProjectRuntime) => rt as unknown as { turns: RuntimeTurns; harnesses: HarnessMonitor; queueCoordinator: RuntimeQueue };

describe("Phase 5 regression fixes", () => {
  it("rewinding queued B preserves A's later answer and still-queued C", async () => {
    const { rt, codex, claude } = await project({ git: true, codex: [started, { sleep: 500 }, codexMessage("A's answer survives."), codexDone()] });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await rt.sendMessage("A", undefined, { chat });
    const b = await rt.sendMessage("B", undefined, { chat });
    rt.queue.setPaused(true);
    await waitUntil(() => !rt.anyBusy() && !rt.continuity!.store.activeReceipts().length);
    const answer = rt.log.list({ chat }).find(e => e.agentId === "codex" && e.payload.text === "A's answer survives.")!;
    const brain = rt.continuity!;
    expect(brain.store.requestEvent(b.requestId!)!.id).toBeLessThan(answer.id);
    rt.queue.setPaused(false);
    await rt.drainPromptQueue();
    await waitUntil(() => rpcOf(codex, "turn/start").length === 2);
    const c = await rt.sendMessage("C", undefined, { chat });
    rt.queue.setPaused(true);
    await waitUntil(() => !rt.anyBusy() && !brain.store.activeReceipts().length);
    const before = rt.log.list({ chat }).find(e => e.payload.reason === "before_turn" && e.payload.label === "B")!;
    await rt.rewind(String(before.payload.id));
    const rewound = rt.log.list({ chat }).find(e => e.payload.reason === "rewound")!;
    const cEvent = brain.store.requestEvent(c.requestId!)!.id;
    expect(rewound.payload.dropped).toEqual({ from: before.id, turns: [brain.store.requestEvent(b.requestId!)!.id], keep: [cEvent] });
    expect(brain.store.isDropped(chat, answer.id)).toBe(false);
    expect(brain.store.isDropped(chat, cEvent)).toBe(false);
    expect(brain.store.isDropped(chat, brain.store.requestEvent(b.requestId!)!.id)).toBe(true);
    expect(brain.store.observations(chat, 0, rewound.id, 100).map(e => e.id)).toContain(answer.id);
    rt.queue.remove(c.queueId!);
    await rt.switchChat(chat, "claude");
    await turn(rt, "What survived?", chat);
    expect(claudePromptOf(claude)).toContain("A's answer survives.");
    expect(brain.store.protectedEvents(chat, rt.log.list().at(-1)!.id).map(e => e.id)).not.toContain(brain.store.requestEvent(b.requestId!)!.id);
  });

  it("rewinding B also drops C, queued before B's checkpoint but run after it", async () => {
    const { rt } = await project({ git: true, codex: [started, { sleep: 500 }, codexMessage("A's answer survives."), codexDone()] });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await rt.sendMessage("A", undefined, { chat });
    const b = await rt.sendMessage("B", undefined, { chat });
    const c = await rt.sendMessage("C", undefined, { chat });
    const brain = rt.continuity!;
    await waitUntil(() => !rt.anyBusy() && !rt.queue.length && !brain.store.activeReceipts().length, 10_000);
    const before = rt.log.list({ chat }).find(e => e.payload.reason === "before_turn" && e.payload.label === "B")!;
    await rt.rewind(String(before.payload.id));
    const cEvent = brain.store.requestEvent(c.requestId!)!.id;
    expect(cEvent).toBeLessThan(before.id);
    expect(brain.store.isDropped(chat, brain.store.requestEvent(b.requestId!)!.id)).toBe(true);
    expect(brain.store.isDropped(chat, cEvent)).toBe(true);
    const answer = rt.log.list({ chat }).find(e => e.agentId === "codex" && e.payload.text === "A's answer survives.")!;
    expect(brain.store.isDropped(chat, answer.id)).toBe(false);
  });

  it("keeps old rewind ranges and drops the turn even if it is listed in keep", async () => {
    const dir = makeProjectDir();
    const log = await EventLog.open(path.join(dir, ".loom")); open.push(log);
    const brain = new ContinuityEngine(log, "project");
    const message = (text: string) => log.append({ kind: "message", chat: "work", payload: { text, author: "user" } });
    const old = message("old");
    const oldRewind = log.append({ kind: "checkpoint", payload: { chat: "work", reason: "rewound", dropped: { from: old.id } } });
    const turn = message("turn"), keep = message("keep"), drop = message("drop");
    const rewind = log.append({ kind: "checkpoint", payload: { chat: "work", reason: "rewound", dropped: { from: keep.id, turns: [turn.id], keep: [keep.id, turn.id] } } });
    const history = droppedHistory(log.list(), "work");
    expect(history.isDropped(old.id)).toBe(true);
    expect(history.isDropped(oldRewind.id)).toBe(false);
    expect(history.isDropped(turn.id)).toBe(true);
    expect(history.isDropped(keep.id)).toBe(false);
    expect(history.isDropped(drop.id)).toBe(true);
    expect(history.isDropped(rewind.id)).toBe(false);
    expect(brain.store.protectedEvents("work", rewind.id).map(e => e.id)).toEqual([keep.id]);
    expect(brain.store.hasNewUserSources("work", keep.id)).toBe(false);
  });

  for (const continuity of [true, false]) {
    it(`refuses sends and enqueues during a switch (continuity=${continuity})`, async () => {
      const { rt } = await project({ continuity });
      const chat = rt.createChat("work", { agentId: "codex" }).id;
      const hold = gate();
      const spy = vi.spyOn(internals(rt).turns, "stopChat").mockImplementation(async () => { await hold.held; return []; });
      try {
        const switching = rt.switchChat(chat, "claude");
        await expect(rt.sendMessage("too early", undefined, { chat })).rejects.toMatchObject({ code: "conflict" });
        expect(() => rt.enqueue({ text: "also too early", chat })).toThrow(/switching/);
        expect(rt.queue.length).toBe(0);
        expect(rt.log.list({ chat }).some(e => e.payload.text === "too early")).toBe(false);
        hold.release(); await switching;
      } finally { hold.release(); spy.mockRestore(); }
    });
  }

  it("re-resolves a send whose harness await straddles a switch", async () => {
    const { rt, codex, claude } = await project();
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    const harnesses = internals(rt).harnesses, ensure = harnesses.ensure.bind(harnesses), hold = gate();
    const spy = vi.spyOn(harnesses, "ensure").mockImplementationOnce(async id => { await hold.held; return ensure(id); });
    try {
      const sending = rt.sendMessage("follow the chat", undefined, { chat });
      await waitUntil(() => spy.mock.calls.length > 0);
      await rt.switchChat(chat, "claude");
      hold.release();
      const sent = await sending;
      expect(sent.agentId).toBe("claude");
      expect(spy.mock.calls.map(args => args[0])).toEqual(["codex", "claude"]);
      await waitUntil(() => !rt.anyBusy() && !rt.continuity!.store.activeReceipts().length);
      expect(rpcOf(codex, "turn/start")).toHaveLength(0);
      expect(claudePromptOf(claude)).toContain("follow the chat");
      expect(rt.continuity!.store.request(sent.requestId!)!.agentInstanceId).toBe("claude");
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("leaves a user pause made during a switch intact", async () => {
    const { rt } = await project({ continuity: false });
    const chat = rt.createChat("work", { agentId: "codex" }).id, hold = gate();
    const spy = vi.spyOn(internals(rt).turns, "stopChat").mockImplementation(async () => { await hold.held; return []; });
    try {
      const switching = rt.switchChat(chat, "claude");
      rt.queue.setPaused(true, "user pause");
      hold.release(); await switching;
      expect(rt.queue.snapshot()).toMatchObject({ paused: true, reason: "user pause" });
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("overlapping switches hold the queue until both finish", async () => {
    const { rt } = await project({ continuity: false });
    const a = rt.createChat("a").id, b = rt.createChat("b").id, first = gate(), second = gate();
    const stop = vi.spyOn(internals(rt).turns, "stopChat").mockImplementation(async chat => { await (chat === a ? first : second).held; return []; });
    const send = vi.spyOn(rt, "sendMessage").mockResolvedValue({ agentId: "codex" });
    try {
      const one = rt.switchChat(a, "claude"), two = rt.switchChat(b, "claude");
      await expect(rt.switchChat(a, "codex")).rejects.toThrow(/already switching/);
      rt.queue.add({ text: "wait for both", target: { kind: "agent", agentId: "codex" } });
      await rt.drainPromptQueue(); expect(rt.queue.length).toBe(1);
      first.release(); await one;
      await rt.drainPromptQueue(); expect(rt.queue.length).toBe(1);
      expect(send).not.toHaveBeenCalled();
      second.release(); await two;
      await waitUntil(() => rt.queue.length === 0);
      expect(send).toHaveBeenCalledTimes(1);
      expect(rt.queue.paused).toBe(false);
    } finally { first.release(); second.release(); stop.mockRestore(); send.mockRestore(); }
  });

  it("in an unpinned chat only inferred queued targets follow the switch", async () => {
    const { rt } = await project({ continuity: false, codex: [started, { sleep: 5000 }, codexDone()] });
    const chat = rt.createChat("loose").id;
    await rt.sendMessage("running", "codex", { chat });
    const inferred = await rt.sendMessage("inferred", undefined, { chat });
    const explicit = await rt.sendMessage("explicit", "codex", { chat });
    const auto = rt.enqueue({ text: "auto", chat });
    rt.queue.setPaused(true);
    const out = await rt.switchChat(chat, "claude");
    expect(out).toMatchObject({ from: "codex", requeued: 2 });
    const items = rt.queue.snapshot().items;
    expect(items.find(i => i.id === inferred.queueId)).toMatchObject({ followsChat: true, target: { kind: "agent", agentId: "claude" } });
    expect(items.find(i => i.id === auto.id)).toMatchObject({ followsChat: true, target: { kind: "agent", agentId: "claude" } });
    expect(items.find(i => i.id === explicit.queueId)).toMatchObject({ target: { kind: "agent", agentId: "codex" } });
    expect(items.find(i => i.id === explicit.queueId)?.followsChat).toBeUndefined();
  });
});


describe("round 3 regressions", () => {
  it("refuses a switch while a dequeued request awaits harness discovery", async () => {
    const { rt } = await project();
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    rt.queue.setPaused(true);
    rt.enqueue({ text: "dispatch me", chat });
    const harnesses = internals(rt).harnesses, ensure = harnesses.ensure.bind(harnesses), hold = gate();
    const harness = vi.spyOn(harnesses, "ensure").mockImplementationOnce(async id => { await hold.held; return ensure(id); });
    const send = vi.spyOn(rt, "sendMessage");
    try {
      rt.queue.setPaused(false);
      const draining = rt.drainPromptQueue();
      await waitUntil(() => harness.mock.calls.length > 0);
      expect(rt.queue.length).toBe(0);
      expect(rt.anyBusy()).toBe(false);
      await expect(rt.switchChat(chat, "claude")).rejects.toThrow(/still dispatching/);
      expect(rt.chatBinding(chat).agentId).toBe("codex");
      expect(send.mock.calls[0]![2]).toMatchObject({ followsChat: true });
      hold.release(); await draining;
      await waitUntil(() => !rt.anyBusy() && !rt.continuity!.store.activeReceipts().length);
      expect(internals(rt).queueCoordinator.dispatching.size).toBe(0);
      await rt.switchChat(chat, "claude");
    } finally { hold.release(); harness.mockRestore(); send.mockRestore(); }
  });

  it("carries inferred provenance into the generation recheck", async () => {
    const { rt, codex, claude } = await project();
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    const harnesses = internals(rt).harnesses, ensure = harnesses.ensure.bind(harnesses), hold = gate();
    const spy = vi.spyOn(harnesses, "ensure").mockImplementationOnce(async id => { await hold.held; return ensure(id); });
    try {
      const sending = rt.sendMessage("inferred despite resolved id", "codex", { chat, followsChat: true });
      await waitUntil(() => spy.mock.calls.length > 0);
      await rt.switchChat(chat, "claude");
      hold.release();
      expect((await sending).agentId).toBe("claude");
      await waitUntil(() => !rt.anyBusy() && !rt.continuity!.store.activeReceipts().length);
      expect(rpcOf(codex, "turn/start")).toHaveLength(0);
      expect(claudePromptOf(claude)).toContain("inferred despite resolved id");
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("keeps an unsent request requeued after its before-turn checkpoint", async () => {
    const { rt, claude } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "A", chat);
    rt.queue.setPaused(true);
    const b = rt.enqueue({ text: "B's kept intent", chat });
    const brain = rt.continuity!, spy = vi.spyOn(brain, "prepare").mockRejectedValueOnce(new Error("prelaunch failure"));
    try {
      rt.queue.setPaused(false); await rt.drainPromptQueue();
      expect(rt.queue.peek()?.id).toBe(b.id);
      expect(rt.queue.paused).toBe(true);
      expect(rt.log.list().some(e => e.payload.reason === "before_turn" && e.payload.label === "B's kept intent")).toBe(true);
    } finally { spy.mockRestore(); }
    await rt.rewind(checkpointOf(rt, "A"));
    const id = brain.store.requestEvent(b.continuity!.requestId)!.id;
    const dropped = rt.log.list().find(e => e.payload.reason === "rewound")!.payload.dropped as { turns: number[]; keep: number[] };
    expect(dropped.keep).toContain(id);
    expect(dropped.turns).not.toContain(id);
    expect(brain.store.isDropped(chat, id)).toBe(false);
    rt.queue.setPaused(false); await rt.drainPromptQueue();
    await waitUntil(() => !rt.anyBusy() && !brain.store.activeReceipts().length);
    expect(brain.store.protectedEvents(chat, rt.log.lastId()).map(e => e.id)).toContain(id);
    await rt.switchChat(chat, "claude");
    await turn(rt, "What was kept?", chat);
    expect(claudePromptOf(claude)).toContain("B's kept intent");
  });

  it("a failed native rollback preserves its cursor until retry then reconstructs", async () => {
    const { rt, codex } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "Keep BLUE.", chat);
    await turn(rt, "Use RED instead.", chat);
    const brain = rt.continuity!, agent = rt.agent("codex") as ProviderAgent;
    const before = brain.store.bindingsFor(chat, "codex")[0]!, starts = rpcOf(codex, "thread/start").length;
    const spy = vi.spyOn(agent, "rollbackConversation").mockRejectedValueOnce(new Error("native rollback failed"));
    try {
      const out = await rt.rewind(checkpointOf(rt, "Use RED instead."));
      expect(out.conversation[0]).toMatchObject({ turns: 0, error: "native rollback failed" });
      expect(brain.store.bindingById(before.id)).toMatchObject({ nativeSessionId: before.nativeSessionId, sessionEpoch: before.sessionEpoch });
    } finally { spy.mockRestore(); }
    await expect(rt.sendMessage("blocked until retry", "codex", { chat })).rejects.toThrow(/rewinding|interrupted rewind/);
    await rt.rewind(checkpointOf(rt, "Use RED instead."));
    const next = await turn(rt, "Which color?", chat);
    expect(brain.store.packet(next.packetId!)!.packet.mode).toBe("reconstruction");
    expect(rpcOf(codex, "thread/start")).toHaveLength(starts);
    expect(agent.sessionCursor(chat)).toBe(before.nativeSessionId);
    expect(codexPrompts(codex).at(-1)).toContain("Keep BLUE.");
    expect(codexPrompts(codex).at(-1)).not.toContain("Use RED instead.");
  });

  it("explicit queue edits stop following, while internal switches preserve inference on reload", async () => {
    const { rt, dir } = await project({ continuity: false });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    rt.queue.setPaused(true);
    const explicit = rt.enqueue({ text: "explicit", chat }), orchestra = rt.enqueue({ text: "orchestra", chat });
    const auto = rt.enqueue({ text: "auto", chat, target: { kind: "agent", agentId: "codex" } });
    const inferred = rt.enqueue({ text: "inferred", chat });
    rt.editQueued(explicit.id, { target: { kind: "agent", agentId: "codex" } });
    rt.editQueued(orchestra.id, { target: { kind: "orchestra" } });
    rt.editQueued(auto.id, { target: { kind: "auto" } });
    expect(rt.queue.snapshot().items.filter(i => i.followsChat).map(i => i.id)).toEqual([auto.id, inferred.id]);
    expect((await rt.switchChat(chat, "claude")).requeued).toBe(2);
    const reloaded = new PromptQueue(path.join(dir, ".loom", "queue.json"));
    expect(reloaded.snapshot().items.find(i => i.id === inferred.id)).toMatchObject({ followsChat: true, target: { kind: "agent", agentId: "claude" } });
    expect(reloaded.snapshot().items.find(i => i.id === explicit.id)?.followsChat).toBeUndefined();
    expect((await rt.switchChat(chat, "codex")).requeued).toBe(2);
    expect(rt.queue.snapshot().items.find(i => i.id === orchestra.id)?.target.kind).toBe("orchestra");
  });

  it("re-reads surviving queue entries and honors edits made during a switch", async () => {
    const { rt } = await project({ continuity: false });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    rt.queue.setPaused(true);
    const removed = rt.enqueue({ text: "remove", chat }), edited = rt.enqueue({ text: "edit", chat }), kept = rt.enqueue({ text: "keep", chat });
    const hold = gate(), spy = vi.spyOn(internals(rt).turns, "stopChat").mockImplementation(async () => { await hold.held; return []; });
    try {
      const switching = rt.switchChat(chat, "claude");
      rt.queue.remove(removed.id);
      rt.editQueued(edited.id, { target: { kind: "agent", agentId: "codex" } });
      hold.release();
      expect(await switching).toMatchObject({ requeued: 1 });
      expect(rt.chatBinding(chat).agentId).toBe("claude");
      expect(rt.queue.snapshot().items.find(i => i.id === edited.id)?.target).toEqual({ kind: "agent", agentId: "codex" });
      expect(rt.queue.snapshot().items.find(i => i.id === kept.id)).toMatchObject({ followsChat: true, target: { kind: "agent", agentId: "claude" } });
      expect(rt.log.list().some(e => e.payload.state === "chat_switched")).toBe(true);
      expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("refuses routes and orchestra starts before side effects while their chat switches", async () => {
    const { rt } = await project({ continuity: false });
    const chat = rt.createChat("work", { agentId: "codex" }).id, hold = gate();
    const stop = vi.spyOn(internals(rt).turns, "stopChat").mockImplementation(async () => { await hold.held; return []; });
    const snapshot = vi.spyOn(rt as unknown as { snapshotBeforeRoute: () => void }, "snapshotBeforeRoute");
    const handoff = vi.spyOn(rt, "handoff");
    const gateSpy = vi.spyOn((rt.orchestra as unknown as { host: { gate: (agentId: string) => void } }).host, "gate");
    try {
      const work = rt.switchChat(chat, "claude"), main = rt.switchChat("main", "claude");
      await expect(rt.startRoute({ task: "static", spec: ["codex"] })).rejects.toMatchObject({ code: "conflict" });
      await expect(rt.startRoute({ task: "dynamic", spec: "auto" })).rejects.toMatchObject({ code: "conflict" });
      expect(snapshot).not.toHaveBeenCalled();
      await expect(rt.handoff("codex", { source: "route" })).rejects.toMatchObject({ code: "conflict" });
      for (const where of [chat, "main", undefined])
        await expect(rt.orchestra.start({ goal: "don't start", ...(where ? { chat: where } : {}) })).rejects.toMatchObject({ code: "conflict" });
      expect(gateSpy).not.toHaveBeenCalled();
      handoff.mockResolvedValue({ from: null });
      hold.release(); await Promise.all([work, main]);
      expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); stop.mockRestore(); snapshot.mockRestore(); handoff.mockRestore(); gateSpy.mockRestore(); }
  });
});


describe("round 4 regressions", () => {
  it("refuses rewind while a shifted request awaits harness discovery", async () => {
    const { rt } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "A", chat);
    rt.queue.setPaused(true);
    const b = rt.enqueue({ text: "B", chat });
    const harnesses = internals(rt).harnesses, ensure = harnesses.ensure.bind(harnesses), hold = gate();
    const spy = vi.spyOn(harnesses, "ensure").mockImplementationOnce(async id => { await hold.held; return ensure(id); });
    try {
      rt.queue.setPaused(false);
      const draining = rt.drainPromptQueue();
      await waitUntil(() => spy.mock.calls.length > 0);
      await expect(rt.rewind(checkpointOf(rt, "A"))).rejects.toMatchObject({ code: "conflict" });
      expect(rt.log.list().some(e => e.payload.reason === "rewound")).toBe(false);
      expect(rt.continuity!.store.isDropped(chat, rt.continuity!.store.requestEvent(b.continuity!.requestId)!.id)).toBe(false);
      hold.release(); await draining;
      await waitUntil(() => !rt.anyBusy() && !rt.continuity!.store.activeReceipts().length);
      expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("holds drains and refuses chat sends throughout native rollback", async () => {
    const { rt } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "A", chat);
    const agent = rt.agent("codex") as ProviderAgent, rollback = agent.rollbackConversation.bind(agent), hold = gate();
    const spy = vi.spyOn(agent, "rollbackConversation").mockImplementationOnce(async step => { await hold.held; return rollback(step); });
    try {
      const rewinding = rt.rewind(checkpointOf(rt, "A"));
      await waitUntil(() => spy.mock.calls.length > 0);
      await expect(rt.sendMessage("too early", undefined, { chat })).rejects.toMatchObject({ code: "conflict" });
      expect(() => rt.enqueue({ text: "too early", chat })).toThrow(/switching/);
      rt.queue.add({ text: "wait", chat, target: { kind: "agent", agentId: "codex" } });
      await rt.drainPromptQueue();
      expect(rt.queue.length).toBe(1);
      expect(internals(rt).queueCoordinator.holds).toBe(1);
      rt.queue.setPaused(true, "user pause");
      hold.release(); await rewinding;
      expect(internals(rt).queueCoordinator.holds).toBe(0);
      expect(rt.queue.snapshot()).toMatchObject({ paused: true, reason: "user pause" });
      await expect(rt.rewind("missing-checkpoint")).rejects.toThrow();
      expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("keeps the undo checkpoint's chat guarded during file restore", async () => {
    const { rt } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "A", chat);
    const out = await rt.rewind(checkpointOf(rt, "A")), hold = gate(), restore = checkpoints.restore;
    const spy = vi.spyOn(checkpoints, "restore").mockImplementationOnce(async (...args) => { await hold.held; return restore(...args); });
    try {
      const undoing = rt.rewind(out.undo.id);
      await waitUntil(() => spy.mock.calls.length > 0);
      await expect(rt.sendMessage("too early", undefined, { chat })).rejects.toMatchObject({ code: "conflict" });
      expect(internals(rt).queueCoordinator.holds).toBe(1);
      hold.release(); await undoing;
      expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("refuses rewind while a turn is preparing", async () => {
    const { rt } = await project({ git: true });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    await turn(rt, "A", chat);
    const brain = rt.continuity!, prepare = brain.prepare.bind(brain), hold = gate();
    const spy = vi.spyOn(brain, "prepare").mockImplementationOnce(async (...args) => { await hold.held; return prepare(...args); });
    try {
      const sending = rt.sendMessage("preparing", undefined, { chat });
      await waitUntil(() => spy.mock.calls.length > 0);
      await expect(rt.rewind(checkpointOf(rt, "A"))).rejects.toMatchObject({ code: "conflict" });
      hold.release(); await sending;
      await waitUntil(() => !rt.anyBusy() && !brain.store.activeReceipts().length);
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("drops a later queued turn even when its file capture fails", async () => {
    const { rt, claude } = await project({ git: true, codex: [started, { sleep: 500 }, codexMessage("answer"), codexDone()] });
    const chat = rt.createChat("work", { agentId: "codex" }).id;
    const capture = checkpoints.capture, spy = vi.spyOn(checkpoints, "capture").mockImplementation(async (dir, label, opts) => {
      if (label === "C without files") throw new Error("capture failed");
      return capture(dir, label, opts);
    });
    try {
      await rt.sendMessage("A", undefined, { chat });
      const b = await rt.sendMessage("B", undefined, { chat });
      const c = await rt.sendMessage("C without files", undefined, { chat });
      const brain = rt.continuity!;
      await waitUntil(() => !rt.anyBusy() && !rt.queue.length && !brain.store.activeReceipts().length, 10_000);
      const marker = rt.log.list({ chat }).find(e => e.payload.state === "turn_association")!;
      expect(marker).toMatchObject({ kind: "status", payload: { turnEvent: brain.store.requestEvent(c.requestId!)!.id, chat } });
      expect(marker.payload.id).toBeUndefined();
      expect((await rt.checkpoints()).some(cp => cp.label === "C without files")).toBe(false);
      expect(brain.store.requestEvent(c.requestId!)!.id).toBeLessThan(Number(rt.log.list().find(e => e.payload.id === checkpointOf(rt, "B"))!.id));
      await rt.rewind(checkpointOf(rt, "B"));
      expect(brain.store.isDropped(chat, brain.store.requestEvent(b.requestId!)!.id)).toBe(true);
      expect(brain.store.isDropped(chat, brain.store.requestEvent(c.requestId!)!.id)).toBe(true);
      await rt.switchChat(chat, "claude");
      await turn(rt, "what survives?", chat);
      expect(claudePromptOf(claude)).not.toContain("C without files");
    } finally { spy.mockRestore(); }
  });

  it("an admitted route handoff cannot undo a switch or send an aborted step", async () => {
    const { rt, codex } = await project({ continuity: false });
    const briefings = (rt as unknown as { briefings: { prepareHandoff: (...args: unknown[]) => Promise<unknown> } }).briefings;
    const hold = gate();
    const spy = vi.spyOn(briefings, "prepareHandoff").mockImplementation(async to => {
      if (to === "codex") await hold.held;
      return { memory: "", briefing: "", mode: "template", elapsedMs: 0, bridges: [] };
    });
    try {
      const starting = rt.startRoute({ task: "stale route", spec: ["codex"] });
      await waitUntil(() => spy.mock.calls.some(args => args[0] === "codex"));
      await rt.switchChat("main", "claude");
      expect(rt.routeState()?.status).toBe("aborted");
      hold.release(); await starting;
      expect((await rt.status()).holder).toBe("claude");
      expect(rt.routeState()?.status).toBe("aborted");
      expect(rpcOf(codex, "turn/start")).toHaveLength(0);
    } finally { hold.release(); spy.mockRestore(); }
  });

  it("releases dispatch state and restores the head when shift notification throws", async () => {
    const { rt } = await project({ continuity: false });
    rt.queue.setPaused(true);
    const item = rt.enqueue({ text: "keep me", target: { kind: "agent", agentId: "codex" } });
    rt.queue.setPaused(false);
    let fail = true;
    const unsubscribe = rt.onQueueChange(() => { if (fail) { fail = false; throw new Error("listener failed"); } });
    try {
      await rt.drainPromptQueue();
      expect(rt.queue.peek()?.id).toBe(item.id);
      expect(rt.queue.paused).toBe(true);
      expect(internals(rt).queueCoordinator.dispatching.size).toBe(0);
      expect(internals(rt).queueCoordinator.draining).toBe(false);
      await expect(rt.switchChat("main", "claude")).resolves.toMatchObject({ from: null });
    } finally { unsubscribe(); }
  });
});

describe("wide audit runtime regressions", () => {
  it("refuses other-chat sends and enqueues throughout a project rewind (#6)", async () => {
    const { rt } = await project({ git: true });
    const a = rt.createChat("a", { agentId: "codex" }).id, b = rt.createChat("b", { agentId: "claude" }).id;
    await turn(rt, "A", a);
    const hold = gate(), agent = rt.agent("codex") as ProviderAgent;
    const plan = vi.spyOn(agent, "planRollback").mockImplementation(async () => { await hold.held; return null; });
    try {
      const restoring = rt.rewind(checkpointOf(rt, "A"));
      await waitUntil(() => plan.mock.calls.length > 0);
      await expect(rt.sendMessage("B", undefined, { chat: b })).rejects.toMatchObject({ code: "conflict" });
      expect(() => rt.enqueue({ text: "B", chat: b })).toThrow(/rewinding/);
      await expect(rt.compactAgent("claude", b)).rejects.toMatchObject({ code: "conflict" });
      hold.release(); await restoring;
      expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); plan.mockRestore(); }
  });
  it("single-file rewind rejects pending dispatch and holds all chats during restore (#6)", async () => {
    const { rt } = await project({ git: true }); await turn(rt, "A", "main");
    const cp = checkpointOf(rt, "A"), dispatching = internals(rt).queueCoordinator.dispatching;
    dispatching.add("other");
    await expect(rt.rewindFile(cp, "app.txt")).rejects.toMatchObject({ code: "conflict" }); dispatching.clear();
    const hold = gate(), original = checkpoints.restoreFile;
    const restore = vi.spyOn(checkpoints, "restoreFile").mockImplementation(async (...args) => { await hold.held; return original(...args); });
    try {
      const restoring = rt.rewindFile(cp, "app.txt");
      await waitUntil(() => restore.mock.calls.length > 0);
      await expect(rt.sendMessage("wait", "claude")).rejects.toMatchObject({ code: "conflict" });
      expect(internals(rt).queueCoordinator.holds).toBe(1);
      hold.release(); await restoring; expect(internals(rt).queueCoordinator.holds).toBe(0);
    } finally { hold.release(); restore.mockRestore(); }
  });
  it("keeps the legacy next prompt queued until command settlement (#8)", async () => {
    const command = (method: string, status: string) => codexNotify(method, { item: { id: "cmd", type: "commandExecution", status, command: "test", exitCode: 0 } });
    const { rt, codex } = await project({ continuity: false, codex: [started, { sleep: 100 }, command("item/started", "inProgress"), codexDone(), { sleep: 150 }, command("item/completed", "completed")] });
    await rt.sendMessage("A", "codex"); const queued = await rt.sendMessage("B", "codex");
    expect(queued.queueId).toBeTruthy();
    await waitUntil(() => rt.log.list().some(e => e.kind === "run_complete"));
    expect(rt.queue.length).toBe(1);
    await waitUntil(() => rpcOf(codex, "turn/start").length === 2 && !rt.anyBusy());
    expect(rt.log.list().some(e => e.kind === "error" && /is busy/.test(String(e.payload.message)))).toBe(false);
  });
  it("keeps structured answers in a new provider's reconstruction (#10)", async () => {
    const { rt, claude } = await project({ codex: [started, { ask: "item/tool/requestUserInput", params: { questions: [{ id: "color", question: "Which color?", options: [] }] } }, codexMessage("Noted."), codexDone()] });
    const chat = rt.createChat("answers", { agentId: "codex" }).id;
    await rt.sendMessage("choose", undefined, { chat });
    await waitUntil(() => rt.log.list({ chat }).some(e => e.kind === "needs_input"));
    const q = rt.log.list({ chat }).find(e => e.kind === "needs_input")!;
    await rt.answerQuestion("codex", chat, String(q.payload.requestId), { color: "SECRET-BLUE" });
    await waitUntil(() => !rt.anyBusy() && !rt.continuity!.store.activeReceipts().length);
    await rt.switchChat(chat, "claude"); await turn(rt, "continue", chat);
    expect(claudePromptOf(claude)).toContain("SECRET-BLUE");
  });
  it("an older manual handoff cannot undo a completed switch (#17)", async () => {
    const { rt } = await project({ continuity: false }), hold = gate();
    const briefings = (rt as unknown as { briefings: { prepareHandoff: (...args: unknown[]) => Promise<unknown> } }).briefings;
    const preparing = vi.spyOn(briefings, "prepareHandoff").mockImplementation(async to => {
      if (to === "codex") await hold.held;
      return { memory: "", briefing: "", mode: "template", elapsedMs: 0, bridges: [] };
    });
    try {
      const old = rt.handoff("codex"), outcome = old.catch(error => error);
      await waitUntil(() => preparing.mock.calls.some(args => args[0] === "codex"));
      await rt.switchChat("main", "claude"); hold.release();
      expect(await outcome).toMatchObject({ code: "conflict" }); expect((await rt.status()).holder).toBe("claude");
    } finally { hold.release(); preparing.mockRestore(); }
  });
  it("answered native questions do not pause the route or leave status blocked (#21)", async () => {
    const { rt } = await project({ continuity: false, codex: [started, { ask: "item/tool/requestUserInput", params: { questions: [{ id: "color", question: "Which?", options: [] }] } }, codexMessage("Noted."), codexDone()] });
    const briefings = (rt as unknown as { briefings: { prepareHandoff: (...args: unknown[]) => Promise<unknown> } }).briefings;
    const prepare = vi.spyOn(briefings, "prepareHandoff").mockResolvedValue({ memory: "", briefing: "", mode: "template", elapsedMs: 0, bridges: [] });
    try {
      await rt.startRoute({ task: "choose", spec: ["codex"] });
      await waitUntil(() => rt.log.list().some(e => e.kind === "needs_input"));
      const q = rt.log.list().find(e => e.kind === "needs_input")!;
      await rt.answerQuestion("codex", "main", String(q.payload.requestId), { color: "blue" });
      await waitUntil(() => rt.routeState()?.status === "completed");
      expect((await rt.status()).needsInput).toBe(false);
    } finally { prepare.mockRestore(); }
  });
});

import { NativeUsage } from "../../src/daemon/runtime/native-usage.js";

it("keeps a rejected window blocked across unrelated allowed reports (#19)", () => {
  const usage = new NativeUsage();
  const report = (windows: Array<{ id: string; usedPercent: number }>, reached?: string) => usage.observe({ kind: "status", agentId: "claude", ts: Date.now(), payload: { state: "usage_limits", provider: "claude", windows, ...(reached ? { reached } : {}) } });
  report([{ id: "five_hour", usedPercent: 100 }], "five_hour");
  report([{ id: "seven_day", usedPercent: 20 }]);
  expect(usage.limitsFor("claude-code")?.reached).toBe("five_hour");
  report([{ id: "seven_day", usedPercent: 100 }], "seven_day");
  report([{ id: "seven_day", usedPercent: 20 }]);
  expect(usage.limitsFor("claude-code")?.reached).toBe("five_hour");
  report([{ id: "five_hour", usedPercent: 10 }]);
  expect(usage.limitsFor("claude-code")?.reached).toBeNull();
});

it("redispatches a queued request with its captured context budget (#17)", async () => {
  const { rt } = await project({ codex: [{ sleep: 200 }, ...codexSays("done")] });
  const internal = rt as unknown as { contextBudget: (id: string) => number };
  let budget = 6000;
  const spy = vi.spyOn(internal, "contextBudget").mockImplementation(() => budget);
  try {
    await rt.sendMessage("first", "codex");
    const queued = await rt.sendMessage("second", "codex");
    budget = 20_000;
    await waitUntil(() => ended(rt) >= 2 && !rt.anyBusy());
    expect(rt.continuity!.store.request(queued.requestId!)?.targetAddedTokens).toBe(6000);
    expect(rt.continuity!.store.receipts(queued.requestId!).at(-1)?.status).toBe("accepted");
  } finally { spy.mockRestore(); }
});

it("records rewind intent before files move and blocks dispatch after restart until retry (#8)", async () => {
  const { rt, dir } = await project({ git: true });
  await turn(rt, "discard this", "main");
  const checkpoint = String(rt.log.list().find(e => e.payload.reason === "before_turn")!.payload.id);
  fs.writeFileSync(path.join(dir, "app.txt"), "changed");
  const restore = checkpoints.restore;
  const spy = vi.spyOn(checkpoints, "restore").mockImplementationOnce(async (...args) => {
    expect(fs.existsSync(path.join(dir, ".loom", "rewind-pending.json"))).toBe(true);
    await restore(...args); throw new Error("simulated crash after files moved");
  });
  try { await expect(rt.rewind(checkpoint)).rejects.toThrow("simulated crash"); }
  finally { spy.mockRestore(); }
  await rt.close(); open.splice(open.indexOf(rt), 1);
  const again = await ProjectRuntime.open(rt.info); open.push(again);
  await expect(again.sendMessage("unsafe dispatch", "codex")).rejects.toThrow(/rewinding|interrupted rewind/);
  await again.rewind(checkpoint);
  expect(fs.existsSync(path.join(dir, ".loom", "rewind-pending.json"))).toBe(false);
  expect(again.continuity!.store.bindingsFor("main", "codex")[0]?.nativeSessionId).toBeNull();
  await turn(again, "retained history only", "main");
  const messages = again.continuity!.store.receipts().at(-1)!;
  expect(messages.status).toBe("accepted");
});

it.each(["rate_limit_reached", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached"])("clears Codex account reason %s on a recovered snapshot (audit #12)", reached => {
  const usage = new NativeUsage();
  const report = (reason?: string) => usage.observe({ kind: "status", agentId: "codex", ts: Date.now(), payload: {
    state: "usage_limits", provider: "codex", windows: [{ id: "primary", usedPercent: reason ? 100 : 20 }, { id: "secondary", usedPercent: 10 }],
    ...(reason ? { reached: reason } : {}) } });
  report(reached); expect(usage.limitsFor("codex")?.reached).toBe(reached);
  report(); expect(usage.limitsFor("codex")?.reached).toBeNull();
});

it("moves disabled agents' Brain bindings with their persisted native rollback (audit #7)", async () => {
  const { rt } = await project({ git: true });
  const chat = rt.createChat("work", { agentId: "codex" }).id;
  await turn(rt, "keep before checkpoint", chat);
  await turn(rt, "discard after checkpoint", chat);
  const before = rt.continuity!.store.bindingsFor(chat, "codex")[0]!;
  await rt.switchChat(chat, "claude");
  rt.baton.release("codex"); rt.setAgentEnabled("codex", false);
  const out = await rt.rewind(checkpointOf(rt, "discard after checkpoint"));
  expect(out.conversation).toContainEqual({ agentId: "codex", provider: "codex", turns: 1 });
  expect(rt.continuity!.store.bindingById(before.id)).toMatchObject({ nativeSessionId: before.nativeSessionId,
    sessionEpoch: before.sessionEpoch + 1, retention: "unknown" });
  rt.setAgentEnabled("codex", true);
  await rt.switchChat(chat, "codex");
  const next = await turn(rt, "continue retained history", chat);
  expect(rt.continuity!.store.packet(next.packetId!)!.packet.mode).toBe("reconstruction");
});

it("follows only the rolled-back workspace and native cursor (#5)", async () => {
  const dir = makeProjectDir(), log = await EventLog.open(path.join(dir, ".loom")); open.push(log);
  const brain = new ContinuityEngine(log, "project");
  for (const [id, workspace, cursor] of [["root", "a", "root-native"], ["worktree", "c", "worktree-native"], ["other-config", "a", "other-native"]]) {
    brain.store.binding(id!, () => ({ id: id!, conversationId: "main", agentInstanceId: "codex", harnessKind: "codex",
      workspaceId: workspace!.repeat(64), compatibilityFingerprint: "b".repeat(64), nativeSessionId: cursor!, sessionEpoch: 1, retention: "unknown" }));
  }
  followRollback(brain, "main", "codex", "root-after", { workspaceId: "a".repeat(64), previousCursor: "root-native" });
  expect(brain.store.bindingById("root")).toMatchObject({ nativeSessionId: "root-after", sessionEpoch: 2 });
  expect(brain.store.bindingById("worktree")).toMatchObject({ nativeSessionId: "worktree-native", sessionEpoch: 1 });
  expect(brain.store.bindingById("other-config")).toMatchObject({ nativeSessionId: "other-native", sessionEpoch: 1 });
});

it("uses pending undo provenance in a linked checkout before a rewound event exists (finding #1)", async () => {
  const { rt, dir } = await project({ git: true, continuity: false });
  const linked = path.join(path.dirname(dir), `linked-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "-q", "-b", "agent-test", linked], { cwd: dir });
  const cp = (await checkpoints.capture(linked, "linked before"))!;
  fs.writeFileSync(path.join(linked, "app.txt"), "linked later");
  const prepared = await checkpoints.prepareRestore(linked, cp.id);
  await checkpoints.restore(linked, cp.id, prepared);
  fs.writeFileSync(path.join(dir, "app.txt"), "main must survive");
  fs.writeFileSync(path.join(dir, ".loom", "rewind-pending.json"), JSON.stringify({ id: cp.id, origin: null, steps: [], workspace: { dir: linked }, prepared }));
  await rt.rewind(prepared.undo.id);
  expect(fs.readFileSync(path.join(linked, "app.txt"), "utf8")).toBe("linked later");
  expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("main must survive");
  expect(fs.existsSync(path.join(dir, ".loom", "rewind-pending.json"))).toBe(false);
});

it("retains interrupted rewind intent if retry preflight fails (finding #2)", async () => {
  const { rt, dir } = await project({ git: true });
  const cp = (await checkpoints.capture(dir, "before"))!;
  fs.writeFileSync(path.join(dir, "app.txt"), "changed");
  const restore = checkpoints.restore;
  const crash = vi.spyOn(checkpoints, "restore").mockImplementationOnce(async (...args) => { await restore(...args); throw new Error("crash after writes"); });
  try { await expect(rt.rewind(cp.id)).rejects.toThrow(/crash/); } finally { crash.mockRestore(); }
  const journal = path.join(dir, ".loom", "rewind-pending.json"), intent = fs.readFileSync(journal, "utf8");
  const preflight = vi.spyOn(checkpoints, "restore").mockRejectedValueOnce(new Error("symlink parent"));
  try { await expect(rt.rewind(cp.id)).rejects.toThrow(/symlink/); } finally { preflight.mockRestore(); }
  expect(fs.readFileSync(journal, "utf8")).toBe(intent);
  await expect(rt.sendMessage("unsafe", "codex")).rejects.toThrow(/rewinding/);
  await rt.rewind(cp.id, { conversation: false }); expect(fs.existsSync(journal)).toBe(false);
});

it.each(["rewind-pending.json", "compaction-pending.json"])("blocks chat switch on persisted %s (finding #7)", async journal => {
  const { rt, dir } = await project({ git: true });
  fs.writeFileSync(path.join(dir, ".loom", journal), "{}");
  await expect(rt.switchChat("main", "claude")).rejects.toThrow(/rewind|compaction/);
  expect((await rt.status()).holder).not.toBe("claude");
  fs.rmSync(path.join(dir, ".loom", journal));
  await rt.switchChat("main", "claude"); expect((await rt.status()).holder).toBe("claude");
});

it.each(["claude", "codex"])("waits for turn commit finalization before route handoff to %s (finding #3)", async next => {
  const { rt } = await project({ git: true, continuity: false });
  const briefings = (rt as unknown as { briefings: { prepareHandoff: (...args: unknown[]) => Promise<unknown> } }).briefings;
  const briefing = vi.spyOn(briefings, "prepareHandoff").mockResolvedValue({ memory: "", briefing: "", mode: "template", elapsedMs: 0, bridges: [] });
  const turns = (rt as unknown as { turns: RuntimeTurns }).turns;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commit = vi.spyOn(turns, "commitTurn").mockImplementationOnce(async () => { await gate; });
  // The fake does not edit files; provide a real diff so finalization reaches commit.
  const diff = vi.spyOn(checkpoints, "diffSince").mockResolvedValueOnce({ files: [{ status: " M", path: "app.txt" }], added: 1, removed: 1, patch: "", truncated: false });
  try {
    await rt.startRoute({ task: "two steps", spec: ["codex", next] });
    await waitUntil(() => commit.mock.calls.length > 0);
    expect(rt.routeState()?.status).toBe("running");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((rt as unknown as { queue: PromptQueue }).queue.snapshot().items).toHaveLength(0);
    release(); await waitUntil(() => rt.routeState()?.status === "completed");
    expect(rt.log.list({ kinds: ["error"] }).some(e => /finalizing/.test(String(e.payload.message)))).toBe(false);
  } finally { release(); commit.mockRestore(); diff.mockRestore(); briefing.mockRestore(); }
});

it("Stop cancels legacy dispatch while startup is awaited (finding #9)", async () => {
  const { rt, codex } = await project({ continuity: false });
  const host = rt as unknown as { ensureStarted: (id: string) => Promise<unknown> };
  const original = host.ensureStarted.bind(rt);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const startup = vi.spyOn(host, "ensureStarted").mockImplementationOnce(async id => { await gate; return original(id); });
  try {
    const sending = rt.sendMessage("must never run", "codex"), outcome = sending.catch(error => error);
    await waitUntil(() => startup.mock.calls.length > 0);
    expect(await rt.interrupt()).toEqual({ interrupted: "codex" });
    release(); expect((await outcome).message).toMatch(/interrupted/);
    expect(rpcOf(codex, "turn/start")).toHaveLength(0);
    expect(rt.anyBusy()).toBe(false);
  } finally { release(); startup.mockRestore(); }
});

it("clears a prior turn checkpoint before a failed new capture (finding #10)", async () => {
  const { rt, dir } = await project({ git: true, continuity: false });
  const turns = (rt as unknown as { turns: RuntimeTurns }).turns;
  const prior = (await checkpoints.capture(dir, "prior"))!;
  turns.turnCheckpoint.set("codex", prior.id);
  const capture = vi.spyOn(checkpoints, "capture").mockRejectedValueOnce(new Error("capture failed"));
  try { await turns.checkpointBefore("codex", "next", "main"); } finally { capture.mockRestore(); }
  expect(turns.turnCheckpoint.has("codex")).toBe(false);
  const { turnSnapshot } = await import("../../src/core/worktree.js");
  turns.preTurnTree.set("codex", await turnSnapshot(dir));
  fs.writeFileSync(path.join(dir, "app.txt"), "new turn\n");
  turns.captureTurnDiff("codex"); await turns.lastTurnDiff.get("codex");
  await waitUntil(() => rt.log.list({ kinds: ["turn_diff"] }).length > 0);
  expect(rt.log.list({ kinds: ["turn_diff"] }).at(-1)!.payload.checkpoint).toBeUndefined();
});

it.each(["snapshot", "checkpoint"])("Stop cancels legacy dispatch during %s capture (finding #9)", async stage => {
  const { rt, codex } = await project({ continuity: false, git: true });
  const worktree = await import("../../src/core/worktree.js");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalSnapshot = worktree.turnSnapshot, originalCapture = checkpoints.capture;
  const spy = stage === "snapshot"
    ? vi.spyOn(worktree, "turnSnapshot").mockImplementationOnce(async dir => { await gate; return originalSnapshot(dir); })
    : vi.spyOn(checkpoints, "capture").mockImplementationOnce(async (...args) => { await gate; return originalCapture(...args); });
  try {
    const sending = rt.sendMessage("cancel preparation", "codex"), outcome = sending.catch(error => error);
    await waitUntil(() => spy.mock.calls.length > 0);
    expect(await rt.interrupt()).toEqual({ interrupted: "codex" });
    release(); expect((await outcome).message).toMatch(/interrupted/);
    expect(rpcOf(codex, "turn/start")).toHaveLength(0); expect(rt.anyBusy()).toBe(false);
    await rt.sendMessage("ordinary retry", "codex"); await waitUntil(() => !rt.anyBusy());
    expect(rpcOf(codex, "turn/start")).toHaveLength(1);
  } finally { release(); spy.mockRestore(); }
});

it("releases a vanished checkout through files-only without writing Main (finding #1)", async () => {
  const { rt, dir } = await project({ git: true, continuity: false });
  const cp = (await checkpoints.capture(dir, "before"))!;
  const journal = path.join(dir, ".loom", "rewind-pending.json");
  fs.writeFileSync(journal, JSON.stringify({ id: cp.id, origin: null, steps: [], workspace: { dir: path.join(dir, "gone") } }));
  expect(await rt.rewind(cp.id, { conversation: false })).toMatchObject({ recoveryReleased: true, changed: [], message: expect.stringMatching(/no files were restored/) });
  expect(fs.existsSync(journal)).toBe(false);
  expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("v0\n");
  await rt.sendMessage("ordinary recovery", "codex"); await waitUntil(() => !rt.anyBusy());
});

it("clears runtime ownership after a chat switch stops a retained legacy writer (finding #4)", async () => {
  const { rt } = await project({ continuity: false, git: true, codex: [started,
    codexNotify("item/started", { item: { id: "cmd", type: "commandExecution", command: "write", status: "inProgress" } }), codexDone()] });
  const agent = rt.agent("codex") as ProviderAgent;
  (agent as unknown as { options: Record<string, unknown> }).options.commandSettleMs = 100;
  await rt.ensureStarted("codex");
  // Attach lazily, then pause submission long enough to install the stop failure.
  await rt.sendMessage("unsettled", "codex");
  await waitUntil(() => Boolean((agent as unknown as { providers: unknown }).providers));
  const service = (agent as unknown as { providers: { service: import("../../src/providers/service.js").ProviderService } }).providers.service;
  const stop = vi.spyOn(service, "stopSession").mockRejectedValueOnce(new Error("transient stop failure"));
  const briefings = (rt as unknown as { briefings: { prepareHandoff: (...args: unknown[]) => Promise<unknown> } }).briefings;
  const briefing = vi.spyOn(briefings, "prepareHandoff").mockResolvedValue({ memory: "", briefing: "", mode: "template", elapsedMs: 0, bridges: [] });
  try {
    await waitUntil(() => stop.mock.calls.length > 0 && rt.log.list({ kinds: ["error"] }).length > 0);
    expect(agent.busy()).toBe(true);
    await rt.switchChat("main", "claude");
    expect((rt as unknown as { turns: RuntimeTurns }).turns.busySince.has("codex")).toBe(false);
    await rt.sendMessage("ordinary switch recovery", "claude"); await waitUntil(() => !rt.anyBusy());
  } finally { stop.mockRestore(); briefing.mockRestore(); }
});

it("can finish files-only recovery from the journal even if its target ref was pruned (finding #6)", async () => {
  const { rt, dir } = await project({ continuity: false, git: true });
  const cp = (await checkpoints.capture(dir, "target"))!;
  fs.writeFileSync(path.join(dir, "app.txt"), "later\n");
  const prepared = await checkpoints.prepareRestore(dir, cp.id);
  const journal = path.join(dir, ".loom", "rewind-pending.json");
  fs.writeFileSync(journal, JSON.stringify({ id: cp.id, origin: null, steps: [], workspace: { dir }, prepared }));
  execFileSync("git", ["update-ref", "-d", `refs/loom/checkpoints/${cp.id}`], { cwd: dir });
  execFileSync("git", ["gc", "--prune=now"], { cwd: dir });
  await rt.rewind(cp.id, { conversation: false });
  expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("v0\n");
  expect(fs.existsSync(journal)).toBe(false);
});

it("offers a different driver even when both accounts are called work (B3)", async () => {
  const { rt } = await project({ continuity: false });
  for (const config of rt.config.agents) config.options = { ...config.options, accountKey: "work" };
  const event = { kind: "status" as const, agentId: "codex", ts: Date.now(), payload: { state: "usage_limits", provider: "codex", accountKey: "work", windows: [], reached: "primary" } };
  (rt as unknown as { offerSwitch(event: unknown, kind: string): void }).offerSwitch(event, "codex");
  expect(rt.log.list().find(e => e.payload.state === "switch_suggested")?.payload.alternatives).toEqual([{ agentId: "claude", kind: "claude-code" }]);
});

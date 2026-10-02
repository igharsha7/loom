/**
 * Warm sessions: Codex and Claude Code through ProviderAgent, against the
 * protocol fakes. What matters here is what the per-turn adapters could not
 * do — one harness process across turns, a session per chat, an in-session
 * model switch, resume after a restart — and that Brain's rule (a continuity
 * turn owns its process group) still holds.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, CodexAdapter, stopAllProviderSessions } from "../../src/providers/agent.js";
import { nativeChatOf } from "../../src/adapters/base.js";
import { readProjectState, writeProjectState } from "../../src/core/registry.js";
import { MAIN_CHAT, type AdapterEvent } from "../../src/types.js";
import type { LiveDelta } from "../../src/providers/ingestion.js";
import { makeProjectDir, waitUntil } from "../helpers.js";
import {
  CLAUDE_OK, CODEX_OK, callsOf, claudeInit, claudeResult, codexDone, codexItem, codexNotify, codexTokens, fakeClaude, fakeCodex,
  rpcOf, stdinOf, turnsOf, type Step,
} from "../native-fakes.js";

afterEach(async () => { await stopAllProviderSessions(); });
afterAll(async () => { await stopAllProviderSessions(); });

const of = (e: AdapterEvent[], kind: string): Array<Record<string, unknown>> => e.filter((x) => x.kind === kind).map((x) => x.payload);
const sessionsFile = (dir: string) => path.join(dir, ".loom", "providers", "sessions.json");
const bindings = (dir: string): Array<Record<string, unknown>> =>
  (JSON.parse(fs.readFileSync(sessionsFile(dir), "utf8")) as { bindings: Array<Record<string, unknown>> }).bindings;

function codexAgent(bin: string, dir = makeProjectDir({ name: "warm" }), options: Record<string, unknown> = {}) {
  const agent = new CodexAdapter("codex", dir, { bin, ...options });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  return { agent, events, dir };
}

function claudeAgent(bin: string, dir = makeProjectDir({ name: "warm" }), options: Record<string, unknown> = {}) {
  const agent = new ClaudeCodeAdapter("claude", dir, { bin, ...options });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  return { agent, events, dir };
}

describe("codex · warm sessions", () => {
  it("serves several turns in a chat from one app-server and one thread", async () => {
    const bin = fakeCodex();
    const { agent, events } = codexAgent(bin);
    await agent.send({ text: "one" });
    await agent.send({ text: "two" });
    await agent.send({ text: "three" });
    expect(callsOf(bin)).toHaveLength(1);
    expect(rpcOf(bin, "thread/start")).toHaveLength(1);
    expect(rpcOf(bin, "turn/start").map((p) => (p.input as Array<{ text: string }>)[0]!.text)).toEqual(["one", "two", "three"]);
    const turns = turnsOf(bin);
    expect(new Set(turns.map((t) => t.pid)).size).toBe(1);
    expect(new Set(turns.map((t) => t.thread)).size).toBe(1);
    expect(of(events, "run_complete")).toHaveLength(3);
    await agent.stop();
  });

  it("keeps a separate native session per chat", async () => {
    const bin = fakeCodex();
    const { agent, dir } = codexAgent(bin);
    await agent.send({ text: "main work" });
    await agent.send({ text: "side work", chat: "side" });
    await agent.send({ text: "main again" });
    expect(callsOf(bin)).toHaveLength(2);
    expect(rpcOf(bin, "thread/start")).toHaveLength(2);
    const threads = turnsOf(bin).map((t) => t.thread);
    expect(threads[0]).toBe(threads[2]);
    expect(threads[1]).not.toBe(threads[0]);
    expect(bindings(dir).map((b) => b.threadId).sort()).toEqual([MAIN_CHAT, "side"]);
    await agent.stop();
  });

  it("switches model in-session, per turn", async () => {
    const bin = fakeCodex();
    const { agent } = codexAgent(bin);
    await agent.send({ text: "one" });
    await agent.send({ text: "two", model: "o3" });
    expect(callsOf(bin)).toHaveLength(1);
    expect(rpcOf(bin, "turn/start")[1]).toMatchObject({ model: "o3" });
    await agent.stop();
  });

  it("resumes the chat's thread after the agent is rebuilt", async () => {
    const bin = fakeCodex();
    const dir = makeProjectDir({ name: "warm" });
    const first = codexAgent(bin, dir);
    await first.agent.send({ text: "one" });
    const thread = turnsOf(bin)[0]!.thread;
    // A model or permission change rebuilds the agent; the new one takes over.
    const second = codexAgent(bin, dir, { model: "o3" });
    await second.agent.send({ text: "two" });
    expect(callsOf(bin)).toHaveLength(2);
    expect(rpcOf(bin, "thread/resume")[0]).toMatchObject({ threadId: thread, model: "o3" });
    expect(first.agent.busy()).toBe(false);
    await second.agent.stop();
  });

  it("restarts (and resumes) a session when the project's MCP servers change", async () => {
    const bin = fakeCodex();
    const { agent } = codexAgent(bin);
    const mcp = (url: string) => ({ configPath: "/nope", servers: [{ key: "docs", name: "docs", entry: { type: "http" as const, url } }] });
    await agent.send({ text: "one", mcp: mcp("https://a.example") });
    await agent.send({ text: "two", mcp: mcp("https://a.example") });
    await agent.send({ text: "three", mcp: mcp("https://b.example") });
    expect(callsOf(bin)).toHaveLength(2);
    expect(rpcOf(bin, "thread/resume")[0]).toMatchObject({ config: { "mcp_servers.docs": { url: "https://b.example" } } });
    await agent.stop();
  });

  it("assembles the reply from streamed deltas, and streams them live", async () => {
    const bin = fakeCodex({ script: [
      codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } }),
      codexNotify("item/agentMessage/delta", { itemId: "m1", delta: "Hel" }),
      codexNotify("item/agentMessage/delta", { itemId: "m1", delta: "lo." }),
      codexItem({ id: "m1", type: "agentMessage", text: "" }),
      codexTokens(100, 0, 10), codexDone()] });
    const { agent, events } = codexAgent(bin);
    const live: LiveDelta[] = [];
    agent.onLive((d) => live.push(d));
    await agent.send({ text: "hi" });
    expect(of(events, "message")).toEqual([{ text: "Hello." }]);
    expect(live.map((d) => d.delta).join("")).toBe("Hello.");
    expect(live[0]).toMatchObject({ agentId: "codex", chat: MAIN_CHAT, streamKind: "assistant_text", itemId: "m1" });
    await agent.stop();
  });

  it("carries on in a fresh session when the app-server dies between turns", async () => {
    const bin = fakeCodex({ scripts: [[...CODEX_OK, { sleep: 50 }, { exit: 3 }]] });
    const { agent, events } = codexAgent(bin);
    await agent.send({ text: "one" });
    await new Promise((r) => setTimeout(r, 300)); // the process exits after the turn
    await agent.send({ text: "two" });
    expect(callsOf(bin)).toHaveLength(2);
    // the second process resumed the first's thread
    expect(rpcOf(bin, "thread/resume")).toHaveLength(1);
    expect(of(events, "run_complete")).toHaveLength(2);
    await agent.stop();
  });

  it("aborts a turn whose app-server dies mid-turn, with the outcome unknown", async () => {
    const bin = fakeCodex({ script: [codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } }),
      { stderr: "panic: boom" }, { exit: 101 }] });
    const { agent, events } = codexAgent(bin);
    const error = await agent.send({ text: "one" }).catch((e: Error) => e);
    expect(String((error as Error).message)).toMatch(/outcome is unknown/);
    expect(of(events, "error")[0]).toMatchObject({ stderr: expect.stringContaining("panic: boom") });
    expect(agent.busy()).toBe(false);
  });

  it("keeps continuity turns warm on the session Brain's binding names", async () => {
    const bin = fakeCodex();
    const { agent } = codexAgent(bin);
    const continuity = (nativeSessionId: string | null) => ({ runId: `r-${Math.random()}`, bindingId: "b", sessionEpoch: 1, nativeSessionId, context: "PACKET" });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));
    await agent.send({ text: "one", continuity: continuity(null) });
    const session = of(events, "status").find((p) => p.state === "turn_started")!.session as string;
    await agent.send({ text: "two", continuity: continuity(session) });
    expect(callsOf(bin)).toHaveLength(1);
    expect(new Set(turnsOf(bin).map((t) => t.thread)).size).toBe(1);
    // Brain's binding named no session (a new epoch): a fresh thread, even though one is live.
    await agent.send({ text: "three", continuity: continuity(null) });
    expect(rpcOf(bin, "thread/start")).toHaveLength(2);
    await agent.stop();
  });

  it("migrates the pre-warm native session to the main chat's binding", async () => {
    const bin = fakeCodex();
    const dir = makeProjectDir({ name: "warm" });
    const state = readProjectState(dir);
    state.agents.codex = { ...state.agents.codex, sessionId: "thread-legacy" };
    writeProjectState(dir, state);
    const { agent } = codexAgent(bin, dir);
    await agent.send({ text: "carry on" });
    expect(rpcOf(bin, "thread/resume")[0]).toMatchObject({ threadId: "thread-legacy" });
    expect(readProjectState(dir).agents.codex?.sessionId).toBeUndefined();
    await agent.stop();
  });
});

const streamEvent = (event: Record<string, unknown>): Step =>
  ({ out: { type: "stream_event", event, parent_tool_use_id: null, session_id: "$SESSION", uuid: `u-${Math.random()}` } });

describe("claude · warm sessions", () => {
  it("serves several turns in a chat from one CLI process", async () => {
    const bin = fakeClaude();
    const { agent, events } = claudeAgent(bin);
    await agent.send({ text: "one" });
    await agent.send({ text: "two" });
    expect(callsOf(bin)).toHaveLength(1);
    const prompts = stdinOf(bin).filter((m) => m.type === "user");
    expect(prompts).toHaveLength(2);
    expect(new Set(turnsOf(bin).map((t) => t.pid)).size).toBe(1);
    expect(of(events, "run_complete")).toHaveLength(2);
    await agent.stop();
  });

  it("chooses the session id up front, and resumes it after a restart", async () => {
    const bin = fakeClaude();
    const dir = makeProjectDir({ name: "warm" });
    const first = claudeAgent(bin, dir);
    await first.agent.send({ text: "one" });
    const launch = callsOf(bin)[0]!;
    const id = launch.includes("--session-id") ? launch[launch.indexOf("--session-id") + 1] : launch.find((a) => a.startsWith("--session-id="))?.slice(13);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const second = claudeAgent(bin, dir);
    await second.agent.send({ text: "two" });
    const relaunch = callsOf(bin)[1]!;
    expect(relaunch.join(" ")).toContain(id!);
    expect(relaunch.some((a) => a === "--resume" || a.startsWith("--resume="))).toBe(true);
    await second.agent.stop();
  });

  it("switches model in-session with setModel", async () => {
    const bin = fakeClaude();
    const { agent } = claudeAgent(bin);
    await agent.send({ text: "one" });
    await agent.send({ text: "two", model: "claude-opus-5-5" });
    expect(callsOf(bin)).toHaveLength(1);
    const setModel = stdinOf(bin).find((m) => (m.request as Record<string, unknown> | undefined)?.subtype === "set_model");
    expect(setModel?.request).toMatchObject({ model: "claude-opus-5-5" });
    await agent.stop();
  });

  it("assembles the reply from streamed deltas", async () => {
    const bin = fakeClaude({ script: [claudeInit,
      streamEvent({ type: "message_start", message: { id: "msg_1" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Stre" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "amed." } }),
      { out: { type: "assistant", message: { id: "msg_1", model: "claude-test", content: [{ type: "text", text: "Streamed." }] }, parent_tool_use_id: null, session_id: "$SESSION" } },
      claudeResult()] });
    const { agent, events } = claudeAgent(bin);
    const live: LiveDelta[] = [];
    agent.onLive((d) => live.push(d));
    await agent.send({ text: "hi" });
    expect(of(events, "message")).toEqual([{ text: "Streamed." }]);
    expect(live.map((d) => d.delta)).toEqual(["Stre", "amed."]);
    expect(live[0]).toMatchObject({ itemId: "msg_1:0", streamKind: "assistant_text" });
    await agent.stop();
  });

  it("reports a lost session to Brain as NativeSessionMissing, before any prompt", async () => {
    const bin = fakeClaude({ missingSession: true });
    const { agent } = claudeAgent(bin);
    const error = await agent.send({ text: "go", continuity: { runId: "r", bindingId: "b", sessionEpoch: 1,
      nativeSessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", context: "ctx" } }).catch((e: Error) => e);
    expect((error as Error).name).toBe("NativeSessionMissing");
    expect(stdinOf(bin).filter((m) => m.type === "user")).toHaveLength(0);
  });

  it("puts a tool's approval in front of a person and relays the answer", async () => {
    const { setApprovalBroker } = await import("../../src/core/approvals.js");
    const asked: Array<{ tool: string; input: unknown }> = [];
    setApprovalBroker(async (req) => { asked.push({ tool: req.tool, input: req.input }); return { behavior: "allow" }; });
    try {
      const bin = fakeClaude({ script: [claudeInit, { ask: { tool_name: "Bash", input: { command: "rm -rf build" } } }, ...CLAUDE_OK.slice(1)] });
      const { agent } = claudeAgent(bin, makeProjectDir({ name: "warm" }), { permissions: "ask" });
      await agent.send({ text: "clean" });
      expect(asked).toEqual([{ tool: "Bash", input: { command: "rm -rf build" } }]);
      const answer = stdinOf(bin).find((m) => m.type === "control_response");
      expect(JSON.stringify(answer)).toContain('"behavior":"allow"');
      await agent.stop();
    } finally { setApprovalBroker(null); }
  });
});

describe("provider event association regression", () => {
  it("does not stamp a parked chat's message with the active chat's run (#5)", () => {
    const { agent, events } = codexAgent(fakeCodex());
    const internals = agent as unknown as { beginContinuity: (input: unknown) => void; endContinuity: () => void;
      ingestion: { ingest: (event: unknown) => void } };
    internals.beginContinuity({ continuity: { runId: "B", bindingId: "binding-B", sessionEpoch: 1 } });
    internals.ingestion.ingest({ eventId: "old", type: "item.completed", provider: "codex", instanceId: "codex", threadId: "A", turnId: "turn-A", createdAt: Date.now(), payload: { itemType: "assistant_message", detail: "private A" } });
    expect(events.at(-1)!.payload).toEqual({ text: "private A" });
    expect(nativeChatOf(events.at(-1)!)).toBe("A");
    expect(JSON.parse(JSON.stringify(events.at(-1)!))).toEqual({ kind: "message", payload: { text: "private A" } });
    expect(events.at(-1)!.payload).not.toHaveProperty("loomRunId");
    internals.endContinuity();
  });
});

import { ProviderError } from "../../src/providers/errors.js";
import { NativeQuiescenceUnknown } from "../../src/core/continuity/contracts.js";

it("keeps unknown submission failures distinct from ordinary failures (#1)", () => {
  const { agent } = codexAgent(fakeCodex());
  const internal = agent as unknown as { dispatchError: (error: unknown, continuity: boolean) => Error };
  expect(internal.dispatchError(new ProviderError("transport", "sendTurn", "lost acknowledgement", { mayHaveStarted: true }), true))
    .toBeInstanceOf(NativeQuiescenceUnknown);
});

it("retains ProviderAgent ownership after unregister rejects (#7)", async () => {
  const { agent } = codexAgent(fakeCodex()); await agent.send({ text: "one" });
  const internal = agent as unknown as { providers: { service: { unregister: (id: string) => Promise<void> } }; adapter: unknown };
  const providers = internal.providers, adapter = internal.adapter;
  const spy = vi.spyOn(providers.service, "unregister").mockRejectedValueOnce(new Error("containment failed"));
  try {
    await expect(agent.stop()).rejects.toThrow("containment failed");
    expect(internal.providers).toBe(providers); expect(internal.adapter).toBe(adapter);
    await agent.stop(); expect(internal.providers).toBeNull();
  } finally { spy.mockRestore(); }
});

it("resets a cleared chat model to the native default on both warm providers (#12)", async () => {
  const cx = fakeCodex({ model: "native-default" }), cl = fakeClaude();
  const codex = codexAgent(cx).agent, claude = claudeAgent(cl).agent;
  for (const agent of [codex, claude]) {
    await agent.send({ text: "override first", model: "chat-override" });
    await agent.send({ text: "default again" });
  }
  expect(rpcOf(cx, "thread/start")[0]).toMatchObject({ model: "chat-override" });
  expect(rpcOf(cx, "turn/start").map(p => p.model)).toEqual(["chat-override", "native-default"]);
  const selections = stdinOf(cl).filter(m => (m.request as Record<string, unknown> | undefined)?.subtype === "set_model");
  expect(callsOf(cl)[0]?.join(" ")).toContain("chat-override");
  expect(selections).toHaveLength(1);
  expect(selections[0]?.request).not.toHaveProperty("model");
  await codex.stop(); await claude.stop();
});

it("publishes completion after outstanding commands complete (#11)", async () => {
  const bin = fakeCodex({ script: [
    codexNotify("turn/started", { turn: { id: "$TURN" } }),
    codexNotify("item/started", { item: { id: "cmd", type: "commandExecution", command: "write", status: "inProgress" } }),
    codexDone(), { sleep: 150 },
    codexNotify("item/completed", { item: { id: "cmd", type: "commandExecution", command: "write", status: "completed", exitCode: 0, aggregatedOutput: "done" } }),
  ] });
  const { agent, events } = codexAgent(bin);
  await agent.send({ text: "work" });
  expect(events.findIndex(e => e.kind === "run_complete")).toBeGreaterThan(events.findIndex(e => e.kind === "tool_call"));
  await agent.stop();
});

it("keeps Stop during a lost turn acknowledgement outcome unknown (audit #1)", async () => {
  const bin = fakeCodex({ startAckExit: true });
  const { agent } = codexAgent(bin);
  const sending = agent.send({ text: "work", continuity: { runId: "r", bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "" } });
  const rejected = expect(sending).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
  await waitUntil(() => rpcOf(bin, "turn/start").length > 0);
  const stopping = agent.interrupt();
  await rejected; await stopping; await agent.stop();
});

it("keeps a Claude Bash command unresolved when result has no tool result (audit #4)", async () => {
  const bin = fakeClaude({ script: [
    { out: { type: "assistant", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "write" } }] }, parent_tool_use_id: null } },
    claudeResult(),
  ] });
  const { agent, events } = claudeAgent(bin, undefined, { commandSettleMs: 20 });
  await expect(agent.send({ text: "work" })).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
  expect(of(events, "tool_call")).toEqual([]);
  expect(of(events, "run_complete")).toEqual([]);
  await agent.stop();
});

it("isolates timed-out partial text and requires Stop before a later completion (audit #10)", async () => {
  const bin = fakeCodex({ scripts: [[
    codexNotify("turn/started", { turn: { id: "$TURN" } }),
    codexNotify("item/agentMessage/delta", { itemId: "partial", delta: "old partial" }),
    codexNotify("item/started", { item: { id: "cmd", type: "commandExecution", command: "write", status: "inProgress" } }),
    codexDone(), { sleep: 50 },
    codexNotify("item/completed", { item: { id: "cmd", type: "commandExecution", command: "write", status: "completed", exitCode: 0 } }),
  ], CODEX_OK] });
  const { agent, events } = codexAgent(bin, undefined, { commandSettleMs: 20 });
  const continuity = (runId: string) => ({ runId, bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "" });
  await expect(agent.send({ text: "one", continuity: continuity("old") })).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
  expect(of(events, "message").find(p => p.text === "old partial")).toMatchObject({ loomRunId: "old", partial: true });
  await waitUntil(() => of(events, "tool_call").some(p => p.tool === "shell"));
  expect(of(events, "tool_call").find(p => p.tool === "shell")).toMatchObject({ loomRunId: "old" });
  const thread = turnsOf(bin)[0]!.thread;
  const next = { text: "two", continuity: { ...continuity("new"), nativeSessionId: thread } };
  expect(agent.busy()).toBe(true);
  await expect(agent.send(next)).rejects.toThrow(/quiescence is unknown; use Stop or loom interrupt/);
  expect(rpcOf(bin, "turn/start")).toHaveLength(1);
  expect(of(events, "run_complete")).toHaveLength(0);
  await agent.interrupt();
  expect(agent.busy()).toBe(false);
  // The restarted fake now serves a normal turn; its history stays beside bin.
  fs.copyFileSync(fakeCodex(), bin);
  await agent.send(next);
  expect(callsOf(bin)).toHaveLength(2);
  expect(rpcOf(bin, "thread/resume")[0]).toMatchObject({ threadId: thread });
  expect(of(events, "message").filter(p => p.text === "old partial")).toEqual([
    expect.objectContaining({ loomRunId: "old", partial: true }),
  ]);
  expect(of(events, "message").find(p => p.text === "Did the work.")).toMatchObject({ loomRunId: "new" });
  expect(of(events, "run_complete")).toEqual([expect.objectContaining({ loomRunId: "new" })]);
  await agent.stop();
});

it("waits for a late Claude tool result after the turn result (audit #4)", async () => {
  const bin = fakeClaude({ script: [
    { out: { type: "assistant", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "write" } }] }, parent_tool_use_id: null } },
    claudeResult(), { sleep: 50 },
    { out: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "finished" }] }, parent_tool_use_id: null } },
  ] });
  const { agent, events } = claudeAgent(bin, undefined, { commandSettleMs: 1000 });
  await agent.send({ text: "work", continuity: { runId: "r", bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "" } });
  expect(of(events, "tool_call")[0]).toMatchObject({ tool: "shell", loomRunId: "r", output: "finished" });
  expect(events.findIndex(e => e.kind === "tool_call")).toBeLessThan(events.findIndex(e => e.kind === "run_complete"));
  await agent.stop();
});

it.each([["codex", false], ["codex", true], ["claude", false], ["claude", true]] as const)("Stop during %s initialization never submits the prompt (continuity=%s, #5)", async (kind, continuity) => {
  const bin = kind === "codex" ? fakeCodex() : fakeClaude();
  const { agent, events } = kind === "codex" ? codexAgent(bin) : claudeAgent(bin);
  await (agent as any).attach();
  const service = (agent as any).providers.service as import("../../src/providers/service.js").ProviderService;
  const ensure = service.ensureSession.bind(service);
  let entered!: () => void, release!: () => void;
  const initializing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(service, "ensureSession").mockImplementation(async input => { entered(); await gate; return ensure(input); });
  const sending = agent.send({ text: "must never run", ...(continuity ? {
    continuity: { runId: "r", bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "" },
  } : {}) }).catch(error => error);
  await initializing;
  const stopped = agent.interrupt();
  release(); await stopped;
  const outcome = await sending;
  if (continuity) expect(outcome).toBeInstanceOf((await import("../../src/providers/settlement.js")).NativeDispatchRejected);
  else expect(outcome).toBeUndefined();
  expect(of(events, "status")).toContainEqual(expect.objectContaining({ state: "interrupted" }));
  expect(of(events, "error")).toEqual([]);
  expect(rpcOf(bin, "turn/start")).toHaveLength(0);
  expect(stdinOf(bin).filter(m => m.type === "user")).toHaveLength(0);
  expect(agent.busy()).toBe(false);
  spy.mockRestore(); await agent.stop();
});

it("keeps manual compaction alive across idle reaper sweeps (#9)", async () => {
  const bin = fakeCodex({ compactDelayMs: 150 }), { agent } = codexAgent(bin);
  await agent.send({ text: "one" });
  const providers = (agent as unknown as { providers: { service: import("../../src/providers/service.js").ProviderService; reaper: import("../../src/providers/reaper.js").SessionReaper } }).providers;
  const old = Date.now() - 31 * 60_000;
  const binding = providers.service.directory.get("main", "codex")!;
  providers.service.directory.upsert({ ...binding, lastSeenAt: old });
  const compacting = agent.compact();
  await waitUntil(() => rpcOf(bin, "thread/compact/start").length > 0);
  expect(providers.service.directory.get("main", "codex")!.lastSeenAt).toBeGreaterThan(old);
  // Even a stale timestamp cannot make a busy compaction reapable.
  providers.service.directory.upsert({ ...providers.service.directory.get("main", "codex")!, lastSeenAt: old });
  expect(await providers.reaper.sweep()).toBe(0);
  await compacting;
  expect(providers.service.directory.get("main", "codex")!.lastSeenAt).toBeGreaterThan(old);
  await agent.stop();
});

it.each(["Bash", "Agent"])("waits for background %s task notification after its placeholder (finding #3)", async name => {
  const bin = fakeClaude({ script: [
    { out: { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-bg", name, input: { command: "write", run_in_background: true } }] }, parent_tool_use_id: null } },
    { out: { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "tool-bg", description: "writes", is_backgrounded: true } },
    { out: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-bg", content: "running in background" }] }, parent_tool_use_id: null } },
    claudeResult(), { sleep: 150 },
    { out: { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "tool-bg", status: "completed", summary: "done", output_file: "out" } },
  ] });
  const { agent, events } = claudeAgent(bin, undefined, { commandSettleMs: 1000 });
  const sending = agent.send({ text: "background write" });
  await waitUntil(() => of(events, "tool_call").length > 0);
  expect(agent.busy()).toBe(true); expect(of(events, "run_complete")).toHaveLength(0);
  await sending; expect(of(events, "run_complete")).toHaveLength(1); await agent.stop();
});

it("uses the background roster without depending on edge order (finding #3)", async () => {
  const bin = fakeClaude({ script: [
    { out: { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg", task_type: "local_agent", description: "writes" }] } },
    { out: { type: "system", subtype: "task_notification", task_id: "bg", status: "completed", summary: "edge arrives first" } },
    claudeResult(), { sleep: 100 },
    { out: { type: "system", subtype: "background_tasks_changed", tasks: [] } },
    { out: { type: "system", subtype: "task_started", task_id: "bg", description: "late edge" } },
  ] });
  const { agent, events } = claudeAgent(bin, undefined, { commandSettleMs: 1000 });
  const sending = agent.send({ text: "roster" });
  await waitUntil(() => agent.busy());
  await sending; expect(of(events, "run_complete")).toHaveLength(1); await agent.stop();
});

it("stops a legacy session before releasing an unresolved command's writer lock (finding #4)", async () => {
  const bin = fakeCodex({ script: [
    codexNotify("turn/started", { turn: { id: "$TURN" } }),
    codexNotify("item/started", { item: { id: "cmd", type: "commandExecution", command: "write", status: "inProgress" } }),
    codexDone(),
  ] });
  const { agent } = codexAgent(bin, undefined, { commandSettleMs: 20 });
  await expect(agent.send({ text: "legacy" })).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
  const providers = (agent as unknown as { providers: { service: import("../../src/providers/service.js").ProviderService } }).providers;
  expect(providers.service.directory.get("main", "codex")?.status).toBe("stopped");
  expect(agent.busy()).toBe(false);
  await agent.send({ text: "ordinary retry" }).catch(() => {}); await agent.stop();
});

it("keeps a failed session stop owned and lets ordinary Stop retry it (finding #4)", async () => {
  const bin = fakeCodex({ scripts: [CODEX_OK, [
    codexNotify("turn/started", { turn: { id: "$TURN" } }),
    codexNotify("item/started", { item: { id: "cmd", type: "commandExecution", command: "write", status: "inProgress" } }), codexDone(),
  ]] });
  const { agent } = codexAgent(bin, undefined, { commandSettleMs: 20 });
  await agent.send({ text: "attach" });
  const service = (agent as unknown as { providers: { service: import("../../src/providers/service.js").ProviderService } }).providers.service;
  const stop = vi.spyOn(service, "stopSession").mockRejectedValueOnce(new Error("stop temporarily failed"));
  try {
    await expect(agent.send({ text: "unsettled" })).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
    expect(agent.busy()).toBe(true);
    await expect(agent.send({ text: "unsafe" })).rejects.toThrow(/busy/);
    await agent.interrupt(); expect(agent.busy()).toBe(false); expect(stop).toHaveBeenCalledTimes(2);
  } finally { stop.mockRestore(); await agent.stop(); }
});

it("does not leave a foreground agent task waiting for a background notification (finding #3)", async () => {
  const bin = fakeClaude({ script: [
    { out: { type: "system", subtype: "task_started", task_id: "fg", description: "foreground agent", is_backgrounded: false } },
    claudeResult(),
  ] });
  const { agent, events } = claudeAgent(bin, undefined, { commandSettleMs: 20 });
  await agent.send({ text: "foreground" }); expect(of(events, "run_complete")).toHaveLength(1); await agent.stop();
});

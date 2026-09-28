/**
 * Warm sessions: Codex and Claude Code through ProviderAgent, against the
 * protocol fakes. What matters here is what the per-turn adapters could not
 * do — one harness process across turns, a session per chat, an in-session
 * model switch, resume after a restart — and that Brain's rule (a continuity
 * turn owns its process group) still holds.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, CodexAdapter, stopAllProviderSessions } from "../../src/providers/agent.js";
import { readProjectState, writeProjectState } from "../../src/core/registry.js";
import { MAIN_CHAT, type AdapterEvent } from "../../src/types.js";
import type { LiveDelta } from "../../src/providers/ingestion.js";
import { makeProjectDir } from "../helpers.js";
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

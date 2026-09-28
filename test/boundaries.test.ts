import { describe, expect, it, vi } from "vitest";
import { AgentStateStore } from "../src/core/agent-state.js";
import { ConversationStore } from "../src/core/conversations.js";
import { EventLog } from "../src/core/eventlog.js";
import { Brain } from "../src/core/brain.js";
import { extractFromTurn } from "../src/core/brain-extract.js";
import { readProjectState, writeProjectState } from "../src/core/registry.js";
import { RuntimeAgents } from "../src/daemon/runtime/agents.js";
import { ClientDelivery, type ClientScope } from "../src/daemon/delivery.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class ControlledAgent extends EchoAdapter {
  readonly starting = deferred<void>();
  readonly stopping = deferred<void>();
  startCalls = 0;
  stopCalls = 0;
  constructor(id = "agent") { super(id, "echo", tmpDir("boundary-agent")); }
  override async start() { this.startCalls++; await this.starting.promise; }
  override async stop() { this.stopCalls++; await this.stopping.promise; }
  publish(event: AdapterEvent) { this.emit(event); }
}

const message: AdapterEvent = { kind: "message", payload: { text: "late reply" } };

describe("agent instance ownership", () => {
  it("shares startup, detaches retired events and waits for stop before starting a replacement", async () => {
    const agents = new RuntimeAgents();
    const old = new ControlledAgent();
    const replacement = new ControlledAgent();
    const seen: AdapterEvent[] = [];
    agents.install(old, (e) => seen.push(e));
    const first = agents.start(old.id);
    const second = agents.start(old.id);
    await Promise.resolve();
    expect(old.startCalls).toBe(1);
    old.starting.resolve();
    expect(await first).toBe(old);
    expect(await second).toBe(old);
    old.publish(message);
    agents.install(replacement, (e) => seen.push(e));
    old.publish(message);
    expect(seen).toHaveLength(1);
    const next = agents.start(replacement.id);
    await Promise.resolve();
    expect(replacement.startCalls).toBe(0);
    old.stopping.resolve();
    replacement.starting.resolve();
    expect(await next).toBe(replacement);
    expect(old.stopCalls).toBe(1);
    expect(replacement.startCalls).toBe(1);
    replacement.stopping.resolve();
    await agents.close();
    replacement.publish(message);
    expect(seen).toHaveLength(1);
    expect(agents.agents.size).toBe(0);
  });

  it("waits for an in-flight start at shutdown and never returns a retired instance", async () => {
    const agents = new RuntimeAgents();
    const agent = new ControlledAgent();
    agents.install(agent, () => {});
    const started = expect(agents.start(agent.id)).rejects.toThrow(/replaced/);
    await Promise.resolve();
    const closed = agents.close();
    agent.starting.resolve();
    agent.stopping.resolve();
    await started;
    await closed;
    expect(agent.stopCalls).toBe(1);
    await expect(agents.start(agent.id)).rejects.toThrow(/no longer active/);
    await agents.close();
    expect(agent.stopCalls).toBe(1);
  });

  it("allows a failed startup to retry", async () => {
    const agents = new RuntimeAgents();
    const agent = new ControlledAgent();
    const start = vi.spyOn(agent, "start").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    agents.install(agent, () => {});
    await expect(agents.start(agent.id)).rejects.toThrow("offline");
    expect(await agents.start(agent.id)).toBe(agent);
    expect(start).toHaveBeenCalledTimes(2);
    agent.stopping.resolve();
    await agents.close();
  });
});

describe("independent conversation and native state ownership", () => {
  it("preserves legacy resume data and unrelated state across interleaved updates", () => {
    const dir = tmpDir("boundary-state");
    writeProjectState(dir, { holder: "claude", agents: { claude: { sessionId: "legacy", custom: true } } });
    const claude = new AgentStateStore(dir, "claude");
    const codex = new AgentStateStore(dir, "codex");
    const chats = new ConversationStore(dir);
    expect(claude.read().sessionId).toBe("legacy");
    const chat = chats.createChat("  design  ", { agentId: "claude" });
    codex.patch({ sessionId: "thread-codex" });
    claude.patch({ sessionId: "next", servePid: 42 });
    chats.renameChat(chat.id, "revised");
    claude.patch({ servePid: undefined });
    expect(readProjectState(dir)).toMatchObject({
      holder: "claude", agents: { claude: { sessionId: "next", custom: true }, codex: { sessionId: "thread-codex" } },
      chats: [{ id: chat.id, title: "revised", agentId: "claude" }],
    });
    expect(claude.read()).not.toHaveProperty("servePid");
    expect(chats.chats()[0]?.id).toBe("main");
    expect(chats.deleteChat("main")).toBe(false);
    expect(chats.renameChat("main", "renamed")).toBeNull();
    expect(() => chats.setChatAgent("main", "codex")).toThrow(/follows the baton/);
  });

  it("removing a chat preserves the transcript and native sessions", async () => {
    const dir = tmpDir("boundary-history");
    const log = await EventLog.open(dir);
    const chats = new ConversationStore(dir);
    const native = new AgentStateStore(dir, "claude");
    const chat = chats.createChat("keep the evidence");
    native.patch({ sessionId: "native-id" });
    log.append({ kind: "message", chat: chat.id, payload: { author: "user", text: "small decision" } });
    expect(chats.deleteChat(chat.id)).toBe(true);
    expect(chats.deleteChat(chat.id)).toBe(false);
    expect(log.list({ chat: chat.id })[0]?.payload.text).toBe("small decision");
    expect(native.read().sessionId).toBe("native-id");
    log.close();
  });
});

describe("Brain lifetime", () => {
  it("discards a helper response after cancellation before accessing closed storage", async () => {
    const log = await EventLog.open(tmpDir("boundary-brain"));
    const brain = new Brain(log);
    const answer = deferred<string>();
    const lifetime = new AbortController();
    const result = extractFromTurn(brain, "Use SQLite for durable conversation history.", {
      agentId: "agent", signal: lifetime.signal, engine: () => answer.promise,
    });
    lifetime.abort();
    brain.close();
    log.close();
    answer.resolve(JSON.stringify({ ops: [{ op: "ADD", kind: "decision", text: "Use SQLite.", evidence: "Use SQLite for durable conversation history." }] }));
    expect(await result).toEqual({ added: [], updated: [], forgotten: [], dropped: [] });
  });
});

class Client {
  readyState = 1;
  frames: unknown[] = [];
  send(frame: string, callback?: (error?: Error) => void) { this.frames.push(JSON.parse(frame)); callback?.(); }
}

describe("client delivery", () => {
  it("applies project, log and admin scopes consistently", () => {
    const admin = new Client(), a = new Client(), b = new Client(), watchingB = new Client(), closed = new Client();
    closed.readyState = 3;
    const clients = new Map<Client, ClientScope>([
      [admin, {}], [a, { scope: ["a"] }], [b, { scope: ["b"] }],
      [watchingB, { project: "b" }], [closed, {}],
    ]);
    const delivery = new ClientDelivery(clients);
    delivery.publish({ type: "event" }, { kind: "project", projectId: "a" });
    delivery.publish({ type: "team" }, { kind: "admin" });
    delivery.publish({ type: "log" }, { kind: "log", projectId: "a" });
    delivery.publish({ type: "daemon-log" }, { kind: "log" });
    expect(admin.frames).toHaveLength(4);
    expect(a.frames).toEqual([{ type: "event" }, { type: "log" }]);
    expect(b.frames).toEqual([]);
    expect(watchingB.frames).toEqual([{ type: "team" }, { type: "log" }, { type: "daemon-log" }]);
    expect(closed.frames).toEqual([]);
  });

  it("isolates synchronous and asynchronous send failures from healthy clients", () => {
    const broken = new Client(), asyncBroken = new Client(), healthy = new Client();
    vi.spyOn(broken, "send").mockImplementation(() => { throw new Error("closed"); });
    let fail!: (error?: Error) => void;
    vi.spyOn(asyncBroken, "send").mockImplementation((_frame, callback) => { fail = callback!; });
    const failures = vi.fn(() => { throw new Error("diagnostic failed"); });
    const delivery = new ClientDelivery(new Map([[broken, {}], [asyncBroken, {}], [healthy, {}]]), failures);
    delivery.publish({ type: "event", id: 1 }, { kind: "project", projectId: "a" });
    fail(new Error("disconnected"));
    delivery.publish({ type: "event", id: 2 }, { kind: "project", projectId: "a" });
    expect(failures).toHaveBeenCalledTimes(3);
    expect(healthy.frames).toEqual([{ type: "event", id: 1 }, { type: "event", id: 2 }]);
  });
});

describe("runtime dispatch ownership", () => {
  it("records startup failure in its chat and allows the next prompt to run", async () => {
    const { ProjectRuntime } = await import("../src/daemon/runtime.js");
    const { makeProjectDir, waitUntil } = await import("./helpers.js");
    vi.stubEnv("LOOM_HOME", tmpDir("boundary-home"));
    vi.stubEnv("LOOM_NO_NOTIFY", "1");
    const dir = makeProjectDir({ name: "dispatch", brain: { extractor: "off" }, agents: [{ id: "echo", kind: "echo", role: "executor" }] });
    const rt = await ProjectRuntime.open({ id: "dispatch", name: "dispatch", dir });
    try {
      const agent = rt.agent("echo");
      const start = vi.spyOn(agent, "start").mockRejectedValueOnce(new Error("startup failed"));
      const chat = rt.createChat("fail here", { agentId: "echo" });
      await expect(rt.sendMessage("first", undefined, { chat: chat.id })).rejects.toThrow("startup failed");
      expect(rt.log.list({ chat: chat.id, kinds: ["error"] })[0]?.payload.message).toBe("startup failed");
      const second = await rt.sendMessage("second", undefined, { chat: chat.id });
      expect(second.queued).toBeUndefined();
      await waitUntil(async () => rt.log.list({ chat: chat.id, kinds: ["run_complete"] }).length === 1);
      expect(start).toHaveBeenCalledTimes(2);
    } finally { await rt.close(); vi.unstubAllEnvs(); }
  });

  it("refuses replacement while a turn is preparing and starts a later replacement exactly once", async () => {
    const { ProjectRuntime } = await import("../src/daemon/runtime.js");
    const { makeProjectDir, waitUntil } = await import("./helpers.js");
    vi.stubEnv("LOOM_HOME", tmpDir("boundary-home"));
    vi.stubEnv("LOOM_NO_NOTIFY", "1");
    const dir = makeProjectDir({ name: "replacement", brain: { extractor: "off" }, agents: [{ id: "echo", kind: "echo", role: "executor" }] });
    const rt = await ProjectRuntime.open({ id: "replacement", name: "replacement", dir });
    const ready = deferred<void>();
    try {
      const old = rt.agent("echo");
      vi.spyOn(old, "start").mockImplementation(() => ready.promise);
      const pending = rt.sendMessage("first");
      expect(() => rt.setAgentModel("echo", "new-model")).toThrow(/mid-turn/);
      ready.resolve();
      await pending;
      await waitUntil(async () => rt.log.list({ kinds: ["run_complete"] }).length === 1);
      rt.setAgentModel("echo", "new-model");
      const replacement = rt.agent("echo");
      expect(replacement).not.toBe(old);
      const start = vi.spyOn(replacement, "start");
      await rt.sendMessage("second");
      await waitUntil(async () => rt.log.list({ kinds: ["run_complete"] }).length === 2);
      expect(start).toHaveBeenCalledOnce();
    } finally { ready.resolve(); await rt.close(); vi.unstubAllEnvs(); }
  });
});

describe("optional semantic retrieval lifecycle", () => {
  it("ignores loading results after disable or close", async () => {
    const { RuntimeBriefings } = await import("../src/daemon/runtime/briefings.js");
    const { buildProjection } = await import("../src/core/projection.js");
    const dir = tmpDir("boundary-semantic");
    const log = await EventLog.open(dir);
    const brain = new Brain(log);
    const ready = deferred<boolean>();
    const index = { start: () => ready.promise, sync: vi.fn(async () => 0), query: vi.fn(async () => null), byId: () => new Map() };
    const briefings = new RuntimeBriefings({
      info: { id: "project", name: "project", dir }, config: { name: "project", agents: [] },
      brain, log, teamBrain: null, turnChat: new Map(), activeSkillsBlock: () => "",
      extractionEngine: () => async () => "", createSemanticIndex: () => index,
      renderProjection: async (input) => ({ content: buildProjection(input), mode: "template" }),
    });
    const loading = briefings.configureSemantic(true);
    await briefings.configureSemantic(false);
    ready.resolve(true);
    await loading;
    expect(index.sync).not.toHaveBeenCalled();
    expect(await briefings.denseFor("a query")).toBeNull();
    briefings.close();
    brain.close();
    log.close();
    await briefings.configureSemantic(true);
    expect(index.sync).not.toHaveBeenCalled();
    await expect(briefings.prepareHandoff("a", null, "", [])).rejects.toThrow(/closed/);
  });
});

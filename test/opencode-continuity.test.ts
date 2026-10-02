/**
 * OpenCode as a provider driver: native continuity, approvals, questions,
 * compaction, rollback and its model catalogue.
 *
 * The real ProviderAgent, OpenCode adapter and ContinuityEngine run against a
 * fake `opencode serve` (test/opencode-fake.ts) whose endpoints and events
 * follow opencode 1.18 (recorded from 1.18.31, checked against 1.18.34's
 * /doc). Only the model is faked.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { ContinuityEngine } from "../src/core/continuity/engine.js";
import { NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing } from "../src/core/continuity/contracts.js";
import { HarnessMonitor, isNativeKind } from "../src/core/continuity/capabilities.js";
import { ProviderAgent, stopAllProviderSessions } from "../src/providers/agent.js";
import { OpenCodeProviderAdapter, opencodeId, parseModelRef, pickDefaultModel, toOpenCodeAnswers } from "../src/providers/opencode/adapter.js";
import { opencodeDriver } from "../src/providers/drivers/opencode.js";
import { providerRegistry } from "../src/providers/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { LoomEvent } from "../src/types.js";
import type { ProviderRuntimeEvent } from "../src/providers/contracts.js";
import { makeProjectDir, waitUntil } from "./helpers.js";
import { fakeOpenCode, type FakeOpenCode, type FakeOpenCodeOptions } from "./opencode-fake.js";

const open: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => {
  await stopAllProviderSessions();
  for (const item of open.splice(0).reverse()) await item.close();
});

async function setup(fakeOpts: FakeOpenCodeOptions = {}) {
  const dir = makeProjectDir(), log = await EventLog.open(path.join(dir, ".loom")); open.push(log);
  const server = await fakeOpenCode(fakeOpts); open.push(server);
  return { dir, log, brain: new ContinuityEngine(log, "project"), server };
}
const request = (brain: ContinuityEngine, text = "continue", chat = "main") => brain.capture({
  id: crypto.randomUUID(), conversationId: chat, agentInstanceId: "oc", text, source: "user", model: null, plan: false, targetAddedTokens: 6000 }).request;

/** One continuity turn through the provider agent; returns the packet and what was logged. */
async function turn(brain: ContinuityEngine, log: EventLog, dir: string, server: FakeOpenCode, text: string, options: Record<string, unknown> = {}) {
  const req = request(brain, text);
  const opts = { baseUrl: server.url, pollMs: 20, ...options };
  const prepared = await brain.prepare(req, "opencode", dir, opts);
  const continuity = await brain.submit(prepared);
  const agent = new ProviderAgent("oc", "opencode", dir, opts);
  const events: LoomEvent[] = [];
  agent.onEvent((e) => {
    const logged = log.append({ ...e, agentId: "oc", chat: req.conversationId });
    events.push(logged);
    brain.ingest(logged);
  });
  let error: unknown;
  try { await agent.send({ text, continuity, chat: req.conversationId }); }
  catch (err) { error = err; }
  brain.settled(continuity.runId, error);
  const during = [...events];
  await agent.stop().catch(() => {});
  return { prepared, events: during, error, receipt: brain.store.receipts(req.id).at(-1)! };
}

const prompted = (server: FakeOpenCode) => server.prompts.map((p) => p.session);

describe("OpenCode native continuity", () => {
  it("is a registered native driver", () => {
    expect(isNativeKind("opencode")).toBe(true);
    expect(providerRegistry.get("opencode")?.continuity.supported).toBe(true);
  });

  it("starts a session, reports it, and is accepted on admission", async () => {
    const { dir, log, brain, server } = await setup({ reply: "pong" });
    const { prepared, events, error, receipt } = await turn(brain, log, dir, server, "Reply with pong");
    expect(error).toBeUndefined();
    expect(server.created).toHaveLength(1);
    expect(server.created[0]!.body.location).toEqual({ directory: dir });
    const session = server.prompts[0]!.session;
    expect(events.find((e) => e.kind === "status" && e.payload.state === "turn_started")!.payload.session).toBe(session);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "native_turn_accepted")).toBe(true);
    // the packet rides in front of the prompt, the request text last
    expect(server.prompts[0]!.text).toContain(prepared.rendered.text);
    expect(server.prompts[0]!.text.endsWith("Reply with pong")).toBe(true);
    expect(events.find((e) => e.kind === "message")!.payload.text).toBe("pong");
    expect(events.filter((e) => e.kind === "message" || e.kind === "run_complete").every((e) => e.payload.loomRunId === receipt.runId)).toBe(true);
    expect(receipt).toMatchObject({ status: "accepted", execution: "complete" });
    expect(brain.store.bindingById(prepared.packet.target.id)!.nativeSessionId).toBe(session);
  });

  it("resumes the bound session with only what it lacks", async () => {
    const { dir, log, brain, server } = await setup();
    const first = await turn(brain, log, dir, server, "Use SQLite for the store");
    const second = await turn(brain, log, dir, server, "Now add an index");
    expect(second.prepared.packet.mode).toBe("delta");
    expect(prompted(server)).toEqual([prompted(server)[0], prompted(server)[0]]);
    expect(server.created).toHaveLength(1);
    expect(second.prepared.packet.target.id).toBe(first.prepared.packet.target.id);
    expect(second.receipt).toMatchObject({ status: "accepted", execution: "complete" });
  });

  it("switches the session's model in place rather than starting over", async () => {
    const { dir, log, brain, server } = await setup();
    await turn(brain, log, dir, server, "first", { model: "opencode/big-pickle" });
    await turn(brain, log, dir, server, "second", { model: "opencode/other-free" });
    const session = server.prompts[0]!.session;
    expect(server.prompts[1]!.session).toBe(session);
    expect(server.modelSwitches).toEqual([{ session, model: { providerID: "opencode", id: "other-free" } }]);
  });

  it("a session opencode forgot is NativeSessionMissing, and the next turn rebuilds in a new one", async () => {
    const { dir, log, brain, server } = await setup();
    const first = await turn(brain, log, dir, server, "Remember: tabs, not spaces");
    const session = server.prompts[0]!.session;
    server.forget(session);
    const lost = await turn(brain, log, dir, server, "carry on");
    expect(lost.error).toBeInstanceOf(NativeSessionMissing);
    expect(server.prompts).toHaveLength(1); // nothing was sent to a session that isn't there
    expect(lost.receipt).toMatchObject({ status: "failed" });
    expect(brain.store.bindingById(first.prepared.packet.target.id)).toMatchObject({ nativeSessionId: null, sessionEpoch: 2 });
    const rebuilt = await turn(brain, log, dir, server, "carry on");
    expect(rebuilt.prepared.packet.mode).toBe("reconstruction");
    expect(rebuilt.prepared.rendered.text).toContain("tabs, not spaces");
    expect(server.prompts.at(-1)!.session).not.toBe(session);
    expect(rebuilt.receipt).toMatchObject({ status: "accepted", execution: "complete" });
  });

  it("a refused prompt is a proven non-launch, and leaves no writer lease behind", async () => {
    const { dir, log, brain, server } = await setup({ refusePrompt: 500 });
    const refused = await turn(brain, log, dir, server, "try");
    expect(refused.error).toBeInstanceOf(NativeDispatchRejected);
    expect(refused.receipt).toMatchObject({ status: "failed", execution: "failed" });
    server.opts.refusePrompt = undefined;
    const next = await turn(brain, log, dir, server, "try again");
    expect(next.receipt).toMatchObject({ status: "accepted", execution: "complete" });
  });

  it("a session opencode still lists as active is accepted but its quiescence is unknown", async () => {
    const { dir, log, brain, server } = await setup({ stuck: true });
    const stuck = await turn(brain, log, dir, server, "long job", { turnTimeoutMs: 300 });
    expect(stuck.error).toBeInstanceOf(NativeQuiescenceUnknown);
    expect(stuck.receipt).toMatchObject({ status: "accepted", execution: "unknown" });
  });

  it("a failed turn is accepted work that failed, with the provider's reason", async () => {
    const { dir, log, brain, server } = await setup({ fail: "Model is unavailable" });
    const failed = await turn(brain, log, dir, server, "go");
    expect(failed.events.find((e) => e.kind === "error")!.payload.message).toBe("Model is unavailable");
    expect(failed.receipt).toMatchObject({ status: "accepted", execution: "failed" });
  });

  it("reports tool calls, usage and compaction, and a compacted session gets a full rebuild next", async () => {
    const { dir, log, brain, server } = await setup({ compact: true, tool: { tool: "bash", input: { command: "npm test", description: "Run tests" } },
      tokens: { input: 1200, output: 40, reasoning: 10, cache: { read: 300, write: 0 } } });
    const first = await turn(brain, log, dir, server, "run the tests");
    expect(first.events.find((e) => e.kind === "tool_call")!.payload).toMatchObject({ tool: "shell", summary: "shell: npm test", loomRunId: first.receipt.runId });
    expect(first.events.filter((e) => e.kind === "status" && e.payload.state === "native_compacted")).toHaveLength(1);
    expect(first.events.find((e) => e.kind === "status" && e.payload.state === "context_usage")!.payload).toMatchObject({ usedTokens: 1550, maxTokens: 200000 });
    expect(first.events.find((e) => e.kind === "run_complete")!.payload).toMatchObject({ inputTokens: 1500, outputTokens: 50 });
    expect(brain.store.bindingById(first.prepared.packet.target.id)!.retention).toBe("compacted");
    server.opts.compact = false;
    const next = await turn(brain, log, dir, server, "and now?");
    expect(next.prepared.packet.mode).toBe("reconstruction");
    expect(server.prompts[1]!.session).toBe(server.prompts[0]!.session); // same session, rebuilt state
  });

  it("probes an opencode agent pointed at a running server by that server's health", async () => {
    const server = await fakeOpenCode(); open.push(server);
    const monitor = new HarnessMonitor(() => [{ id: "oc", kind: "opencode", options: { baseUrl: server.url } }]);
    expect(await monitor.ensure("oc")).toMatchObject({ kind: "opencode", available: true });
    await server.close(); open.pop();
    const down = new HarnessMonitor(() => [{ id: "oc", kind: "opencode", options: { baseUrl: server.url } }]);
    expect(await down.ensure("oc")).toMatchObject({ available: false });
  });
});

/** The adapter on its own, for what continuity doesn't cover. */
async function adapterOn(server: FakeOpenCode, dir = makeProjectDir()) {
  const adapter = new OpenCodeProviderAdapter("oc", { baseUrl: server.url, pollMs: 20 });
  open.push({ close: () => adapter.stopAll() });
  const events: ProviderRuntimeEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const session = await adapter.startSession({ threadId: "main", instanceId: "oc", cwd: dir, runtimeMode: "auto-accept-edits" });
  const ended = (turnId: string) => waitUntil(() => events.some((e) => e.turnId === turnId && (e.type === "turn.completed" || e.type === "turn.aborted")), { timeoutMs: 5000 });
  return { adapter, events, session, ended };
}

describe("OpenCode adapter", () => {
  it("uses its own message id as the turn id, so the turn is known before the server answers", async () => {
    const server = await fakeOpenCode(); open.push(server);
    const { adapter, events, ended } = await adapterOn(server);
    const { turnId } = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "hi" });
    expect(turnId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    await ended(turnId);
    expect(server.sessions.get(server.prompts[0]!.session)!.messages[0]!.id).toBe(turnId);
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ turnId, payload: { state: "completed" } });
  });

  it("streams only its own session's text", async () => {
    const server = await fakeOpenCode({ reply: "Warp threads" }); open.push(server);
    const { adapter, events, ended } = await adapterOn(server);
    const { turnId } = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "hi" });
    await ended(turnId);
    const deltas = events.filter((e) => e.type === "content.delta");
    expect(deltas.map((e) => (e.payload as { delta: string }).delta).join("")).toBe("Warp threads");
    expect(deltas.every((e) => e.turnId === turnId)).toBe(true);
  });

  it("puts a permission request to Loom and sends the answer back", async () => {
    const server = await fakeOpenCode({ ask: { action: "bash", resources: ["rm -rf build"] } }); open.push(server);
    const { adapter, events, ended } = await adapterOn(server);
    const { turnId } = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "clean up" });
    await waitUntil(() => events.some((e) => e.type === "request.opened"));
    const asked = events.find((e) => e.type === "request.opened")!;
    expect(asked.payload).toMatchObject({ requestType: "command_execution_approval", detail: "bash: rm -rf build" });
    await adapter.respondToRequest("main", asked.requestId!, "acceptForSession");
    await ended(turnId);
    expect(server.replies).toEqual([expect.objectContaining({ kind: "permission", request: asked.requestId, body: { reply: "always" } })]);
  });

  it("asks OpenCode's question in Loom and answers it in OpenCode's shape", async () => {
    const server = await fakeOpenCode({ question: { question: "Which database?", header: "Database", options: [{ label: "SQLite", description: "file" }, { label: "Postgres", description: "server" }] } });
    open.push(server);
    const { adapter, events, ended } = await adapterOn(server);
    const { turnId } = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "set up storage" });
    await waitUntil(() => events.some((e) => e.type === "user-input.requested"));
    const asked = events.find((e) => e.type === "user-input.requested")!;
    expect(asked.payload).toMatchObject({ questions: [{ id: "0", header: "Database", question: "Which database?", allowCustomAnswer: true,
      options: [{ label: "SQLite", description: "file" }, { label: "Postgres", description: "server" }] }] });
    await adapter.respondToUserInput("main", asked.requestId!, { 0: "SQLite" });
    await ended(turnId);
    expect(server.replies).toEqual([expect.objectContaining({ kind: "question", body: { answers: [["SQLite"]] } })]);
  });

  it("an interrupt answers open requests and ends the turn as interrupted", async () => {
    const server = await fakeOpenCode({ ask: { action: "edit", resources: ["src/a.ts"] } }); open.push(server);
    const { adapter, events, ended } = await adapterOn(server);
    const { turnId } = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "edit" });
    await waitUntil(() => events.some((e) => e.type === "request.opened"));
    await adapter.interruptTurn("main", turnId);
    await ended(turnId);
    expect(server.interrupts).toHaveLength(1);
    expect(server.replies[0]).toMatchObject({ kind: "permission", body: { reply: "reject" } });
    expect(events.find((e) => e.type === "turn.completed")!.payload).toMatchObject({ state: "interrupted" });
  });

  it("compacts on request and reports it done", async () => {
    const server = await fakeOpenCode(); open.push(server);
    const { adapter, events } = await adapterOn(server);
    await adapter.compact("main");
    await waitUntil(() => events.some((e) => e.type === "thread.state.changed"));
    expect(events.find((e) => e.type === "thread.state.changed")!.payload).toMatchObject({ state: "compacted", trigger: "manual" });
  });

  it("rolls the conversation back to before a turn, leaving the files to Loom's checkpoints", async () => {
    const server = await fakeOpenCode(); open.push(server);
    const { adapter, ended } = await adapterOn(server);
    const first = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "one" });
    await ended(first.turnId);
    const second = await adapter.sendTurn({ threadId: "main", instanceId: "oc", input: "two" });
    await ended(second.turnId);
    expect(await adapter.validateRollback("main", second.turnId)).toEqual([first.turnId]);
    expect(await adapter.rollbackThread("main", second.turnId)).toEqual({ resumeCursor: server.prompts[0]!.session, live: true });
    expect(server.reverts).toEqual([{ session: server.prompts[0]!.session, messageID: second.turnId, files: false }]);
    // A retry after a lost acknowledgement finds the cut already made.
    expect(await adapter.rollbackThread("main", second.turnId, [first.turnId])).toMatchObject({ live: true });
    expect(server.reverts).toHaveLength(1);
  });
});

describe("OpenCode's catalogue, as OpenCode reports it", () => {
  it("lists every model with its provider, marks the free ones, and needs no sign-in", async () => {
    const server = await fakeOpenCode(); open.push(server);
    const probe = await opencodeDriver.probe!({ baseUrl: server.url }, makeProjectDir());
    expect(probe.auth).toEqual({ status: "signed-in", plan: "OpenCode Zen" });
    expect(probe.models).toEqual([
      { id: "opencode/big-pickle", name: "Big Pickle", provider: "OpenCode Zen" },
      { id: "opencode/other-free", name: "Other Free", provider: "OpenCode Zen" },
    ]);
  });

  it("parses model refs, picks a model the server can run, and maps answers", () => {
    expect(parseModelRef("opencode/minimax-m2.5")).toEqual({ providerID: "opencode", id: "minimax-m2.5" });
    expect(parseModelRef("nope")).toBeNull();
    expect(pickDefaultModel(["opencode/x", "opencode/big-pickle"])).toBe("opencode/big-pickle");
    expect(pickDefaultModel(["anthropic/claude", "opencode/glm-free"])).toBe("opencode/glm-free");
    expect(opencodeId("msg") < opencodeId("msg")).toBe(true);
    expect(toOpenCodeAnswers([{ id: "0", header: "H", question: "Q", options: [] }, { id: "1", header: "Pick", question: "Which?", options: [], multiSelect: true }],
      { 0: "yes", Pick: ["a", "b"] })).toEqual([["yes"], ["a", "b"]]);
  });
});

describe("OpenCode through the project runtime with continuity on", () => {
  it("sends a continuity turn to OpenCode instead of refusing it", async () => {
    const server = await fakeOpenCode({ reply: "from the runtime" }); open.push(server);
    const dir = makeProjectDir({
      brain: { continuity: true, extractor: "off" },
      agents: [{ id: "oc", kind: "opencode", options: { baseUrl: server.url, pollMs: 20 } }],
    });
    const rt = await ProjectRuntime.open({ id: `oc-${path.basename(dir)}`, name: "oc", dir });
    open.push(rt);
    const sent = await rt.sendMessage("hello opencode", "oc");
    expect(sent.continuityStatus).toBe("submitting");
    await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).some((e) => e.agentId === "oc"), { timeoutMs: 10_000 });
    const reply = rt.log.list({ kinds: ["message"] }).find((e) => e.agentId === "oc");
    expect(reply?.payload.text).toBe("from the runtime");
    await waitUntil(() => rt.continuity!.store.receipts().at(-1)?.execution === "complete", { timeoutMs: 10_000 });
    expect(rt.continuity!.store.receipts().at(-1)).toMatchObject({ status: "accepted", execution: "complete" });
  });
});

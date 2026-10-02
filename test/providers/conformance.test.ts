/** Every built-in runs the same semantic scenarios; only native fixture dialects differ. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInDrivers } from "../../src/providers/builtInDrivers.js";
import { providerRegistry } from "../../src/providers/registry.js";
import { ProviderAgent, stopAllProviderSessions } from "../../src/providers/agent.js";
import type { ProviderInstance } from "../../src/providers/driver.js";
import type { ProviderRuntimeEvent } from "../../src/providers/contracts.js";
import { RuntimeIngestion, type IngestedEvent } from "../../src/providers/ingestion.js";
import { NativeQuiescenceUnknown } from "../../src/providers/settlement.js";
import * as processes from "../../src/providers/process.js";
import { makeProjectDir, waitUntil } from "../helpers.js";
import { CLAUDE_OK, CODEX_OK, claudeResult, claudeText, codexDone, codexNotify, fakeClaude, fakeCodex, stdinOf, type Step } from "../native-fakes.js";

interface Fixture {
  make(script?: Step[]): string;
  ok: Step[];
  refusal(): string;
  closeSubmission?(instance: ProviderInstance): void;
  writer(kind: "command" | "child", finish: boolean): Step[];
  compact: Step[];
  history?(bin: string): Record<string, unknown>;
}
const started = codexNotify("turn/started", { turn: { id: "$TURN" } });
const fixtures: Record<string, Fixture> = {
  codex: {
    make: script => fakeCodex({ ...(script ? { script } : {}) }), ok: CODEX_OK, refusal: () => fakeCodex({ refuseTurn: "refused" }),
    writer(kind, finish) {
      const open = kind === "child" ? codexNotify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } })
        : codexNotify("item/started", { item: { id: "cmd", type: "commandExecution", command: "write", status: "inProgress" } });
      const close = kind === "child" ? codexNotify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } })
        : codexNotify("item/completed", { item: { id: "cmd", type: "commandExecution", command: "write", status: "completed", exitCode: 0 } });
      return [started, open, codexDone(), ...(finish ? [{ sleep: 120 }, close] : [])];
    }, compact: CODEX_OK,
  },
  "claude-code": {
    make: script => fakeClaude({ ...(script ? { script } : {}) }), ok: CLAUDE_OK, refusal: () => fakeClaude(),
    closeSubmission(instance) { (instance.adapter as unknown as { sessions: Map<string, { prompts: { close(): void } }> }).sessions.get("main")!.prompts.close(); },
    writer(kind, finish) {
      const open = kind === "child" ? { out: { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "child", task_type: "local_agent", description: "writes" }] } }
        : { out: { type: "assistant", message: { content: [{ type: "tool_use", id: "cmd", name: "Bash", input: { command: "write" } }] }, parent_tool_use_id: null } };
      const close = kind === "child" ? { out: { type: "system", subtype: "background_tasks_changed", tasks: [] } }
        : { out: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cmd", content: "finished" }] }, parent_tool_use_id: null } };
      return [open, claudeResult(), ...(finish ? [{ sleep: 120 }, close] : [])];
    },
    compact: [{ out: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000 }, session_id: "$SESSION" } }, claudeResult()],
    history(bin) {
      const snapshots = new Map<string, Array<{ type: string; uuid: string; message: unknown }>>();
      const messages = async (session: string) => snapshots.get(session) ?? stdinOf(bin).filter(m => m.type === "user" && typeof m.uuid === "string")
        .flatMap(m => [{ type: "user", uuid: String(m.uuid), message: m.message }, { type: "assistant", uuid: `reply-${String(m.uuid)}`, message: { content: "reply" } }]);
      return { claudeHistory: { messages, fork: async (session: string, _cwd: string, before: string) => {
        const list = await messages(session), id = crypto.randomUUID(); snapshots.set(id, list.slice(0, list.findIndex(m => m.uuid === before) + 1)); return { sessionId: id };
      } } };
    },
  },
};
const dispose: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of dispose.splice(0).reverse()) await stop(); await stopAllProviderSessions(); });
const tags = { loomRunId: "run", loomBindingId: "binding", loomSessionEpoch: 1 };
const continuity = { runId: "run", bindingId: "binding", sessionEpoch: 1, nativeSessionId: null, context: "context" };

for (const driver of builtInDrivers) describe(`${driver.metadata.displayName} adapter conformance`, () => {
  const fixture = fixtures[driver.kind]!;
  async function instance(script?: Step[], binary?: string) {
    const bin = binary ?? fixture.make(script), dir = makeProjectDir();
    const value = await providerRegistry.create(driver.kind, "agent", { bin, ...fixture.history?.(bin) }, { cwd: dir, canAsk: () => false, mcpServers: () => [] });
    dispose.push(() => value.dispose());
    const events: ProviderRuntimeEvent[] = []; value.adapter.onEvent(e => events.push(e));
    await value.adapter.startSession({ instanceId: "agent", threadId: "main", cwd: dir, runtimeMode: "auto-accept-edits" });
    return { value, bin, dir, events };
  }
  function agent(script?: Step[], options: Record<string, unknown> = {}) {
    const bin = fixture.make(script), value = new ProviderAgent("agent", driver.kind, makeProjectDir(), { bin, ...fixture.history?.(bin), ...options });
    dispose.push(() => value.stop()); return { value, bin };
  }
  it("distinguishes native acceptance from local turn allocation", async () => {
    const { value, events } = await instance([{ sleep: 120 }, ...fixture.ok]);
    const out: IngestedEvent[] = [], ingestion = new RuntimeIngestion({ append: event => out.push(event) });
    ingestion.tagTurn("main", "agent", tags); value.adapter.onEvent(e => ingestion.ingest(e));
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "work" });
    if (events.some(e => e.type === "turn.started" && e.payload.local))
      expect(out.some(e => e.payload.state === "native_turn_accepted")).toBe(false);
    await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    expect(out.filter(e => e.payload.state === "native_turn_accepted")).toHaveLength(1);
    expect(events.filter(e => e.turnId).every(e => e.turnId === turn.turnId)).toBe(true);
  });
  it("proves submission refusal without claiming native acceptance", async () => {
    const { value, events } = await instance(undefined, fixture.refusal());
    fixture.closeSubmission?.(value);
    await expect(value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "rejected" })).rejects.toMatchObject({ notSubmitted: true });
    expect(events.some(e => e.type === "turn.accepted" || e.type === "turn.started" && !e.payload.local)).toBe(false);
  });
  it("preserves late-event correlation when the next turn is tagged", async () => {
    const { value, events } = await instance();
    const out: IngestedEvent[] = [], ingestion = new RuntimeIngestion({ append: event => out.push(event) });
    ingestion.tagTurn("main", "agent", tags); value.adapter.onEvent(e => ingestion.ingest(e));
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "work" });
    await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    ingestion.tagTurn("main", "agent", { ...tags, loomRunId: "next" });
    const before = out.length;
    // A fresh late item on the completed native turn must not acquire next's tags.
    const item = events.find(e => e.type === "item.completed" && e.turnId === turn.turnId)!;
    ingestion.ingest({ ...item, eventId: crypto.randomUUID(), itemId: "late-item" });
    expect(out).toHaveLength(before);
  });
  it.each(["command", "child"] as const)("waits for %s writers after the main turn ends", async kind => {
    const { value } = agent(fixture.writer(kind, true), { commandSettleMs: 1000 });
    const start = Date.now(); await value.send({ text: "work", continuity });
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
    expect(value.busy()).toBe(false);
  });
  it.each(["command", "child"] as const)("keeps uncertainty for an unfinished %s and gives Stop a recovery path", async kind => {
    const { value } = agent(fixture.writer(kind, false), { commandSettleMs: 20 });
    await expect(value.send({ text: "work", continuity })).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
    expect(value.busy()).toBe(true);
    await value.interrupt(); expect(value.busy()).toBe(false);
  });
  it("cancels active work and fences all session writers with Stop", async () => {
    const { value, events } = await instance([fixture.ok[0]!, { sleep: 10_000 }, ...fixture.ok.slice(1)]);
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "work" });
    await value.adapter.interruptTurn("main", turn.turnId);
    await value.adapter.stopSession("main");
    expect(value.adapter.hasSession("main")).toBe(false);
    expect(events.some(e => e.type === "session.exited")).toBe(true);
  });
  it("restarts and resumes the same native conversation", async () => {
    const { value, events, dir } = await instance();
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "one" });
    await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    const cursor = value.adapter.listSessions()[0]!.resumeCursor;
    await value.adapter.stopSession("main");
    const resumed = await value.adapter.startSession({ instanceId: "agent", threadId: "main", cwd: dir, runtimeMode: "auto-accept-edits", resumeCursor: cursor });
    expect(resumed.resumeCursor).toBe(cursor);
  });
  it("uses its advertised compaction strategy", async () => {
    const { value } = agent(fixture.compact);
    await value.send({ text: "work" });
    await value.compact();
    expect(value.busy()).toBe(false);
    expect(driver.capabilities.compaction.type).not.toBe("unsupported");
  });
  it("rolls back at a native turn boundary where supported", async () => {
    if (!driver.capabilities.supportsConversationRollback) return;
    const { value, events } = await instance();
    const turns: string[] = [];
    for (const input of ["one", "two"]) {
      const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input }); turns.push(turn.turnId);
      await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    }
    await value.adapter.validateRollback!("main", turns[1]!);
    const rolled = await value.adapter.rollbackThread!("main", turns[1]!);
    expect(rolled.resumeCursor).toBeTruthy();
  });
  it("retains handles when fencing cannot prove quiescence, so Stop can retry", async () => {
    const { value } = await instance();
    const stop = vi.spyOn(processes, "stopHarness").mockRejectedValueOnce(new NativeQuiescenceUnknown("fencing unavailable"));
    await expect(value.adapter.stopSession("main")).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
    expect(value.adapter.hasSession("main")).toBe(true);
    stop.mockRestore(); await value.adapter.stopSession("main");
    expect(value.adapter.hasSession("main")).toBe(false);
  });
});

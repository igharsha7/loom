/** Every built-in runs the same semantic scenarios; only native fixture dialects differ. */
import fs from "node:fs";
import path from "node:path";
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
import { CLAUDE_OK, CODEX_OK, OPENCODE_OK, claudeResult, claudeText, codexDone, codexNotify, fakeClaude, fakeCodex, fakeOpenCodeCli, opencodeDone, opencodeEvent, stdinOf, turnsOf, type Step } from "../native-fakes.js";

interface Fixture {
  make(script?: Step[]): string;
  ok: Step[];
  refusal(): string;
  closeSubmission?(instance: ProviderInstance): void;
  writer(kind: "command" | "child", finish: boolean): Step[];
  compact: Step[];
  late(): string;
  history?(bin: string): Record<string, unknown>;
  /** The native turns left after a rollback, when the driver isn't Codex or Claude. */
  rolledBack?(bin: string, cursor: string): string[];
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
    late: () => fakeCodex({ scripts: [
      [started, codexNotify("item/started", { item: { id: "late-tool", type: "commandExecution", command: "old", status: "inProgress" } }), codexDone(), { sleep: 300 },
        codexNotify("item/completed", { item: { id: "late-tool", type: "commandExecution", command: "old", status: "completed", exitCode: 0 } })],
      [started, { sleep: 600 }, codexDone()],
    ] }),
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
    late: () => fakeClaude({ scripts: [
      [{ out: { type: "assistant", message: { content: [{ type: "tool_use", id: "late-tool", name: "Bash", input: { command: "old" } }] }, parent_tool_use_id: null } },
        claudeResult(), { sleep: 300 }, { out: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "late-tool", content: "old result" }] }, parent_tool_use_id: null } }],
      [{ sleep: 600 }, ...CLAUDE_OK],
    ] }),
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
// OpenCode settles at turn level by itself: a session leaves /api/session/active
// only once every tool it ran has finished, so its writers stay inside the turn.
const tool = (id: string, kind: "command" | "child") => opencodeEvent("session.next.tool.called", { callID: id, tool: kind === "child" ? "task" : "bash", input: { command: "write", description: "writes" } });
const toolDone = (id: string) => opencodeEvent("session.next.tool.success", { callID: id, content: [{ type: "text", text: "finished" }] });
fixtures.opencode = {
  make: script => fakeOpenCodeCli({ ...(script ? { script } : {}) }), ok: OPENCODE_OK, refusal: () => fakeOpenCodeCli({ refusePrompt: 500 }),
  writer: (kind, finish) => finish ? [tool("cmd", kind), { sleep: 120 }, toolDone("cmd"), opencodeDone()] : [tool("cmd", kind)],
  compact: OPENCODE_OK,
  late: () => fakeOpenCodeCli({ scripts: [[tool("late-tool", "command"), opencodeDone(), { sleep: 300 }, toolDone("late-tool")], [{ sleep: 600 }, ...OPENCODE_OK]] }),
  history: () => ({ pollMs: 20, turnTimeoutMs: 1500 }),
  rolledBack(bin, cursor) {
    const sessions = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "sessions.json"), "utf8")) as Record<string, { messages: Array<{ id: string; type: string }> }>;
    return sessions[cursor]!.messages.filter(m => m.type === "user").map(m => m.id);
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
    const history = fixture.history?.(bin);
    const value = await providerRegistry.create(driver.kind, "agent", { bin, ...history }, { cwd: dir, canAsk: () => false, mcpServers: () => [] });
    dispose.push(() => value.dispose());
    const events: ProviderRuntimeEvent[] = []; value.adapter.onEvent(e => events.push(e));
    await value.adapter.startSession({ instanceId: "agent", threadId: "main", cwd: dir, runtimeMode: "auto-accept-edits" });
    return { value, bin, dir, events, history };
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
    const { value, events } = await instance(undefined, fixture.late());
    const out: IngestedEvent[] = [], ingestion = new RuntimeIngestion({ append: event => out.push(event) });
    ingestion.tagTurn("main", "agent", tags); value.adapter.onEvent(e => ingestion.ingest(e));
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "work" });
    await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    ingestion.tagTurn("main", "agent", { ...tags, loomRunId: "next" });
    const next = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "next" });
    await waitUntil(() => events.some(e => e.type === "item.completed" && e.itemId === "late-tool"));
    const late = events.find(e => e.type === "item.completed" && e.itemId === "late-tool")!;
    expect(late.turnId).toBe(turn.turnId);
    expect(late.turnId).not.toBe(next.turnId);
    expect(out.some(e => e.kind === "tool_call" && e.payload.loomRunId === "next")).toBe(false);
    await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === next.turnId));
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
    const marker = path.join(makeProjectDir(), "writer-heartbeat");
    const writer = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker + '.pid')}, String(process.pid)); setInterval(() => fs.appendFileSync(${JSON.stringify(marker)}, 'x'), 10);`;
    const { value, events, bin } = await instance([{ spawn: writer }, fixture.ok[0]!, { sleep: 10_000 }, ...fixture.ok.slice(1)]);
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "work" });
    await waitUntil(() => fs.existsSync(marker));
    const parent = turnsOf(bin)[0]!.pid, child = Number(fs.readFileSync(marker + ".pid", "utf8"));
    dispose.push(async () => { try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } });
    await value.adapter.interruptTurn("main", turn.turnId);
    await value.adapter.stopSession("main");
    expect(value.adapter.hasSession("main")).toBe(false);
    expect(events.some(e => e.type === "session.exited")).toBe(true);
    for (const pid of [parent, child]) {
      let failure: unknown;
      try { process.kill(pid, 0); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "ESRCH" });
    }
    const stopped = fs.readFileSync(marker, "utf8");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fs.readFileSync(marker, "utf8")).toBe(stopped);
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
    const { value, events, bin, history } = await instance();
    const turns: string[] = [];
    for (const input of ["one", "two"]) {
      const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input }); turns.push(turn.turnId);
      await waitUntil(() => events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    }
    await value.adapter.validateRollback!("main", turns[1]!);
    const rolled = await value.adapter.rollbackThread!("main", turns[1]!);
    expect(rolled.resumeCursor).toBeTruthy();
    if (fixture.rolledBack) {
      expect(fixture.rolledBack(bin, String(rolled.resumeCursor))).toEqual([turns[0]]);
    } else if (driver.kind === "codex") {
      const history = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), `${String(rolled.resumeCursor)}.history.json`), "utf8"));
      expect(history).toEqual([turns[0]]);
    } else {
      const actual = history!.claudeHistory as { messages(id: string): Promise<Array<{ uuid: string }>> };
      expect((await actual.messages(String(rolled.resumeCursor))).map(m => m.uuid)).toEqual([turns[0], `reply-${turns[0]}`]);
      expect(value.adapter.hasSession("main")).toBe(false);
    }
  });
  it("retains handles when fencing cannot prove quiescence, so Stop can retry", async () => {
    const marker = path.join(makeProjectDir(), "retry-writer");
    const writer = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 10);`;
    const { value, events } = await instance([{ spawn: writer }, ...fixture.ok]);
    const turn = await value.adapter.sendTurn({ instanceId: "agent", threadId: "main", input: "work" });
    await waitUntil(() => fs.existsSync(marker) && events.some(e => e.type === "turn.completed" && e.turnId === turn.turnId));
    const child = Number(fs.readFileSync(marker, "utf8"));
    dispose.push(async () => { try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } });
    const stop = vi.spyOn(processes, "stopHarness").mockRejectedValueOnce(new NativeQuiescenceUnknown("fencing unavailable"));
    await expect(value.adapter.stopSession("main")).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
    expect(value.adapter.hasSession("main")).toBe(true);
    expect(events.some(e => e.type === "session.exited")).toBe(false);
    expect(process.kill(child, 0)).toBe(true);
    stop.mockRestore(); await value.adapter.stopSession("main");
    expect(value.adapter.hasSession("main")).toBe(false);
    let failure: unknown;
    try { process.kill(child, 0); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "ESRCH" });
  });
});

/**
 * The Codex adapter, driven against a fake `codex app-server` (see
 * native-fakes.ts) that speaks the JSON-RPC the real one does: initialize,
 * thread/start or thread/resume, turn/start, then notifications until
 * turn/completed.
 *
 * The real CLI isn't used because a turn costs money and needs an account, and
 * because the interesting cases (a thread that's gone, a refused turn, a
 * process that dies mid-turn) are ones you can't ask a working CLI to produce.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, stopAllProviderSessions } from "../src/providers/agent.js";
import { setApprovalBroker, type ApprovalRequest } from "../src/core/approvals.js";
import { NativeDispatchRejected, NativeSessionMissing } from "../src/core/continuity/contracts.js";
import type { AdapterEvent, SendInput } from "../src/types.js";
import { makeProjectDir, waitUntil } from "./helpers.js";
import { CODEX_OK, codexDone, codexItem, codexMessage, codexNotify, codexTokens, fakeCodex, rpcOf, stdinOf,
  type FakeCodexOptions, type Step } from "./native-fakes.js";

// Provider sessions stay warm between turns; end them with the file.
afterAll(async () => { await stopAllProviderSessions(); });

afterEach(() => setApprovalBroker(null));

const started = codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } });
const turn = (...steps: Step[]): Step[] => [started, ...steps, codexTokens(52831, 44672, 120), codexDone()];

async function run(
  script: Step[],
  opts: Omit<FakeCodexOptions, "script"> = {},
  input: Partial<SendInput> = {},
  agentOptions: Record<string, unknown> = {},
  dir = makeProjectDir({ name: "cx" }),
): Promise<{ events: AdapterEvent[]; dir: string; bin: string; error?: Error }> {
  const bin = fakeCodex({ script, ...opts });
  const agent = new CodexAdapter("codex", dir, { bin, ...agentOptions });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  let error: Error | undefined;
  try {
    await agent.send({ text: "do it", ...input });
  } catch (err) {
    error = err as Error;
  }
  return { events, dir, bin, ...(error ? { error } : {}) };
}

const kinds = (e: AdapterEvent[]): string[] => e.map((x) => x.kind);
const of = (e: AdapterEvent[], kind: string): Array<Record<string, unknown>> =>
  e.filter((x) => x.kind === kind).map((x) => x.payload);
const states = (e: AdapterEvent[]): unknown[] => of(e, "status").map((p) => p.state);
const promptOf = (bin: string): string => String((rpcOf(bin, "turn/start")[0]?.input as Array<{ text: string }>)[0]?.text);
const continuity = (nativeSessionId: string | null = null) => ({ runId: "run", bindingId: "b", sessionEpoch: 1, nativeSessionId, context: "PACKET" });

describe("codex · a normal turn", () => {
  it("reports the thread, the words, and the tokens", async () => {
    const { events } = await run(CODEX_OK);
    expect(of(events, "status")[0]).toMatchObject({ state: "turn_started", session: expect.stringMatching(/^thread-/) });
    expect(of(events, "message")[0]).toMatchObject({ text: "Did the work." });
    expect(kinds(events).at(-1)).toBe("run_complete");
  });

  /**
   * Codex reports tokens and never money. Loom reports what it's told: a USD
   * figure here would have to come from a price table we'd maintain and get
   * wrong, and a confident wrong number is worse than an honest absent one.
   */
  it("reports tokens, and never invents a cost", async () => {
    const { events } = await run(CODEX_OK);
    expect(of(events, "run_complete")[0]).toMatchObject({ inputTokens: 52831, outputTokens: 120 });
    expect(of(events, "status").some((p) => "costUsd" in p)).toBe(false);
  });

  it("carries the model it ran + summed tokens onto run_complete (for the gen_ai span)", async () => {
    const { events } = await run(CODEX_OK, { model: "gpt-5.6" });
    // Codex's input includes its cached tokens, so they are not added again.
    expect(of(events, "run_complete")[0]).toMatchObject({ model: "gpt-5.6", inputTokens: 52831, outputTokens: 120 });
  });

  it("counts only this turn's tokens when the thread's running total carries earlier turns", async () => {
    const { events } = await run([started,
      codexNotify("thread/tokenUsage/updated", { tokenUsage: { modelContextWindow: 272000,
        total: { totalTokens: 1100, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
        last: { totalTokens: 110, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 } } }),
      codexNotify("thread/tokenUsage/updated", { tokenUsage: { modelContextWindow: 272000,
        total: { totalTokens: 1320, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 120, reasoningOutputTokens: 0 },
        last: { totalTokens: 220, inputTokens: 200, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 } } }),
      codexDone()]);
    expect(of(events, "run_complete")[0]).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  it("resumes the thread it had, with this turn's settings", async () => {
    const dir = makeProjectDir({ name: "cx" });
    const first = await run(CODEX_OK, {}, {}, {}, dir);
    const thread = of(first.events, "status")[0]!.session;
    const { bin } = await run(CODEX_OK, {}, { text: "more" }, { sandbox: "read-only", model: "o3" }, dir);
    expect(rpcOf(bin, "thread/start")).toHaveLength(0);
    expect(rpcOf(bin, "thread/resume")[0]).toMatchObject({ threadId: thread, sandbox: "read-only", model: "o3", excludeTurns: true, cwd: dir });
    expect(rpcOf(bin, "turn/start")[0]).toMatchObject({ threadId: thread, model: "o3" });
  });

  it("starts a thread in the project with the sandbox and approvals for the permission mode", async () => {
    const dir = makeProjectDir({ name: "cx" });
    const auto = await run(CODEX_OK, {}, {}, {}, dir);
    expect(rpcOf(auto.bin, "thread/start")[0]).toMatchObject({ cwd: dir, sandbox: "workspace-write", approvalPolicy: "never" });
    const bypass = await run(CODEX_OK, {}, {}, { permissions: "bypass" });
    expect(rpcOf(bypass.bin, "thread/start")[0]).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    const ask = await run(CODEX_OK, {}, {}, { permissions: "ask" });
    expect(rpcOf(ask.bin, "thread/start")[0]).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted" });
  });

  it("identifies itself and runs app-server with any extra args", async () => {
    const { bin } = await run(CODEX_OK, {}, {}, { extraArgs: ["-c", "model_reasoning_effort=high"] });
    expect(rpcOf(bin, "initialize")[0]).toMatchObject({ clientInfo: { name: "loom" } });
    expect(stdinOf(bin).some((m) => m.method === "initialized")).toBe(true);
    const argv = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "calls.jsonl"), "utf8").trim()) as string[];
    expect(argv).toEqual(["app-server", "-c", "model_reasoning_effort=high"]);
  });

  /**
   * Codex has no per-turn system channel, so a handoff briefing has to ride in
   * front of the text. It must still reach the model — dropping it silently
   * would make a handoff look like it worked while the next agent knows nothing.
   */
  it("carries a briefing in front of the prompt, framed as authoritative", async () => {
    const { bin } = await run(CODEX_OK, {}, { text: "fix the bug", briefing: "claude was here first" });
    const prompt = promptOf(bin);
    expect(prompt).toMatch(/LOOM SESSION MEMORY/);
    expect(prompt.indexOf("claude was here")).toBeLessThan(prompt.indexOf("fix the bug"));
  });

  it("hands the project's MCP servers to the thread as config", async () => {
    const { bin } = await run(CODEX_OK, {}, { mcp: { configPath: "/unused", servers: [
      { key: "signoz", name: "SigNoz", entry: { type: "http", url: "http://127.0.0.1:8080/mcp" } },
      { key: "files", name: "Files", entry: { type: "stdio", command: "npx", args: ["-y", "fs"] } }] } });
    expect(rpcOf(bin, "thread/start")[0]!.config).toEqual({
      "mcp_servers.signoz": { url: "http://127.0.0.1:8080/mcp" },
      "mcp_servers.files": { command: "npx", args: ["-y", "fs"] } });
  });
});

describe("codex · what it did", () => {
  const shell = (command: string, exitCode: number | null, extra: Record<string, unknown> = {}) =>
    codexItem({ type: "commandExecution", command, cwd: "/repo", aggregatedOutput: "ok\n", exitCode, status: "completed", ...extra });

  it("reports a shell command with its exit code", async () => {
    const { events } = await run(turn(shell("/bin/zsh -lc 'echo hi'", 0)));
    expect(of(events, "tool_call")[0]).toMatchObject({ tool: "shell", exitCode: 0 });
    expect(String(of(events, "tool_call")[0]?.summary)).toContain("echo hi");
  });

  it("keeps a failing command's exit code rather than rounding it to fine", async () => {
    const { events } = await run(turn(shell("npm test", 1)));
    expect(of(events, "tool_call")[0]).toMatchObject({ exitCode: 1 });
  });

  it("raises a file_edit per changed path", async () => {
    const { events } = await run(turn(codexItem({ type: "fileChange", status: "completed",
      changes: [{ path: "/repo/a.ts", kind: { type: "add" }, diff: "" }, { path: "/repo/b.ts", kind: { type: "update", move_path: null }, diff: "" }] })));
    expect(of(events, "file_edit").map((p) => p.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(of(events, "file_edit")[0]).toMatchObject({ tool: "file_change:add" });
  });

  it("surfaces reasoning apart from the reply", async () => {
    const { events } = await run(turn(codexItem({ type: "reasoning", summary: ["Weighing options"], content: [] }), codexMessage("Pick B.")));
    expect(of(events, "message")).toEqual([{ text: "Weighing options", reasoning: true }, { text: "Pick B." }]);
  });

  it("stays quiet about item types it doesn't understand", async () => {
    const { events } = await run(turn(codexItem({ type: "hookPrompt", text: "1. x" }), codexMessage("done")));
    expect(kinds(events).filter((k) => k === "message")).toHaveLength(1);
  });

  it("ignores an item that only started — nothing has happened yet", async () => {
    const { events } = await run(turn(codexNotify("item/started", { item: { id: "i", type: "commandExecution", command: "sleep 1", exitCode: null, status: "inProgress" } })),
      {}, {}, { commandSettleMs: 50 });
    expect(kinds(events)).not.toContain("tool_call");
  });

  it("ignores a sub-agent thread's items", async () => {
    const { events } = await run(turn({ out: { method: "item/completed", params: { threadId: "other", turnId: "x", item: { id: "i", type: "agentMessage", text: "not mine" } } } },
      codexMessage("mine")));
    expect(of(events, "message").map((p) => p.text)).toEqual(["mine"]);
  });

  it("stores complete large tool output as an immutable artifact with an honest preview", async () => {
    const output = "command output\n".repeat(9000);
    const { events, dir, bin } = await run(turn(shell("npm test", 1, { aggregatedOutput: output })), {}, { text: "test", continuity: continuity() });
    const observation = of(events, "tool_call")[0]!;
    expect(observation).toMatchObject({ outcome: "failure", exitCode: 1, outputTruncated: true, loomRunId: "run" });
    const artifact = observation.outputArtifact as { relativePath: string };
    expect(JSON.parse(fs.readFileSync(path.join(dir, artifact.relativePath), "utf8")).output).toBe(output);
    expect(promptOf(bin)).toBe("PACKET\n\ntest");
    expect(rpcOf(bin, "turn/start")[0]).toMatchObject({ clientUserMessageId: "run" });
  });
});

describe("codex · context, compaction and limits", () => {
  it("reports tokens in context against the model's window", async () => {
    const { events } = await run(CODEX_OK);
    expect(of(events, "status").find((p) => p.state === "context_usage")).toMatchObject({ usedTokens: 52831 + 120, maxTokens: 272000, autoCompacts: true });
  });

  it("shows compaction while it runs and when it is done", async () => {
    const { events } = await run(turn(
      codexNotify("item/started", { item: { id: "c", type: "contextCompaction" } }),
      codexItem({ type: "contextCompaction" }),
      codexMessage("carrying on")));
    const s = states(events);
    expect(s.indexOf("compacting")).toBeGreaterThan(-1);
    expect(s.indexOf("compacting")).toBeLessThan(s.indexOf("native_compacted"));
    expect(s.filter((x) => x === "native_compacted")).toHaveLength(1);
  });

  it("reports account usage-limit windows", async () => {
    const { events } = await run(turn(codexNotify("account/rateLimits/updated", { rateLimits: {
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: null } } })));
    expect(of(events, "status").find((p) => p.state === "usage_limits")).toEqual({ state: "usage_limits", provider: "codex", windows: [
      { id: "primary", usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000_000 },
      { id: "secondary", usedPercent: 7, windowMinutes: 10080 }] });
  });
});

describe("codex · always ask", () => {
  it("puts command and edit approvals in front of a person, and relays the answer", async () => {
    const asked: ApprovalRequest[] = [];
    setApprovalBroker(async (req) => { asked.push(req); return { behavior: req.tool === "shell" ? "allow" : "deny" }; });
    const { bin, error } = await run(turn(
      { ask: "item/commandExecution/requestApproval", params: { command: "rm -rf build", cwd: "/repo", reason: null } },
      { ask: "item/fileChange/requestApproval", params: { reason: "write x" } }), {}, {}, { permissions: "ask", loomProject: "p1" });
    expect(error).toBeUndefined();
    expect(asked.map((a) => [a.project, a.tool, a.summary])).toEqual([["p1", "shell", "shell: rm -rf build"], ["p1", "file_change", "apply file changes"]]);
    const answers = stdinOf(bin).filter((m) => m.method === undefined && typeof m.id === "string")
      .map((m) => (m.result as Record<string, unknown>).decision);
    expect(answers).toEqual(["accept", "decline"]);
  });

  it("declines what it cannot put to a person, rather than leaving Codex waiting", async () => {
    const { bin, error } = await run(turn({ ask: "mcpServer/elicitation/request", params: { message: "?" } }));
    expect(error).toBeUndefined();
    const answer = stdinOf(bin).find((m) => m.method === undefined && typeof m.id === "string");
    expect(answer?.result).toMatchObject({ action: "decline" });
  });
});

describe("codex · when it goes wrong", () => {
  it("surfaces a stream error as a notice, so a retried one can't sink the turn", async () => {
    const { events } = await run(turn(codexNotify("error", { error: { message: "stream disconnected" }, willRetry: true }), codexMessage("carrying on")));
    expect(of(events, "error")).toHaveLength(0);
    expect(of(events, "status").find((p) => p.state === "notice")).toMatchObject({ message: "stream disconnected", retrying: true });
    expect(kinds(events)).toContain("run_complete");
  });

  it("fails the turn when codex reports the turn itself failed", async () => {
    const { events, error } = await run([started, codexDone("failed", "model unavailable")]);
    // The error event ends the turn; send() doesn't report it a second time.
    expect(error).toBeUndefined();
    expect(of(events, "error")[0]).toMatchObject({ message: "model unavailable" });
    expect(kinds(events)).not.toContain("run_complete");
  });

  it("explains when Codex is not signed in", async () => {
    const { events, error } = await run(CODEX_OK, { dieAtStart: { code: 1, stderr: "Error: not logged in" } });
    expect(error).toBeInstanceOf(NativeDispatchRejected);
    expect(error?.message).toMatch(/codex not signed in.*codex login/i);
    expect(of(events, "error")[0]?.stderr).toContain("not logged in");
  });

  it("treats a refused turn as not submitted", async () => {
    const { events, error } = await run(CODEX_OK, { refuseTurn: "model gpt-x does not exist" }, { continuity: continuity() });
    expect(error).toBeInstanceOf(NativeDispatchRejected);
    expect(states(events)).not.toContain("native_turn_accepted");
  });

  it("a process that dies mid-turn leaves the outcome unknown, never complete", async () => {
    const { events, error } = await run([started, codexMessage("partial"), { exit: 0 }], {}, { continuity: continuity() });
    expect(error?.message).toMatch(/outcome is unknown/);
    expect(states(events)).toContain("native_turn_accepted");
    expect(kinds(events)).not.toContain("run_complete");
  });

  it("starts a new thread when the stored one is gone", async () => {
    const dir = makeProjectDir({ name: "cx" });
    await run(CODEX_OK, {}, {}, {}, dir);
    const { bin, events, error } = await run(CODEX_OK, { missingThread: true }, {}, {}, dir);
    expect(error).toBeUndefined();
    expect(rpcOf(bin, "thread/resume")).toHaveLength(1);
    expect(rpcOf(bin, "thread/start")).toHaveLength(1);
    expect(kinds(events)).toContain("run_complete");
  });

  it("reports a lost native thread to Brain instead of starting over", async () => {
    const { bin, error } = await run(CODEX_OK, { missingThread: true }, { continuity: continuity("thread-gone") });
    expect(error).toBeInstanceOf(NativeSessionMissing);
    expect(rpcOf(bin, "thread/start")).toHaveLength(0);
    expect(rpcOf(bin, "turn/start")).toHaveLength(0);
  });

  it("flags a turn that ended on a question", async () => {
    const { events } = await run(turn(codexMessage("Which one should I pick?")));
    expect(kinds(events)).toContain("needs_input");
  });

  it("refuses a second turn while one is running", async () => {
    const bin = fakeCodex({ script: [{ sleep: 400 }, ...CODEX_OK] });
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "cx" }), { bin });
    const first = agent.send({ text: "one" });
    await expect(agent.send({ text: "two" })).rejects.toThrow(/busy/);
    await first;
  });

  it("is unavailable when there's no binary anywhere", async () => {
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "cx" }), { bin: "/nope/codex" });
    expect(await agent.available()).toBe(false);
  });
});

describe("codex · interrupt", () => {
  it("interrupts the running turn and says so, without claiming completion", async () => {
    const bin = fakeCodex({ script: [started, { sleep: 10_000 }, ...CODEX_OK] });
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "cx" }), { bin });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));
    const running = agent.send({ text: "long one" });
    await waitUntil(() => states(events).includes("turn_started"));
    await agent.interrupt();
    await running;
    expect(rpcOf(bin, "turn/interrupt")).toHaveLength(1);
    expect(states(events)).toContain("interrupted");
    expect(kinds(events)).not.toContain("run_complete");
    expect(agent.busy()).toBe(false);
  }, 20_000);

  it("is a no-op when nothing is running", async () => {
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "cx" }), {});
    await expect(agent.interrupt()).resolves.toBeUndefined();
  });
});


describe("codex native child settlement (finding #1)", () => {
  const spawned = codexItem({ type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
    receiverThreadIds: ["child-thread"], agentsStates: { "child-thread": { status: "running" } } });

  it("holds send and run_complete until child turns and their commands settle", async () => {
    const bin = fakeCodex({ script: [started, spawned,
      codexNotify("item/started", { threadId: "child-thread", item: { id: "cmd", type: "commandExecution", command: "edit", status: "inProgress" } }),
      codexDone(), { sleep: 120 },
      codexNotify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } }),
      { sleep: 120 },
      codexNotify("item/completed", { threadId: "child-thread", item: { id: "cmd", type: "commandExecution", command: "edit", status: "completed" } }),
    ] });
    const agent = new CodexAdapter("codex", makeProjectDir(), { bin });
    const events: AdapterEvent[] = []; agent.onEvent(e => events.push(e));
    let resolved = false;
    const sending = agent.send({ text: "spawn" }).then(() => { resolved = true; });
    await waitUntil(() => kinds(events).includes("tool_call"));
    expect(agent.busy()).toBe(true);
    expect(resolved).toBe(false);
    expect(kinds(events)).not.toContain("run_complete");
    await sending;
    expect(agent.busy()).toBe(false);
    expect(kinds(events).filter(k => k === "run_complete")).toHaveLength(1);
  });

  it("does not let a stale collaboration snapshot end a live child turn", async () => {
    const bin = fakeCodex({ script: [started, spawned,
      codexNotify("turn/started", { threadId: "child-thread", turn: { id: "child-turn", status: "inProgress" } }),
      codexItem({ type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child-thread"],
        agentsStates: { "child-thread": { status: "completed" } } }),
      codexDone(), { sleep: 180 },
      codexNotify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } }),
    ] });
    const agent = new CodexAdapter("codex", makeProjectDir(), { bin });
    const events: AdapterEvent[] = []; agent.onEvent(e => events.push(e));
    const sending = agent.send({ text: "spawn" });
    await waitUntil(() => of(events, "tool_call").length >= 2);
    expect(agent.busy()).toBe(true);
    expect(kinds(events)).not.toContain("run_complete");
    await sending;
    expect(agent.busy()).toBe(false);
  });

  it("Stop contains a child after its parent completes, without waiting on a child RPC", async () => {
    const dir = makeProjectDir(), pidFile = path.join(dir, ".loom", "child.pid");
    const bin = fakeCodex({ script: [started, spawned,
      { spawn: `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);` },
      codexDone(), { sleep: 60_000 }] });
    const agent = new CodexAdapter("codex", dir, { bin });
    const events: AdapterEvent[] = []; agent.onEvent(e => events.push(e));
    const sending = agent.send({ text: "spawn" }).catch(error => error);
    await waitUntil(() => fs.existsSync(pidFile));
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    await agent.interrupt();
    await sending;
    expect(agent.busy()).toBe(false);
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(rpcOf(bin, "turn/interrupt")).toHaveLength(0);
  });

  it("holds an uncertain child writer until Stop and then permits another turn", async () => {
    const bin = fakeCodex({ script: [started, spawned, codexDone(), { sleep: 60_000 }] });
    const agent = new CodexAdapter("codex", makeProjectDir(), { bin, commandSettleMs: 30 });
    await expect(agent.send({ text: "spawn", continuity: continuity() })).rejects.toThrow(/child agent.*quiescence unknown/);
    expect(agent.busy()).toBe(true);
    await expect(agent.send({ text: "too soon" })).rejects.toThrow(/quiescence is unknown; use Stop or loom interrupt/);
    expect(rpcOf(bin, "turn/start")).toHaveLength(1);
    const service = (agent as unknown as { providers: { service: import("../src/providers/service.js").ProviderService } }).providers.service;
    const stop = vi.spyOn(service, "stopSession").mockRejectedValueOnce(new Error("could not fence writer"));
    try { await expect(agent.interrupt()).rejects.toThrow(/could not fence writer/); }
    finally { stop.mockRestore(); }
    expect(agent.busy()).toBe(true);
    await agent.interrupt();
    expect(agent.busy()).toBe(false);
    fs.copyFileSync(fakeCodex(), bin);
    await agent.send({ text: "after Stop", continuity: { ...continuity(), runId: "next", nativeSessionId: agent.sessionCursor("main") } });
    expect(rpcOf(bin, "thread/resume")).toHaveLength(1);
    expect(rpcOf(bin, "turn/start")).toHaveLength(2);
    expect(agent.busy()).toBe(false);
    await agent.stop();
  });
});

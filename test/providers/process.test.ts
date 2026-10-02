import { describe, expect, it, vi } from "vitest";
import { CodexProviderAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude/adapter.js";
import * as processes from "../../src/providers/process.js";
import { NativeQuiescenceUnknown } from "../../src/core/continuity/contracts.js";
import { tmpDir } from "../helpers.js";
import type { ProviderRuntimeEvent } from "../../src/providers/contracts.js";

describe("native containment regressions", () => {
  it("does not claim a successful stop when containment fails (#7)", async () => {
    for (const provider of ["codex", "claude"] as const) {
      const adapter = provider === "codex" ? new CodexProviderAdapter({ instanceId: "agent" }) : new ClaudeProviderAdapter({ instanceId: "agent" });
      const events: ProviderRuntimeEvent[] = []; adapter.onEvent(e => events.push(e));
      const session = { info: { threadId: "main", activeTurnId: "turn" }, pending: new Map(), inputs: new Map(),
        proc: {}, rpc: { close() {} }, prompts: { close() {} }, query: { close() {} }, done: Promise.resolve(), turn: { id: "turn" } };
      (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set("main", session);
      const stop = vi.spyOn(processes, "stopHarness").mockRejectedValueOnce(new NativeQuiescenceUnknown("cannot inspect group"));
      try {
        await expect(adapter.stopSession("main")).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
        expect(events.some(e => e.type === "turn.completed" || e.type === "session.exited")).toBe(false);
        expect(events.find(e => e.type === "turn.aborted")!.payload).toMatchObject({ reason: expect.stringMatching(/quiescence unknown/) });
        expect(adapter.hasSession("main")).toBe(true);
      } finally { stop.mockRestore(); }
    }
  });
  it("detects parent exit and contains descendants holding its pipes (#16)", async () => {
    const proc = processes.spawnHarness(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}).unref();process.exit(1)"], { cwd: tmpDir("pipes") });
    try {
      const ended = await Promise.race([proc.closed, new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))]);
      expect(ended?.code).toBe(1); expect(ended?.quiescenceError).toBeUndefined();
    } finally { await processes.stopHarness(proc, 0); }
  });
});

import { fakeClaude, fakeCodex } from "../native-fakes.js";

it("retains failed-start process handles when containment rejects, for both providers (#24)", async () => {
  const adapters = [
    new CodexProviderAdapter("audit-codex", { bin: fakeCodex({ missingThread: true }) }),
    new ClaudeProviderAdapter("audit-claude", { bin: fakeClaude({ missingSession: true }) }),
  ];
  for (const adapter of adapters) {
    const stop = vi.spyOn(processes, "stopHarness").mockRejectedValue(new NativeQuiescenceUnknown("initialization containment failed"));
    try {
      await expect(adapter.startSession({ threadId: "main", instanceId: adapter.instanceId, cwd: tmpDir("failed-start"), runtimeMode: "auto-accept-edits", resumeCursor: "12345678-1234-1234-1234-123456789012" }))
        .rejects.toBeInstanceOf(NativeQuiescenceUnknown);
      expect(adapter.hasSession("main")).toBe(true);
      expect(adapter.listSessions()[0]?.status).toBe("error");
    } finally { stop.mockRestore(); await adapter.stopAll(); }
    expect(adapter.hasSession("main")).toBe(false);
  }
});

it("does not signal a replacement process when a recovered PID was reused (#4)", async () => {
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    expect(await processes.stopRecordedProcessGroup({ processGroupId: 12345, processIdentity: "original" }, () => "replacement")).toBe(true);
    expect(signal.mock.calls).toEqual([[-12345, 0]]);
  } finally { signal.mockRestore(); }
});

it("requires recovery evidence when a live recorded group cannot be identified (#4)", async () => {
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    expect(await processes.stopRecordedProcessGroup({ processGroupId: 12345, processIdentity: "original" }, () => undefined)).toBe(false);
    expect(signal.mock.calls).toEqual([[-12345, 0]]);
  } finally { signal.mockRestore(); }
});

it("a closed Claude prompt queue rejects without native acceptance (port audit #1)", async () => {
  const adapter = new ClaudeProviderAdapter("queue-race", { bin: fakeClaude() });
  const events: ProviderRuntimeEvent[] = [];
  adapter.onEvent(e => events.push(e));
  try {
    await adapter.startSession({ threadId: "main", instanceId: "queue-race", cwd: tmpDir("queue-race"), runtimeMode: "auto-accept-edits" });
    const session = (adapter as unknown as { sessions: Map<string, { prompts: { close(): void } }> }).sessions.get("main")!;
    session.prompts.close();
    await expect(adapter.sendTurn({ threadId: "main", instanceId: "queue-race", input: "not delivered" })).rejects.toMatchObject({ notSubmitted: true });
    expect(events.filter(e => e.type === "turn.started").map(e => e.payload)).toEqual([{ local: true }]);
    expect(events.some(e => e.type === "turn.aborted")).toBe(true);
  } finally { await adapter.stopAll(); }
});

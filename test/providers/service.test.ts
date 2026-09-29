/**
 * ProviderService against the fake adapter: routing by (chat, agent), starting,
 * adopting and resuming sessions, lost sessions, the directory it keeps, turn
 * tracking, capability checks, and event fan-in.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../src/providers/contracts.js";
import { FileSessionDirectory, MemorySessionDirectory } from "../../src/providers/directory.js";
import { ProviderError } from "../../src/providers/errors.js";
import { ProviderService } from "../../src/providers/service.js";
import { waitUntil, tmpDir } from "../helpers.js";
import { FakeAdapter, type FakeOptions } from "./fake-adapter.js";

const base = { cwd: "/repo", runtimeMode: "auto-accept-edits" as const };

function setup(options: FakeOptions = {}, directory = new MemorySessionDirectory()) {
  const service = new ProviderService(directory);
  const codex = new FakeAdapter("codex", { provider: "codex", ...options });
  const claude = new FakeAdapter("claude", { provider: "claude-code", ...options });
  service.register(codex);
  service.register(claude);
  const events: ProviderRuntimeEvent[] = [];
  service.onEvent(e => events.push(e));
  return { service, codex, claude, directory, events };
}

describe("ProviderService · routing and sessions", () => {
  it("starts a fresh session and records what resumes it", async () => {
    const { service, directory } = setup();
    const { session, via } = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base, model: "gpt-x" });
    expect(via).toBe("fresh");
    expect(session).toMatchObject({ provider: "codex", instanceId: "codex", threadId: "main", model: "gpt-x" });
    expect(directory.get("main", "codex")).toMatchObject({ status: "running", resumeCursor: session.resumeCursor,
      runtimePayload: { cwd: "/repo", model: "gpt-x" }, runtimeMode: "auto-accept-edits" });
  });

  it("adopts the live session instead of starting another", async () => {
    const { service, codex } = setup();
    await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    const again = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    expect(again.via).toBe("live");
    expect(codex.startCount).toBe(1);
  });

  it("shares one start between concurrent callers", async () => {
    const { service, codex } = setup({ startDelay: 30 });
    const [a, b] = await Promise.all([
      service.ensureSession({ threadId: "main", instanceId: "codex", ...base }),
      service.ensureSession({ threadId: "main", instanceId: "codex", ...base }),
    ]);
    expect(codex.startCount).toBe(1);
    expect(a.session.resumeCursor).toBe(b.session.resumeCursor);
  });

  it("resumes a stopped session from its cursor, with the settings it was started with", async () => {
    const { service, codex } = setup();
    const first = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base, model: "gpt-x" });
    await service.stopSession("main", "codex");
    const again = await service.ensureSession({ threadId: "main", instanceId: "codex", cwd: "/elsewhere", runtimeMode: "auto-accept-edits" });
    expect(again.via).toBe("resumed");
    expect(again.session.resumeCursor).toBe(first.session.resumeCursor);
    expect(codex.calls.at(-1)!.args[0]).toMatchObject({ resumeCursor: first.session.resumeCursor, cwd: "/repo", modelSelection: { model: "gpt-x" } });
  });

  it("reports a lost native session by default, so Brain can rebuild", async () => {
    const lost = new Set<unknown>();
    const { service, directory } = setup({ lostCursors: lost });
    const first = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await service.stopSession("main", "codex");
    lost.add(first.session.resumeCursor);
    const error = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("session_missing");
    expect(error.notSubmitted).toBe(true);
    expect(directory.get("main", "codex")?.status).toBe("error");
  });

  it("replaces a lost session with a fresh one when asked", async () => {
    const lost = new Set<unknown>();
    const { service, directory } = setup({ lostCursors: lost });
    const first = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await service.stopSession("main", "codex");
    lost.add(first.session.resumeCursor);
    const again = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base, onMissingSession: "fresh" });
    expect(again).toMatchObject({ via: "fresh", replacedLostSession: true });
    expect(again.session.resumeCursor).not.toBe(first.session.resumeCursor);
    expect(directory.get("main", "codex")?.resumeCursor).toBe(again.session.resumeCursor);
  });

  it("keeps a session per agent in one chat: switching parks the other, it does not stop it", async () => {
    const { service, codex, claude } = setup();
    await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await service.ensureSession({ threadId: "main", instanceId: "claude", ...base });
    expect(codex.hasSession("main")).toBe(true);
    expect(claude.hasSession("main")).toBe(true);
    expect(service.listSessions().map(s => s.instanceId).sort()).toEqual(["claude", "codex"]);
  });

  it("keeps chats apart for one agent", async () => {
    const { service } = setup();
    const a = await service.ensureSession({ threadId: "a", instanceId: "codex", ...base });
    const b = await service.ensureSession({ threadId: "b", instanceId: "codex", ...base });
    expect(a.session.resumeCursor).not.toBe(b.session.resumeCursor);
  });

  it("refuses an unknown agent and a duplicate registration", async () => {
    const { service, codex } = setup();
    await expect(service.ensureSession({ threadId: "main", instanceId: "nope", ...base })).rejects.toMatchObject({ code: "not_found" });
    expect(() => service.register(codex)).toThrow(/already registered/);
  });

  it("unregistering stops the agent's sessions and keeps their cursors", async () => {
    const { service, codex, directory } = setup();
    const { session } = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await service.unregister("codex");
    expect(codex.hasSession("main")).toBe(false);
    expect(directory.get("main", "codex")).toMatchObject({ status: "stopped", resumeCursor: session.resumeCursor });
    expect(service.instances()).toEqual(["claude"]);
  });
});

describe("ProviderService · turns", () => {
  it("starts the session on first send, tracks the turn, and publishes its events", async () => {
    const { service, events } = setup();
    const result = await service.sendTurn({ threadId: "main", instanceId: "codex", input: "hello", ...base });
    expect(result.session.via).toBe("fresh");
    await waitUntil(() => events.some(e => e.type === "turn.completed"));
    expect(events.map(e => e.type)).toEqual(["session.started", "thread.started", "turn.started", "item.completed", "turn.completed"]);
    expect(events.every(e => e.instanceId === "codex" && e.threadId === "main")).toBe(true);
    expect(service.activeTurn("main", "codex")).toBeUndefined();
  });

  it("refuses an empty turn before touching a session", async () => {
    const { service, codex } = setup();
    await expect(service.sendTurn({ threadId: "main", instanceId: "codex", input: "  ", ...base })).rejects.toMatchObject({ code: "validation" });
    expect(codex.startCount).toBe(0);
  });

  it("routes an interrupt to the running turn", async () => {
    const { service, codex, events } = setup({ script: [{ wait: 5000 }] });
    const { turnId } = await service.sendTurn({ threadId: "main", instanceId: "codex", input: "long", ...base });
    expect(service.activeTurn("main", "codex")).toBe(turnId);
    await service.interruptTurn("main", "codex");
    expect(codex.calls.find(c => c.op === "interruptTurn")!.args).toEqual(["main", turnId]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", payload: { state: "interrupted" } });
    expect(service.activeTurn("main", "codex")).toBeUndefined();
  });

  it("an interrupt with no live session is a no-op", async () => {
    const { service, codex } = setup();
    await service.interruptTurn("main", "codex");
    expect(codex.calls).toHaveLength(0);
  });

  it("answers a request only on a live session", async () => {
    const { service, codex } = setup({ script: [{ request: "r1" }] });
    await expect(service.respondToRequest("main", "codex", "r1", "accept")).rejects.toMatchObject({ code: "not_found" });
    await service.sendTurn({ threadId: "main", instanceId: "codex", input: "go", ...base });
    await service.respondToRequest("main", "codex", "r1", "accept");
    expect(codex.responses).toEqual([{ requestId: "r1", decision: "accept" }]);
  });

  it("refuses compaction, and a rollback the adapter doesn't support, before anything changes", async () => {
    const { service, codex } = setup();
    await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await expect(service.compact("main", "codex")).rejects.toMatchObject({ code: "unsupported" });
    await service.sendTurn({ threadId: "main", instanceId: "codex", input: "one", ...base });
    await new Promise(r => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 5));
    await service.sendTurn({ threadId: "main", instanceId: "codex", input: "two", ...base });
    expect(() => service.planRollback("main", "codex", cutoff, "/repo")).toThrow(/cannot roll back/);
    expect(codex.calls.some(c => c.op === "rollbackThread")).toBe(false);
  });

  it("plans a rollback from the turn ledger and routes it to the adapter", async () => {
    const { service, codex, directory } = setup({ capabilities: { manualCompaction: true, supportsConversationRollback: true } });
    await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await service.compact("main", "codex");
    const first = await service.sendTurn({ threadId: "main", instanceId: "codex", input: "one", ...base });
    await waitUntil(() => !service.activeTurn("main", "codex"));
    await new Promise(r => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 5));
    const second = await service.sendTurn({ threadId: "main", instanceId: "codex", input: "two", ...base });
    await waitUntil(() => !service.activeTurn("main", "codex"));
    const step = service.planRollback("main", "codex", cutoff, "/repo")!;
    expect(step).toMatchObject({ beforeTurnId: second.turnId, turns: 1 });
    await service.rollbackConversation(step);
    expect(codex.calls.filter(c => c.op === "compact" || c.op === "rollbackThread").map(c => c.args)).toEqual([["main"], ["main", second.turnId]]);
    expect(directory.get("main", "codex")!.turnLedger!.turns.map(t => t.id)).toEqual([first.turnId]);
    expect(service.planRollback("main", "codex", cutoff, "/repo")).toBeNull();
  });

  it("stopAll stops every session and marks every binding stopped", async () => {
    const { service, directory, codex, claude } = setup();
    await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await service.ensureSession({ threadId: "main", instanceId: "claude", ...base });
    await service.stopAll();
    expect(codex.hasSession("main") || claude.hasSession("main")).toBe(false);
    expect(directory.list({ excludeStopped: true })).toHaveLength(0);
  });

  it("a throwing listener doesn't stop other listeners", async () => {
    const { service, events } = setup();
    service.onEvent(() => { throw new Error("bad listener"); });
    await service.sendTurn({ threadId: "main", instanceId: "codex", input: "hi", ...base });
    await waitUntil(() => events.some(e => e.type === "turn.completed"));
  });

  it("a session exit marks the binding stopped, keeping its cursor", async () => {
    const { service, directory, codex } = setup();
    const { session } = await service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await codex.stopSession("main"); // the process went away on its own
    expect(directory.get("main", "codex")).toMatchObject({ status: "stopped", resumeCursor: session.resumeCursor });
  });
});

describe("FileSessionDirectory", () => {
  it("survives a restart", async () => {
    const dir = tmpDir("provider-dir");
    const first = setup({}, new FileSessionDirectory(dir));
    const { session } = await first.service.ensureSession({ threadId: "main", instanceId: "codex", ...base });
    await first.service.stopAll();
    const reopened = new FileSessionDirectory(dir);
    expect(reopened.get("main", "codex")).toMatchObject({ resumeCursor: session.resumeCursor, status: "stopped", provider: "codex" });
    const second = setup({}, reopened);
    expect((await second.service.ensureSession({ threadId: "main", instanceId: "codex", ...base })).via).toBe("resumed");
  });

  it("moves an unreadable file aside and starts empty", () => {
    const dir = tmpDir("provider-dir");
    fs.mkdirSync(path.join(dir, "providers"));
    fs.writeFileSync(path.join(dir, "providers", "sessions.json"), "{not json");
    const warnings: string[] = [];
    const directory = new FileSessionDirectory(dir, m => warnings.push(m));
    expect(directory.list()).toEqual([]);
    expect(warnings[0]).toMatch(/unreadable/);
    expect(fs.readdirSync(path.join(dir, "providers")).some(f => f.startsWith("sessions.json.unreadable."))).toBe(true);
  });

  it("filters by status and chat, and only moves last-seen forward", () => {
    const directory = new MemorySessionDirectory();
    const row = { provider: "codex" as const, resumeCursor: null, runtimePayload: null, runtimeMode: "full-access" as const };
    directory.upsert({ ...row, threadId: "a", instanceId: "x", status: "running", lastSeenAt: 100 });
    directory.upsert({ ...row, threadId: "b", instanceId: "x", status: "stopped", lastSeenAt: 100 });
    expect(directory.list({ excludeStopped: true }).map(b => b.threadId)).toEqual(["a"]);
    expect(directory.list({ threadId: "b" }).map(b => b.status)).toEqual(["stopped"]);
    directory.touch("a", "x", 50);
    expect(directory.get("a", "x")!.lastSeenAt).toBe(100);
    directory.touch("a", "x", 200);
    expect(directory.get("a", "x")!.lastSeenAt).toBe(200);
  });
});

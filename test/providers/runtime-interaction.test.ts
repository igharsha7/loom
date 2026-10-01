/**
 * Phase 3 through the project runtime: a plan turn on a provider agent runs in
 * its native plan mode and Loom saves the proposed plan under plans/; a
 * structured question is answered through the runtime and releases the queue.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../../src/daemon/runtime.js";
import { stopAllProviderSessions } from "../../src/providers/agent.js";
import { makeProjectDir } from "../helpers.js";
import { codexDone, codexItem, codexNotify, codexTokens, fakeCodex, fakeClaude, rpcOf, stdinOf } from "../native-fakes.js";

const open: ProjectRuntime[] = [];
afterAll(async () => { for (const rt of open) await rt.close().catch(() => {}); await stopAllProviderSessions(); });

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
};
const started = codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } });

async function runtimeWith(bin: string) {
  const dir = makeProjectDir({ agents: [{ id: "codex", kind: "codex", options: { bin } }] });
  const rt = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "ix", dir });
  open.push(rt);
  return { rt, dir };
}

describe("runtime · provider interaction", () => {
  it("plans natively and keeps the proposed plan under plans/", async () => {
    const bin = fakeCodex({ script: [started, codexItem({ type: "plan", text: "# Add a cache layer\n\n- step one" }), codexTokens(10, 0, 1), codexDone()] });
    const { rt, dir } = await runtimeWith(bin);
    await rt.sendMessage("plan a cache", "codex", { plan: true });
    await until(() => !rt.anyBusy() && rt.log.list().some((e) => e.kind === "run_complete"));
    await until(() => rt.log.list().some((e) => e.payload.state === "plan_saved"));
    const turn = rpcOf(bin, "turn/start")[0]!;
    expect(turn).toMatchObject({ collaborationMode: { mode: "plan" } });
    // Loom's own plan briefing (write a file) is not sent to a native planner
    expect(JSON.stringify(turn.input)).not.toContain("[Loom · Plan mode]");
    const saved = rt.log.list().find((e) => e.payload.state === "plan_saved")!;
    const file = path.join(dir, String(saved.payload.path));
    expect(fs.readFileSync(file, "utf8")).toMatch(/^---\ntitle: "Add a cache layer"\nstatus: proposed[\s\S]*- step one/);
  });

  it("takes the answer to a structured question and lets the turn finish", async () => {
    const bin = fakeCodex({ script: [started, { ask: "item/tool/requestUserInput", params: { questions: [
      { id: "size", header: "Size", question: "How big?", options: [{ label: "small", description: "" }, { label: "large", description: "" }] }] } },
    codexItem({ type: "agentMessage", text: "Small it is." }), codexTokens(10, 0, 1), codexDone()] });
    const { rt } = await runtimeWith(bin);
    await rt.sendMessage("make it", "codex");
    await until(() => rt.log.list().some((e) => e.kind === "needs_input"));
    const asked = rt.log.list().find((e) => e.kind === "needs_input")!;
    await rt.answerQuestion("codex", "main", String(asked.payload.requestId), { size: "small" });
    await until(() => rt.log.list().some((e) => e.kind === "run_complete"));
    expect(rt.log.list().some((e) => e.kind === "message" && e.payload.text === "Small it is.")).toBe(true);
  });
});

import { vi } from "vitest";
import { ProviderAgent } from "../../src/providers/agent.js";

it("refuses to save a proposed plan through a plans symlink (#9)", async () => {
  const { rt, dir } = await runtimeWith(fakeCodex({ script: [started, codexItem({ type: "plan", text: "# Outside write\n\ncontent" }), codexDone()] }));
  const outside = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "loom-plan-outside-"));
  fs.symlinkSync(outside, path.join(dir, "plans"));
  await rt.sendMessage("plan", "codex", { plan: true });
  await until(() => !rt.anyBusy());
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(rt.log.list().some(e => e.payload.state === "plan_saved")).toBe(false);
  fs.rmSync(outside, { recursive: true, force: true });
});

it("reserves compaction ownership before startup and rechecks restore afterwards (#6)", async () => {
  const { rt } = await runtimeWith(fakeCodex());
  const internal = rt as unknown as { ensureStarted: (id: string) => Promise<unknown>; restoring: boolean; turns: { busySince: Map<string, number> } };
  let resume!: () => void;
  const wait = new Promise<void>(r => { resume = r; });
  const start = vi.spyOn(internal, "ensureStarted").mockImplementation(async () => { await wait; return rt.agent("codex"); });
  const agent = rt.agent("codex") as ProviderAgent;
  const compact = vi.spyOn(agent, "compact").mockResolvedValue();
  try {
    const running = rt.compactAgent("codex");
    expect(internal.turns.busySince.has("codex")).toBe(true);
    await expect(rt.compactAgent("codex")).rejects.toThrow(/writer is active/);
    internal.restoring = true; resume();
    await expect(running).rejects.toThrow(/rewinding/);
    expect(compact).not.toHaveBeenCalled();
    internal.restoring = false;
    internal.turns.busySince.set("other-provider", Date.now());
    await expect(rt.compactAgent("codex")).rejects.toThrow(/writer is active/);
  } finally { resume(); internal.restoring = false; internal.turns.busySince.clear(); start.mockRestore(); compact.mockRestore(); }
});

it("resolves an async Codex question when the next message is accepted (#20)", async () => {
  const bin = fakeCodex({ scripts: [[started, codexItem({ type: "agentMessage", text: "Choose?", delivery: "async", questions: [{ title: "Choose?", options: ["A", "B"] }] }), codexDone()], [started, codexItem({ type: "agentMessage", text: "A it is." }), codexDone()]] });
  const { rt } = await runtimeWith(bin);
  await rt.sendMessage("choose", "codex");
  await until(() => !rt.anyBusy() && rt.log.list().some(e => e.kind === "needs_input"));
  expect((await rt.status()).needsInput).toBe(true);
  const asked = rt.log.list().find(e => e.kind === "needs_input")!;
  await rt.sendMessage("A", "codex");
  await until(() => !rt.anyBusy());
  expect(rt.log.list().some(e => e.payload.state === "question_answered" && e.payload.requestId === asked.payload.requestId)).toBe(true);
  expect((await rt.status()).needsInput).toBe(false);
});

it("holds busy and durable ownership until compaction completes (audit #8)", async () => {
  const bin = fakeCodex({ compactDelayMs: 200 }), { rt, dir } = await runtimeWith(bin);
  const journal = path.join(dir, ".loom", "compaction-pending.json");
  const compacting = rt.compactAgent("codex");
  await until(() => rpcOf(bin, "thread/compact/start").length > 0);
  expect(rt.agent("codex").busy()).toBe(true);
  expect(fs.existsSync(journal)).toBe(true);
  await expect(rt.sendMessage("during compact", "codex")).rejects.toThrow(/rewinding|interrupted|compaction/);
  await compacting;
  expect(rt.agent("codex").busy()).toBe(false);
  expect(fs.existsSync(journal)).toBe(false);
  await rt.close();
  // A crash has no completion evidence; reopening must keep dispatch gated.
  fs.writeFileSync(journal, JSON.stringify({ agentId: "codex", chat: "main", cwd: dir }));
  const again = await ProjectRuntime.open(rt.info); open.push(again);
  await expect(again.sendMessage("after crash", "codex")).rejects.toThrow(/rewinding|interrupted|compaction/);
  again.reconcileCompaction("verified the original native process group is stopped");
  expect(fs.existsSync(journal)).toBe(false);
  await again.sendMessage("safe after reconciliation", "codex");
  await until(() => !again.anyBusy());
});

it("closes the journal and servers even if agent retirement rejects (audit #5)", async () => {
  const { rt } = await runtimeWith(fakeCodex());
  const internal = rt as unknown as { agentLifecycle: { close: () => Promise<void> }; servers: { closeAll: () => Promise<void> } };
  const retirement = vi.spyOn(internal.agentLifecycle, "close").mockRejectedValueOnce(new Error("stop failed"));
  const journal = vi.spyOn(rt.log, "close"), servers = vi.spyOn(internal.servers, "closeAll");
  try {
    await expect(rt.close()).rejects.toThrow("stop failed");
    expect(journal).toHaveBeenCalledOnce(); expect(servers).toHaveBeenCalledOnce();
    await rt.close(); // the retained handles can be retried even after cleanup
  } finally { retirement.mockRestore(); journal.mockRestore(); servers.mockRestore(); }
});

it("does not retain compaction ownership when no compaction request was sent (audit #8)", async () => {
  const { rt, dir } = await runtimeWith(fakeCodex({ dieAtStart: { code: 1, stderr: "offline" } }));
  await expect(rt.compactAgent("codex")).rejects.toThrow(/failed to start/);
  expect(fs.existsSync(path.join(dir, ".loom", "compaction-pending.json"))).toBe(false);
});

it("Stop recovers compaction after reopening without in-memory ownership (#4)", async () => {
  const { rt, dir } = await runtimeWith(fakeCodex());
  await rt.close();
  const journal = path.join(dir, ".loom", "compaction-pending.json");
  // An absent process group is durable evidence that the request is quiescent.
  fs.writeFileSync(journal, JSON.stringify({ agentId: "codex", chat: "main", cwd: dir, processGroupId: 2147483647 }));
  const again = await ProjectRuntime.open(rt.info); open.push(again);
  await again.interrupt();
  expect(fs.existsSync(journal)).toBe(false);
  await again.sendMessage("after Stop", "codex"); await until(() => !again.anyBusy());
});

it("recovers legacy empty compaction journals through explicit evidence (#4)", async () => {
  const { rt, dir } = await runtimeWith(fakeCodex());
  const journal = path.join(dir, ".loom", "compaction-pending.json"); fs.writeFileSync(journal, "");
  rt.reconcileCompaction("verified no native processes remain");
  expect(fs.existsSync(journal)).toBe(false);
  await rt.sendMessage("after recovery", "codex"); await until(() => !rt.anyBusy());
});

it("clean shutdown fences a recovered compaction journal (#4)", async () => {
  const { rt, dir } = await runtimeWith(fakeCodex());
  const journal = path.join(dir, ".loom", "compaction-pending.json");
  fs.writeFileSync(journal, JSON.stringify({ agentId: "codex", chat: "main", processGroupId: 2147483647 }));
  await rt.close();
  expect(fs.existsSync(journal)).toBe(false);
});

it("does not publish a partial compaction journal if atomic publication fails (#4)", async () => {
  const bin = fakeCodex(), { rt, dir } = await runtimeWith(bin);
  const journal = path.join(dir, ".loom", "compaction-pending.json");
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === journal) throw new Error("simulated publication failure");
    return rename(from, to);
  });
  try { await expect(rt.compactAgent("codex")).rejects.toThrow(/publication failure/); }
  finally { spy.mockRestore(); }
  expect(fs.existsSync(journal)).toBe(false);
  expect(rpcOf(bin, "thread/compact/start")).toHaveLength(0);
  await rt.sendMessage("unblocked", "codex"); await until(() => !rt.anyBusy());
});

it("Stop terminates live compaction and releases its durable gate (#4)", async () => {
  const { rt, dir } = await runtimeWith(fakeCodex({ compactDelayMs: 1000 }));
  const compacting = rt.compactAgent("codex").catch(error => error);
  const journal = path.join(dir, ".loom", "compaction-pending.json");
  await until(() => fs.existsSync(journal) && rt.agent("codex").busy());
  await rt.interrupt(); await compacting;
  expect(fs.existsSync(journal)).toBe(false);
  await rt.sendMessage("after Stop", "codex"); await until(() => !rt.anyBusy());
});

it("publishes Claude compaction intent before submission and releases publication failures (#4)", async () => {
  const bin = fakeClaude(), dir = makeProjectDir({ agents: [{ id: "claude", kind: "claude-code", options: { bin } }] });
  const rt = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "compact-claude", dir }); open.push(rt);
  const journal = path.join(dir, ".loom", "compaction-pending.json"), rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === journal) throw new Error("simulated publication failure");
    return rename(from, to);
  });
  try { await expect(rt.compactAgent("claude")).rejects.toThrow(/publication failure/); }
  finally { spy.mockRestore(); }
  expect(stdinOf(bin).filter(m => m.type === "user")).toHaveLength(0);
  expect(fs.existsSync(journal)).toBe(false);
  await rt.compactAgent("claude");
  expect(stdinOf(bin).filter(m => m.type === "user")).toHaveLength(1);
  expect(fs.existsSync(journal)).toBe(false);
});

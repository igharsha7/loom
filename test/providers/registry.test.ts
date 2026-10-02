import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { builtInDrivers } from "../../src/providers/builtInDrivers.js";
import { ProviderRegistry, providerRegistry } from "../../src/providers/registry.js";
import type { ProviderDriver, ProviderInstance } from "../../src/providers/driver.js";
import { FileSessionDirectory, MemorySessionDirectory } from "../../src/providers/directory.js";
import { ProviderService } from "../../src/providers/service.js";
import { RuntimeIngestion, type IngestedEvent } from "../../src/providers/ingestion.js";
import { NativeQuiescenceUnknown } from "../../src/providers/settlement.js";
import { ProviderAgent } from "../../src/providers/agent.js";
import { BindingV1, digest } from "../../src/core/continuity/contracts.js";
import { ContinuityEngine, packetBudget } from "../../src/core/continuity/engine.js";
import { EventLog } from "../../src/core/eventlog.js";
import { HarnessMonitor } from "../../src/core/continuity/capabilities.js";
import { createAgent } from "../../src/adapters/index.js";
import { NativeUsage } from "../../src/daemon/runtime/native-usage.js";
import { ProjectRuntime } from "../../src/daemon/runtime.js";
import { FakeAdapter } from "./fake-adapter.js";
import { makeProjectDir, tmpDir } from "../helpers.js";

const close: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const f of close.splice(0).reverse()) await f(); });
/** A test-only server driver: no binary, process or native harness calls. */
const remote: ProviderDriver = {
  kind: "registry-test-remote", metadata: { displayName: "Test server", supportsMultipleInstances: true },
  configSchema: z.record(z.string(), z.unknown()), defaultConfig: () => ({}),
  capabilities: { sessionModelSwitch: "restart", supportsConversationRollback: false, manualCompaction: false,
    planMode: "unsupported", compaction: { type: "unsupported" }, writerSettlement: "adapter", fencing: "opaque" },
  permissions: { default: "auto", modes: { auto: { flags: "", label: "auto" }, ask: { flags: "", label: "ask" }, bypass: { flags: "", label: "bypass" } } },
  limits: { provider: "test-server", reachedScope: "account" }, accountKey: config => String(config.account ?? "test-server"),
  continuationIdentity: (id, config) => ({ driverKind: remote.kind, continuationKey: `${id}:${String(config.account ?? "default")}` }),
  continuity: { supported: true, protocolRevision: "remote-v1", defaultContextWindow: 100_000,
    compatibilityKey: input => digest(JSON.stringify(input)), instructionDependencies: async () => ({ fingerprint: digest("server instructions") }) },
  available: async () => true, selfCheck: async () => [],
  health: async () => ({ kind: remote.kind, available: true, version: null, binary: null, fingerprint: null, tested: false, checkedAt: Date.now() }),
  recoveryIdentity: session => ({ type: "server-lease", value: session.resumeCursor }),
  fence: async identity => identity.type === "server-lease" && identity.value === "lease-1",
  async create(input) {
    const adapter = new FakeAdapter(input.instanceId, { provider: remote.kind, capabilities: remote.capabilities });
    const identity = remote.continuationIdentity(input.instanceId, input.config);
    return { instanceId: input.instanceId, driverKind: remote.kind, continuationIdentity: identity, adapter,
      accountKey: remote.accountKey(input.config), continuity: remote.continuity, health: () => remote.health(input.config),
      dispose: () => adapter.stopAll(), recoveryIdentity: session => ({ ...identity, identity: remote.recoveryIdentity(session)! }) };
  },
};
providerRegistry.register(remote);
const environment = (cwd: string) => ({ cwd, canAsk: () => false, mcpServers: () => [] });

describe("provider registry", () => {
  it("keeps the built-ins' exact legacy compatibility keys and model switching", () => {
    for (const driver of builtInDrivers) {
      const workspaceId = digest("workspace"), options = { model: "one", bin: "/fake", permissions: "auto" };
      const legacy = digest(JSON.stringify([driver.kind, { bin: "/fake", permissions: "auto" }, workspaceId, "turn-input-v2"]));
      expect(driver.continuity.compatibilityKey({ kind: driver.kind, options, workspaceId })).toBe(legacy);
      expect(driver.continuity.compatibilityKey({ kind: driver.kind, options: { ...options, model: "two" }, workspaceId })).toBe(legacy);
    }
    expect(packetBudget("codex")).toBe(27_200);
    expect(packetBudget("claude-code")).toBe(20_000);
  });
  it("preserves unknown driver ids alongside existing session and continuity bindings", () => {
    const dir = tmpDir("unknown-drivers"), directory = new FileSessionDirectory(dir);
    for (const provider of ["codex", "retired-server"]) directory.upsert({ threadId: provider, instanceId: provider,
      provider, status: "stopped", resumeCursor: { opaque: provider }, runtimePayload: null, runtimeMode: "approval-required" });
    const loaded = new FileSessionDirectory(dir);
    expect(loaded.list()).toEqual(directory.list().map(binding => expect.objectContaining(binding)));
    expect(fs.existsSync(directory.file)).toBe(true);
    expect(BindingV1.parse({ id: "b", conversationId: "main", agentInstanceId: "a", harnessKind: "retired-server",
      workspaceId: digest("w"), compatibilityFingerprint: digest("p"), nativeSessionId: "s", sessionEpoch: 3, retention: "compacted" }).harnessKind).toBe("retired-server");
  });
  it("rejects invalid driver config and duplicate registration", () => {
    const registry = new ProviderRegistry(builtInDrivers);
    expect(() => registry.register(builtInDrivers[0]!)).toThrow(/duplicate/);
    expect(() => providerRegistry.require("unavailable")).toThrow(/bindings are preserved/);
    expect(() => builtInDrivers[0]!.configSchema.parse({ bin: 123 })).toThrow();
  });
  it("validates defaults before account lookup and materialization", async () => {
    const registry = new ProviderRegistry([{ ...remote,
      configSchema: z.object({ account: z.string() }), defaultConfig: () => ({ account: "default-account" }) }]);
    expect(registry.accountKey(remote.kind)).toBe("default-account");
    expect(registry.accountKey(remote.kind, { account: 12 })).toBeUndefined();
    expect(registry.accountKey("unavailable")).toBeUndefined();
    const instance = await registry.create(remote.kind, "defaults", {}, environment("/server"));
    try { expect(instance.accountKey).toBe(registry.accountKey(remote.kind)); }
    finally { await instance.dispose(); }
  });
  it("isolates normalized limits by account, including two accounts of the same driver", () => {
    const usage = new NativeUsage();
    for (const accountKey of ["a", "b"]) usage.observe({ kind: "status", agentId: accountKey, ts: 1,
      payload: { state: "usage_limits", provider: "codex", accountKey, reachedScope: "account", windows: [], reached: accountKey } });
    usage.observe({ kind: "status", agentId: "a", ts: 2, payload: { state: "usage_limits", provider: "codex", accountKey: "a", reachedScope: "account", windows: [] } });
    expect(usage.limitsFor("codex", "a")?.reached).toBeNull();
    expect(usage.limitsFor("codex", "b")?.reached).toBe("b");
  });
  it("preserves legacy limit payloads and carries explicit account ownership", () => {
    for (const account of ["codex", "second-account"]) {
      const events: IngestedEvent[] = [];
      const ingestion = new RuntimeIngestion({ append: event => events.push(event), accountKey: () => account });
      ingestion.ingest({ eventId: "limit", provider: "codex", instanceId: "a", threadId: "main", createdAt: 1,
        type: "account.rate-limits.updated", payload: { windows: [] } });
      expect(events[0]?.payload).toEqual({ state: "usage_limits", provider: "codex", windows: [],
        ...(account === "codex" ? {} : { accountKey: account }) });
    }
  });
  it("materializes a new server driver through the existing factory and health monitor", async () => {
    const dir = makeProjectDir();
    const agent = createAgent({ id: "server", kind: remote.kind, role: "code" }, dir) as ProviderAgent;
    close.push(() => agent.stop());
    expect(await agent.available()).toBe(true);
    const monitor = new HarnessMonitor(() => [{ id: "server", kind: remote.kind, options: {} }]);
    expect(await monitor.ensure("server")).toMatchObject({ available: true, binary: null });
    await agent.send({ text: "one" });
    expect(agent.busy()).toBe(false);
    const instance = providerRegistry.instances().find(value => value.instanceId === "server")!;
    const health = vi.spyOn(instance, "health").mockResolvedValue({ ...await remote.health({}), version: "live-server" });
    try {
      const liveMonitor = new HarnessMonitor(() => [{ id: "server", kind: remote.kind, options: {}, health: () => agent.health() }]);
      expect((await liveMonitor.ensure("server")).version).toBe("live-server");
      expect(health).toHaveBeenCalledOnce();
    } finally { health.mockRestore(); }
    expect(packetBudget(remote.kind)).toBe(10_000);
  });
  it("changes cursor ownership when the account changes, and fences opaque records", async () => {
    const registry = new ProviderRegistry([remote]), service = new ProviderService(new MemorySessionDirectory());
    close.push(() => service.stopAll());
    const first = await registry.create(remote.kind, "same-id", { account: "a" }, environment("/server"));
    service.register(first.adapter, first);
    await service.ensureSession({ threadId: "main", instanceId: "same-id", cwd: "/server", runtimeMode: "approval-required" });
    expect(service.directory.get("main", "same-id")?.continuationKey).toBe(first.continuationIdentity.continuationKey);
    await service.stopSession("main", "same-id");
    expect((await service.ensureSession({ threadId: "main", instanceId: "same-id", cwd: "/server", runtimeMode: "approval-required" })).via).toBe("resumed");
    await service.unregister("same-id");
    const second = await registry.create(remote.kind, "same-id", { account: "b" }, environment("/server"));
    service.register(second.adapter, second);
    expect(() => service.planRollback("main", "same-id", 0, "/server")).toThrow(/different driver or account/);
    expect((await service.ensureSession({ threadId: "main", instanceId: "same-id", cwd: "/server", runtimeMode: "approval-required" })).via).toBe("fresh");
    expect(await registry.fenceRecovery({ writer: { ...second.continuationIdentity, identity: { type: "server-lease", value: "lease-1" } } })).toBe(true);
    expect(await registry.fenceRecovery({ writer: { driverKind: "missing", continuationKey: "k", identity: { type: "server-lease", value: "lease-1" } } })).toBe(false);
  });
  it("owns instance lifetime and retains a failed disposal for an ordinary retry", async () => {
    const registry = new ProviderRegistry([{ ...remote, metadata: { ...remote.metadata, supportsMultipleInstances: false } }]);
    const first = await registry.create(remote.kind, "one", {}, environment("/server"));
    await expect(registry.create(remote.kind, "two", {}, environment("/server"))).rejects.toThrow(/only one instance/);
    const stop = vi.spyOn(first.adapter, "stopAll").mockRejectedValueOnce(new NativeQuiescenceUnknown("server lease could not be fenced"));
    try {
      await expect(first.dispose()).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
      expect(registry.instances()).toEqual([first]);
      await first.dispose(); expect(registry.instances()).toEqual([]);
      const second = await registry.create(remote.kind, "two", {}, environment("/server")); await second.dispose();
    } finally { stop.mockRestore(); await first.dispose(); }
  });
  it("lets Brain prepare for a new driver without a core or runtime branch", async () => {
    const dir = makeProjectDir(), log = await EventLog.open(path.join(dir, ".loom")); close.push(() => log.close());
    const brain = new ContinuityEngine(log, "project");
    const prepare = async (model: string) => {
      const request = brain.capture({ id: crypto.randomUUID(), conversationId: "main", agentInstanceId: "server", text: "work", source: "user", model,
        plan: false, targetAddedTokens: 6000 }).request;
      return brain.prepare(request, remote.kind, dir, { model });
    };
    const first = await prepare("one"), next = await prepare("two");
    expect(first.packet.mode).toBe("reconstruction");
    expect(first.packet.snapshot.instructionFilesFingerprint).toBe(digest("server instructions"));
    expect(next.packet.target.id).not.toBe(first.packet.target.id);
  });
  it("dispatches and queues a registered server through the continuity runtime", async () => {
    process.env.LOOM_HOME = tmpDir("registry-runtime-home");
    const dir = makeProjectDir({ brain: { continuity: true, extractor: "off" },
      agents: [{ id: "server", kind: remote.kind, role: "executor" }] });
    const runtime = await ProjectRuntime.open({ id: "registry-runtime", name: "test", dir });
    close.push(() => runtime.close());
    expect(runtime.createChat("server model", { agentId: "server", model: "one" }).model).toBe("one");
    await runtime.sendMessage("server work", "server", { requestId: "remote-work" });
    const queued = runtime.enqueue({ text: "next work", target: { kind: "agent", agentId: "server" }, when: { kind: "at", at: Date.now() + 60_000 } });
    expect(queued.continuity?.requestId).toBeTruthy();
    expect((await runtime.status()).agents.find(a => a.id === "server")?.provider).toMatchObject({
      driverKind: remote.kind, accountKey: "test-server", limitsProvider: "test-server" });
  });
});

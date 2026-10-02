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
import { makeProjectDir, tmpDir, waitUntil } from "../helpers.js";
import { listModelsForKind } from "../../src/daemon/system.js";
import { setupReport } from "../../src/core/setup.js";
import * as ades from "../../src/core/ades.js";
import * as base from "../../src/adapters/base.js";

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

it("preserves explicit continuity ownership when Brain rebinds a cursor (B1)", async () => {
  const dir = makeProjectDir(), agent = new ProviderAgent("rebind", remote.kind, dir, { account: "work" });
  close.push(() => agent.stop());
  await agent.send({ text: "one" });
  const service = (agent as unknown as { providers: { service: ProviderService } }).providers.service;
  await (agent as unknown as { bindContinuity(service: ProviderService, chat: string, cursor: string): Promise<void> }).bindContinuity(service, "main", "brain-cursor");
  expect(service.directory.get("main", "rebind")?.continuationKey).toBe("rebind:work");
  expect((await service.ensureSession({ threadId: "main", instanceId: "rebind", cwd: dir, runtimeMode: "auto-accept-edits", onMissingSession: "fail" })).via).toBe("resumed");
});

it("resumes an omitted persisted default model when runtime requests null (B2)", async () => {
  const directory = new MemorySessionDirectory(), service = new ProviderService(directory);
  const adapter = new FakeAdapter("default-model", { capabilities: { sessionModelSwitch: "restart" } });
  service.register(adapter); close.push(() => service.stopAll());
  const input = { threadId: "main", instanceId: adapter.instanceId, cwd: "/server", runtimeMode: "auto-accept-edits" as const, model: null };
  const first = await service.ensureSession(input); await service.stopSession("main", adapter.instanceId);
  expect(directory.get("main", adapter.instanceId)?.runtimePayload?.model).toBeUndefined();
  const resumed = await service.ensureSession(input);
  expect(resumed.via).toBe("resumed"); expect(resumed.session.resumeCursor).toBe(first.session.resumeCursor);
  await service.stopSession("main", adapter.instanceId);
  expect((await service.ensureSession({ ...input, model: "other" })).via).toBe("fresh");
});

it("qualifies identical account labels by driver for limits and suggestions (B3)", () => {
  const usage = new NativeUsage();
  usage.observe({ kind: "status", agentId: "claude", ts: 1, payload: { state: "usage_limits", provider: "claude", accountKey: "work", windows: [], reached: "five_hour" } });
  usage.observe({ kind: "status", agentId: "codex", ts: 2, payload: { state: "usage_limits", provider: "codex", accountKey: "work", windows: [] } });
  expect(usage.limitsFor("claude-code", "work")?.reached).toBe("five_hour");
  expect(usage.limitsFor("codex", "work")?.reached).toBeNull();
  expect(providerRegistry.accountIdentity("codex", { accountKey: "work" })).not.toBe(providerRegistry.accountIdentity("claude-code", { accountKey: "work" }));
});

it("retains mismatched factory writers when disposal fails and exposes a retry (B4)", async () => {
  const dispose = vi.fn().mockRejectedValueOnce(new NativeQuiescenceUnknown("unfenced")).mockResolvedValue(undefined);
  const registry = new ProviderRegistry([{ ...remote, async create(input) {
    return { ...await remote.create(input), accountKey: "wrong", dispose };
  } }]);
  await expect(registry.create(remote.kind, "bad", {}, environment("/server"))).rejects.toBeInstanceOf(NativeQuiescenceUnknown);
  expect(registry.instances()).toHaveLength(1);
  await expect(registry.create(remote.kind, "bad", {}, environment("/server"))).rejects.toThrow(/already materialized/);
  await registry.instances()[0]!.dispose(); expect(registry.instances()).toHaveLength(0);
  await expect(registry.create(remote.kind, "bad", {}, environment("/server"))).rejects.toThrow(/mismatched ownership/);
  expect(registry.instances()).toHaveLength(0);
});


it("discovers models using agent config and separates cached configurations (B5)", async () => {
  const models = vi.fn(async (config: Record<string, unknown>) => ({ models: [String(config.bin), String(config.account), String(config.endpoint)], source: "api" as const }));
  const driver = { ...remote, kind: "registry-model-test", models };
  providerRegistry.register(driver);
  const first = { bin: "first", account: "work", endpoint: "one" }, second = { ...first, endpoint: "two" };
  expect((await listModelsForKind(driver.kind, first)).models).toEqual(["first", "work", "one"]);
  expect((await listModelsForKind(driver.kind, second)).models).toEqual(["first", "work", "two"]);
  await listModelsForKind(driver.kind, { endpoint: "one", account: "work", bin: "first" });
  expect(models).toHaveBeenCalledTimes(2); expect(models).toHaveBeenCalledWith(first);
});

it("includes registered driver checks in setup without concrete core probes (B7)", async () => {
  const selfCheck = vi.fn(async () => [{ name: "installed", ok: true, detail: "server available" }, { name: "signed in", ok: false, detail: "sign in to server" }]);
  const driver = { ...remote, kind: "registry-setup-test", selfCheck };
  providerRegistry.register(driver);
  const detected = vi.spyOn(ades, "detectAdes").mockResolvedValue({});
  const builtins = builtInDrivers.map(driver => vi.spyOn(driver, "selfCheck").mockResolvedValue([{ name: "installed", ok: false, detail: "fake" }]));
  try {
    expect((await setupReport()).agents.find(a => a.kind === driver.kind)).toMatchObject({ found: true, authed: false, authDetail: "sign in to server" });
    expect(selfCheck).toHaveBeenCalledOnce();
  } finally { detected.mockRestore(); builtins.forEach(mock => mock.mockRestore()); }
});

it("uses the emitting driver when two drivers share a limits label (B3)", () => {
  const other = { ...remote, kind: "registry-shared-limits" };
  providerRegistry.register(other);
  const usage = new NativeUsage();
  const event = { kind: "status" as const, agentId: "a", ts: 1, payload: { state: "usage_limits", provider: "test-server", accountKey: "work", windows: [], reached: "blocked" } };
  usage.observe(event, remote.kind);
  usage.observe({ ...event, payload: { ...event.payload, reached: null } }, other.kind);
  expect(usage.limitsFor(remote.kind, "work")?.reached).toBe("blocked");
  expect(usage.limitsFor(other.kind, "work")?.reached).toBeNull();
});

it("lets ordinary Stop retry fencing a rejected factory result (B4)", async () => {
  const dispose = vi.fn().mockRejectedValueOnce(new NativeQuiescenceUnknown("unfenced")).mockResolvedValue(undefined);
  let mismatch = true;
  const driver = { ...remote, kind: "registry-rejected-factory", async create(input: Parameters<typeof remote.create>[0]) {
    const adapter = new FakeAdapter(input.instanceId, { provider: this.kind });
    return { ...await remote.create(input), driverKind: this.kind, adapter,
      continuationIdentity: { driverKind: this.kind, continuationKey: "test" }, accountKey: mismatch ? "wrong" : remote.accountKey(input.config), dispose };
  }, continuationIdentity: () => ({ driverKind: "registry-rejected-factory", continuationKey: "test" }) };
  providerRegistry.register(driver);
  const agent = new ProviderAgent("rejected", driver.kind, makeProjectDir()); close.push(() => agent.stop());
  await expect(agent.send({ text: "one" })).rejects.toThrow();
  expect(providerRegistry.instances().some(instance => instance.instanceId === "rejected")).toBe(true);
  expect(agent.busy()).toBe(true);
  await agent.interrupt(); expect(agent.busy()).toBe(false);
  expect(providerRegistry.instances().some(instance => instance.instanceId === "rejected")).toBe(false);
  mismatch = false; await agent.send({ text: "retry" }); expect(agent.busy()).toBe(false);
});


it("uses Claude's offline auth status check and preserves unknown auth (B7)", async () => {
  const driver = providerRegistry.require("claude-code"), bin = path.join(tmpDir("auth-check"), "claude");
  fs.writeFileSync(bin, "fake binary");
  const output = vi.spyOn(base, "cliOutput").mockImplementation(async (_bin, args) => ({ code: 0, out: args.includes("--version") ? "Claude Code fake" : '{"loggedIn":false}' }));
  try {
    expect(await driver.selfCheck({ bin })).toContainEqual({ name: "signed in", ok: false, detail: "not signed in — run: claude /login" });
    expect(output.mock.calls.map(call => call[1])).toEqual([["--version"], ["auth", "status", "--json"]]);
    output.mockResolvedValue({ code: 1, out: "unsupported command" });
    expect((await driver.selfCheck({ bin })).some(check => check.name === "signed in")).toBe(false);
  } finally { output.mockRestore(); }
});

it("shares concurrent disposal and cannot release a replacement's ownership (#1)", async () => {
  let release!: () => void;
  const dispose = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const registry = new ProviderRegistry([{ ...remote, async create(input) { return { ...await remote.create(input), dispose }; } }]);
  const first = await registry.create(remote.kind, "same", {}, environment("/server"));
  const a = first.dispose(), b = first.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  await expect(registry.create(remote.kind, "same", {}, environment("/server"))).rejects.toThrow(/already materialized/);
  release(); await a;
  const replacement = await registry.create(remote.kind, "same", {}, environment("/server"));
  await b;
  expect(registry.instances()).toEqual([replacement]);
  await expect(registry.create(remote.kind, "same", {}, environment("/server"))).rejects.toThrow(/already materialized/);
  const stop = replacement.dispose(); release(); await stop;
});

it("retains a resolved default across live turns and a cold directory reload (#2)", async () => {
  const directory = new FileSessionDirectory(tmpDir("resolved-default"));
  const adapter = new FakeAdapter("resolved", { capabilities: { sessionModelSwitch: "restart" } });
  const start = adapter.startSession.bind(adapter), list = adapter.listSessions.bind(adapter);
  vi.spyOn(adapter, "listSessions").mockImplementation(() => list().map(session => ({ ...session, model: session.model ?? "actual-default" })));
  vi.spyOn(adapter, "startSession").mockImplementation(async input => {
    const session = await start(input); session.model = input.modelSelection?.model ?? "actual-default"; return session;
  });
  const service = new ProviderService(directory); service.register(adapter);
  const input = { threadId: "main", instanceId: adapter.instanceId, cwd: "/server", runtimeMode: "auto-accept-edits" as const, model: null };
  const first = await service.ensureSession(input);
  expect((await service.ensureSession(input)).via).toBe("live");
  await service.stopAll();
  const cold = new ProviderService(new FileSessionDirectory(path.dirname(path.dirname(directory.file)))); cold.register(adapter);
  close.push(() => cold.stopAll());
  expect((await cold.ensureSession(input)).session.resumeCursor).toBe(first.session.resumeCursor);
  expect((await cold.ensureSession({ ...input, model: "named" })).via).toBe("fresh");
  expect((await cold.ensureSession(input)).via).toBe("fresh");
});

it("opens a project with an unavailable driver and preserves normal recovery (#9)", async () => {
  process.env.LOOM_HOME = tmpDir("missing-driver-home");
  const dir = makeProjectDir({ agents: [{ id: "missing", kind: "retired-driver" }, { id: "echo", kind: "echo" }] });
  const runtime = await ProjectRuntime.open({ id: "missing-driver", name: "test", dir });
  close.push(() => runtime.close());
  expect((await runtime.status()).agents.find(a => a.id === "missing")).toMatchObject({ available: false, enabled: true, busy: false });
  await expect(createAgent({ id: "missing", kind: "retired-driver" }, dir).available()).resolves.toBe(false);
  const unavailable = createAgent({ id: "missing", kind: "retired-driver" }, dir) as import("../../src/types.js").Adapter;
  await expect(unavailable.send({ text: "work" })).rejects.toThrow(/unavailable/);
  await runtime.sendMessage("work", "echo");
  expect(runtime.config.agents.find(a => a.id === "missing")?.kind).toBe("retired-driver");
});

it("replays historical usage without the current driver's account identity (#5)", () => {
  const usage = new NativeUsage();
  usage.observe({ kind: "status", agentId: "switched", ts: 1, payload: { state: "usage_limits", provider: "claude", accountKey: "work", windows: [], reached: "five_hour" } });
  expect(usage.limitsFor("codex", "work")).toBeNull();
  expect(usage.limitsFor("claude-code", "work")?.reached).toBe("five_hour");
});

it("derives memory, review vendor and internal transport from driver records (#11)", async () => {
  const { nativeMemoryFiles } = await import("../../src/core/memory.js");
  const { vendorOf } = await import("../../src/core/team-landing.js");
  const { claudeText } = await import("../../src/core/claude-cli.js");
  const driver = providerRegistry.require("claude-code");
  const internal = vi.spyOn(driver, "internalText").mockResolvedValue("fake internal answer");
  try {
    expect(nativeMemoryFiles({ id: "claude", kind: driver.kind })).toEqual(driver.presentation!.memoryFiles);
    expect(vendorOf(driver.kind)).toBe(driver.presentation!.vendor);
    expect(await claudeText("question", { model: "fake" })).toBe("fake internal answer");
    expect(internal).toHaveBeenCalledWith("question", { model: "fake" });
    expect(driver.orchestratorOptions!({ extraArgs: ["existing"] }).extraArgs).toEqual(expect.arrayContaining(["existing", "--allowedTools"]));
    expect(driver.auxiliary!.command("ask", { mcpConfigPath: "fake.json" }).args("question")).toContain("fake.json");
    expect(driver.auxiliary!.command("decision").args("question")).toContain("haiku");
  } finally { internal.mockRestore(); }
});

it("uses registered policy records for a driver with no built-in core branches (#11)", async () => {
  const driver = { ...remote, kind: "registry-policy-record", presentation: { vendor: "new-vendor", memoryFiles: ["REMOTE.md"],
    aliases: ["remote alias"], blurb: "Remote policy from its driver" } };
  providerRegistry.register(driver);
  const { nativeMemoryFiles } = await import("../../src/core/memory.js");
  const { vendorOf } = await import("../../src/core/team-landing.js");
  const { OrchestraEngine, orchestratorBriefing } = await import("../../src/core/orchestra.js");
  const cfg = { id: "remote-worker", kind: driver.kind };
  expect(nativeMemoryFiles(cfg)).toEqual(["REMOTE.md"]); expect(vendorOf(driver.kind)).toBe("new-vendor");
  const resolved = OrchestraEngine.prototype.resolveAgent.call({ host: { roster: () => [cfg], installedKinds: () => [] } } as any, "remote alias");
  expect(resolved).toBe(cfg);
  expect(orchestratorBriefing({ project: "test", goal: "work", workers: [cfg] } as any)).toContain("Remote policy from its driver");
});

it("preserves explicit historical usage ownership for an unavailable driver (#5)", () => {
  const usage = new NativeUsage();
  usage.observe({ kind: "status", agentId: "switched", ts: 1, payload: { state: "usage_limits", provider: "codex",
    driverKind: "retired-usage-driver", accountKey: "work", reachedScope: "window", windows: [], reached: "old" } });
  expect(usage.limitsFor("codex", "work")).toBeNull();
  expect(usage.limitsFor("retired-usage-driver", "work")?.reached).toBe("old");
});

it("concurrent Stop releases a shared service only once (#1)", async () => {
  const dir = makeProjectDir();
  const first = new ProviderAgent("first", remote.kind, dir), second = new ProviderAgent("second", remote.kind, dir);
  close.push(() => second.stop(), () => first.stop());
  await first.send({ text: "attach first" }); await second.send({ text: "attach second" });
  const shared = (first as any).providers;
  const unregister = shared.service.unregister.bind(shared.service);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopping = vi.spyOn(shared.service, "unregister").mockImplementation(async (id: any) => { await gate; await unregister(id); });
  const reaperStop = vi.spyOn(shared.reaper, "stop");
  const a = first.stop(), b = first.stop();
  await waitUntil(() => stopping.mock.calls.length > 0);
  release(); await Promise.all([a, b]);
  expect(stopping).toHaveBeenCalledTimes(1);
  expect(shared.refs).toBe(1); expect(reaperStop).not.toHaveBeenCalled();
  const third = new ProviderAgent("third", remote.kind, dir); close.push(() => third.stop());
  await third.send({ text: "attach third" }); expect((third as any).providers).toBe(shared);
  await second.send({ text: "still attached" });
});

it("restores and pauses queued prompts for an unavailable driver (#2)", async () => {
  process.env.LOOM_HOME = tmpDir("missing-queue-home");
  const dir = makeProjectDir({ agents: [{ id: "missing", kind: "retired-driver" }, { id: "echo", kind: "echo" }] });
  const runtime = await ProjectRuntime.open({ id: "missing-queue", name: "test", dir });
  close.push(() => runtime.close());
  await expect(runtime.sendMessage("direct", "missing")).rejects.toThrow(/unavailable/);
  runtime.queue.setPaused(true);
  const first = runtime.enqueue({ text: "keep one", target: { kind: "agent", agentId: "missing" } });
  const second = runtime.enqueue({ text: "keep two", target: { kind: "agent", agentId: "missing" } });
  runtime.queue.setPaused(false);
  await runtime.drainPromptQueue();
  expect(runtime.queue.snapshot()).toMatchObject({ paused: true, reason: expect.stringContaining("unavailable"), items: [first, second] });
  expect(runtime.log.list({ kinds: ["message"] })).toEqual([]);
  runtime.editQueued(first.id, { target: { kind: "agent", agentId: "echo" } });
  runtime.queue.setPaused(false); await runtime.drainPromptQueue();
  expect(runtime.log.list({ kinds: ["message"] }).some(e => e.payload.text === "keep one")).toBe(true);
});

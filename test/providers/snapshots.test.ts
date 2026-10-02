/**
 * Live provider snapshots: refreshed when needed, kept when a probe fails,
 * and published only when something changed. A fake driver stands in for the
 * harness; no real CLI is started.
 */
import { afterEach, describe, expect, it } from "vitest";
import { builtInDrivers } from "../../src/providers/builtInDrivers.js";
import { providerRegistry } from "../../src/providers/registry.js";
import type { ProviderDriver } from "../../src/providers/driver.js";
import type { ProviderProbe } from "../../src/providers/probe.js";
import { claudeAuth, claudeModels, codexAuth, codexModels } from "../../src/providers/probe.js";
import { ProviderSnapshots, type SnapshotTarget } from "../../src/providers/snapshots.js";

const base = builtInDrivers.find(d => d.kind === "codex")!;
let probes = 0;
let next: () => Promise<ProviderProbe> = async () => ({ auth: { status: "signed-in", account: "a@b.c" }, models: [{ id: "m1" }], modelSource: "native" });
let available = true;
const fake: ProviderDriver<Record<string, unknown>> = {
  ...base, kind: "snapshot-fake", configSchema: { parse: (v: unknown) => (v ?? {}) as Record<string, unknown> },
  async health() { return { kind: "snapshot-fake", available, version: "1.2.3", tested: false, binary: null, fingerprint: null, checkedAt: Date.now(), ...(available ? {} : { error: "not installed" }) }; },
  async probe() { probes++; return next(); },
  async models() { return { models: ["fallback"], source: "builtin" }; },
};
providerRegistry.register(fake);

const open: ProviderSnapshots[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); probes = 0; available = true;
  next = async () => ({ auth: { status: "signed-in", account: "a@b.c" }, models: [{ id: "m1" }], modelSource: "native" }); });

function service(targets: SnapshotTarget[], demand = () => true, intervalMs = 60_000) {
  const s = new ProviderSnapshots({ targets: () => targets, cwd: () => "/tmp", hasDemand: demand }, intervalMs);
  open.push(s);
  return s;
}

describe("provider snapshots", () => {
  it("reports the harness's version, sign-in and models", async () => {
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }]);
    await s.sync();
    expect(s.get("a")).toMatchObject({ status: "ready", version: "1.2.3", auth: { status: "signed-in", account: "a@b.c" },
      models: [{ id: "m1" }], modelSource: "native" });
  });

  it("probes again only for a new or reconfigured agent, unless forced", async () => {
    const targets: SnapshotTarget[] = [{ id: "a", kind: "snapshot-fake", options: {} }];
    const s = service(targets);
    await s.sync();
    await s.sync();
    expect(probes).toBe(1);
    targets[0] = { ...targets[0]!, options: { bin: "/other" } };
    await s.sync();
    expect(probes).toBe(2);
    await s.sync({ force: true });
    expect(probes).toBe(3);
  });

  it("publishes a changed model list and nothing when the content is the same", async () => {
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }]);
    const seen: string[][] = [];
    s.onChange(list => seen.push(list.flatMap(p => p.models.map(m => m.id))));
    await s.sync();
    const after = seen.length;
    await s.sync({ force: true });
    expect(seen.length).toBe(after);
    next = async () => ({ auth: { status: "signed-in", account: "a@b.c" }, models: [{ id: "m1" }, { id: "m2" }], modelSource: "native" });
    await s.sync({ force: true });
    expect(seen.at(-1)).toEqual(["m1", "m2"]);
  });

  it("keeps the last models and sign-in when a probe fails", async () => {
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }]);
    await s.sync();
    next = async () => ({ auth: { status: "unknown" }, models: [], modelSource: "none", error: "timed out" });
    await s.sync({ force: true });
    expect(s.get("a")).toMatchObject({ status: "error", error: "timed out", models: [{ id: "m1" }], auth: { account: "a@b.c" } });
  });

  it("falls back to the driver's offline list when the harness reports none", async () => {
    next = async () => ({ auth: { status: "unknown" }, models: [], modelSource: "none", error: "no answer" });
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }]);
    await s.sync();
    expect(s.get("a")).toMatchObject({ models: [{ id: "fallback" }], modelSource: "builtin" });
  });

  it("says a missing harness is unavailable without probing it", async () => {
    available = false;
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }]);
    await s.sync();
    expect(s.get("a")).toMatchObject({ status: "unavailable", error: "not installed" });
    expect(probes).toBe(0);
  });

  it("shares one probe between concurrent refreshes", async () => {
    let release!: () => void;
    next = () => new Promise(resolve => { release = () => resolve({ auth: { status: "signed-in" }, models: [{ id: "m1" }], modelSource: "native" }); });
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }]);
    const first = s.refresh("a"), second = s.refresh("a");
    await new Promise(r => setTimeout(r, 10));
    release();
    await Promise.all([first, second]);
    expect(probes).toBe(1);
  });

  it("drops a removed agent and discards a probe that finishes after it changed", async () => {
    const targets: SnapshotTarget[] = [{ id: "a", kind: "snapshot-fake", options: {} }];
    let release!: () => void;
    next = () => new Promise(resolve => { release = () => resolve({ auth: { status: "signed-in" }, models: [{ id: "stale" }], modelSource: "native" }); });
    const s = service(targets);
    const pending = s.refresh("a");
    await new Promise(r => setTimeout(r, 10));
    targets.splice(0);
    await s.sync();
    release();
    await pending;
    expect(s.list()).toEqual([]);
  });

  it("refreshes on the interval only while someone is watching", async () => {
    let watching = false;
    const s = service([{ id: "a", kind: "snapshot-fake", options: {} }], () => watching, 30);
    s.start();
    await new Promise(r => setTimeout(r, 120));
    const idle = probes;
    expect(idle).toBe(1); // the start-up probe only
    watching = true;
    await new Promise(r => setTimeout(r, 120));
    expect(probes).toBeGreaterThan(idle);
  });
});

describe("probe replies", () => {
  it("reads Codex's account and every page of models", () => {
    expect(codexAuth({ account: { type: "chatgpt", email: "x@y.z", planType: "plus" } })).toEqual({ status: "signed-in", account: "x@y.z", plan: "ChatGPT Plus" });
    expect(codexAuth({ account: { type: "apiKey" } })).toEqual({ status: "signed-in", plan: "OpenAI API key" });
    expect(codexAuth({ account: null, requiresOpenaiAuth: true })).toEqual({ status: "signed-out" });
    expect(codexModels([{ data: [{ model: "gpt-a", displayName: "GPT A", isDefault: true }] }, { data: [{ model: "gpt-b" }, { nope: 1 }] }]))
      .toEqual([{ id: "gpt-a", name: "GPT A", isDefault: true }, { id: "gpt-b" }]);
  });

  it("reads Claude's account and models from initialization", () => {
    expect(claudeAuth({ email: "c@d.e", subscriptionType: "max" })).toEqual({ status: "signed-in", account: "c@d.e", plan: "max" });
    expect(claudeAuth({ apiProvider: "bedrock" })).toEqual({ status: "signed-in", plan: "bedrock" });
    expect(claudeAuth({})).toEqual({ status: "signed-out" });
    expect(claudeModels([{ value: "default", resolvedModel: "claude-opus-5" }, { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" }, { value: "" }]))
      .toEqual([{ id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5" }]);
  });
});

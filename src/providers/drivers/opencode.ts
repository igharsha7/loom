import fs from "node:fs";
import { z } from "zod";
import type { ProviderDriver, WriterIdentity } from "../driver.js";
import { nativeConfigSchema, continuity, localChecks, localInstance } from "./local.js";
import { opencodeInstructions } from "./instructions.js";
import { OpenCodeProviderAdapter, opencodeCapabilities } from "../opencode/adapter.js";
import { cliOutput, firstLine } from "../../adapters/base.js";
import { launched, processGroupIdentity, spawnHarness, stopHarness, stopRecordedProcessGroup } from "../process.js";
import { freePort } from "../../adapters/base.js";
import { digest } from "../../core/continuity/contracts.js";
import type { ProviderProbe } from "../probe.js";

/** The opencode binary: an explicit override, else `opencode` on PATH. */
export function opencodeBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  return "opencode";
}

export const opencodeConfigSchema = nativeConfigSchema.extend({ baseUrl: z.string().url().optional(), agent: z.string().optional(),
  pollMs: z.number().int().positive().optional(), turnTimeoutMs: z.number().int().positive().optional() });
export type OpenCodeConfig = z.infer<typeof opencodeConfigSchema>;

const PROTOCOL = "opencode-serve-api-v2";
const checks = localChecks("opencode", opencodeBin, PROTOCOL, "opencode", " (curl -fsSL https://opencode.ai/install | bash)");
const base = (url: string) => url.replace(/\/$/, "");

async function serverHealthy(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${base(url)}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? null : `opencode server at ${url} answered ${res.status}`;
  } catch (error) {
    return `opencode server at ${url} is not reachable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
  }
}

/** Models and providers from a running server; `/api/model` fills in shortly after start. */
async function readServer(url: string): Promise<ProviderProbe> {
  const get = async (path: string) => ((await (await fetch(`${base(url)}${path}`, { signal: AbortSignal.timeout(5000) })).json()) as { data?: unknown }).data;
  let models: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 20 && !models.length; i++) {
    const data = await get("/api/model").catch(() => undefined);
    models = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    if (!models.length) await new Promise(r => setTimeout(r, 250));
  }
  const providers = await get("/api/provider").catch(() => undefined);
  const providerNames = new Map((Array.isArray(providers) ? providers as Array<Record<string, unknown>> : [])
    .map(p => [String(p.id ?? ""), String(p.name ?? p.id ?? "")] as const).filter(([id]) => id));
  // OpenCode decides what is usable: its free models need no sign-in, Zen and Go
  // are its subscriptions, and any connected provider adds its own models.
  const list = models.filter(m => typeof m.providerID === "string" && typeof m.id === "string" && m.enabled !== false && m.status !== "deprecated")
    .map(m => {
      const costs = Array.isArray(m.cost) ? m.cost as Array<Record<string, unknown>> : [];
      const free = costs.length > 0 && costs.every(c => !Number(c.input) && !Number(c.output));
      const provider = providerNames.get(String(m.providerID)) ?? String(m.providerID);
      return { id: `${m.providerID}/${m.id}`, ...(typeof m.name === "string" ? { name: m.name } : {}), provider, ...(free ? { free: true } : {}) };
    });
  const names = [...new Set(providerNames.values())];
  return { auth: { status: "signed-in", ...(names.length ? { plan: names.join(", ") } : {}) }, models: list, modelSource: list.length ? "native" : "none" };
}

/** A recorded session's writers stop: Loom's own server is ended; another's session is interrupted until idle. */
async function fenceOpenCode(identity: WriterIdentity): Promise<boolean> {
  if (identity.type !== "opencode-session" || !identity.value || typeof identity.value !== "object") return false;
  const v = identity.value as { baseUrl?: string; sessionId?: string; processGroupId?: number; processIdentity?: string };
  if (v.processGroupId) return stopRecordedProcessGroup({ processGroupId: v.processGroupId, ...(v.processIdentity ? { processIdentity: v.processIdentity } : {}) });
  if (!v.baseUrl || !v.sessionId) return false;
  const url = base(v.baseUrl);
  try {
    await fetch(`${url}/api/session/${encodeURIComponent(v.sessionId)}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${url}/api/session/active`, { signal: AbortSignal.timeout(5000) });
      const active = ((await res.json()) as { data?: Record<string, unknown> }).data;
      if (res.ok && active && !Object.prototype.hasOwnProperty.call(active, v.sessionId)) return true;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch { /* unreachable: unproven */ }
  return false;
}

export const opencodeDriver: ProviderDriver<OpenCodeConfig> = {
  kind: "opencode", metadata: { displayName: "OpenCode", supportsMultipleInstances: true },
  presentation: { vendor: "opencode", aliases: ["opencode", "open code"], memoryFiles: ["AGENTS.md", ".opencode/AGENTS.md", "opencode.md"],
    blurb: "OpenCode: open-model agent, good for well-specified tasks",
    installHint: "curl -fsSL https://opencode.ai/install | bash", loginHint: "opencode auth login" },
  configSchema: opencodeConfigSchema, defaultConfig: () => ({}), capabilities: opencodeCapabilities,
  permissions: {
    default: "auto",
    modes: {
      bypass: { flags: 'permission: {"*":"allow"}', label: "Bypass — every tool allowed" },
      auto: { flags: "opencode defaults", label: "Auto — opencode's own defaults" },
      ask: {
        flags: "—",
        label: "Ask — not available for OpenCode",
        unsupported:
          "opencode 1.18.31's headless API ignores both a deny-all permission config and its read-only plan agent — a file write went through",
      },
    },
  },
  continuity: continuity("opencode", 200_000, opencodeInstructions), limits: { provider: "opencode", reachedScope: "account" },
  continuationIdentity: (id, config) => ({ driverKind: "opencode", continuationKey: config.continuationKey
    ?? (config.baseUrl ? `opencode:server:${base(config.baseUrl)}:instance:${id}` : config.accountKey ? `opencode:account:${config.accountKey}:instance:${id}` : `opencode:instance:${id}`) }),
  accountKey: config => config.accountKey ?? "opencode",
  async available(config) { return config.baseUrl ? (await serverHealthy(config.baseUrl)) === null : checks.available(config); },
  async health(config) {
    if (!config.baseUrl) { const health = await checks.health(config); return { ...health, tested: health.version === "1.18.31" || health.version === "1.18.34" }; }
    // An agent pointed at a running server is as reachable as that server.
    const error = await serverHealthy(config.baseUrl), checkedAt = Date.now();
    return error ? { kind: "opencode", available: false, version: null, tested: false, binary: null, fingerprint: null, error, checkedAt }
      : { kind: "opencode", available: true, version: null, tested: false, binary: null, fingerprint: digest(JSON.stringify([base(config.baseUrl), PROTOCOL])), checkedAt };
  },
  async selfCheck(config) {
    if (config.baseUrl) {
      const error = await serverHealthy(config.baseUrl);
      return [{ name: "server", ok: !error, detail: error ?? `uses the opencode server at ${config.baseUrl}` }];
    }
    const result = await checks.selfCheck(config), bin = opencodeBin(config.bin);
    if (bin && result[0]?.ok) {
      const out = await cliOutput(bin, ["auth", "list"]);
      const providers = (out?.out ?? "").split("\n")
        .map(l => /[●•]\s+(.+?)(?:\s{2,}|\s+(?:api|oauth|wellknown)\s*$|$)/.exec(l)?.[1]?.trim())
        .filter((x): x is string => !!x)
        // the environment section names the variable too ("OpenRouter OPENROUTER_API_KEY")
        .map(x => x.replace(/\s+[A-Z][A-Z0-9_]{2,}$/, ""))
        .filter((x, i, all) => all.indexOf(x) === i);
      // OpenCode's own free models need no sign-in, so none is a note, not a failure.
      result.push({ name: "providers", ok: true, detail: providers.length ? `signed in to ${providers.join(", ")}` : "no providers signed in — its free models still work" });
    }
    return result;
  },
  // The offline list is `opencode models`, read by daemon/system.ts listModelsForKind.
  async probe(config, cwd) {
    if (config.baseUrl) {
      const error = await serverHealthy(config.baseUrl);
      return error ? { auth: { status: "unknown" }, models: [], modelSource: "none", error } : readServer(config.baseUrl);
    }
    const bin = opencodeBin(config.bin);
    if (!bin) return { auth: { status: "unknown" }, models: [], modelSource: "none", error: "opencode CLI not found" };
    const port = await freePort();
    const proc = spawnHarness(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd });
    try {
      await launched(proc.child);
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 20_000;
      while ((await serverHealthy(url)) !== null) {
        if (Date.now() > deadline || proc.child.exitCode !== null) return { auth: { status: "unknown" }, models: [], modelSource: "none", error: "opencode serve did not start" };
        await new Promise(r => setTimeout(r, 200));
      }
      return await readServer(url);
    } catch (error) {
      return { auth: { status: "unknown" }, models: [], modelSource: "none", error: error instanceof Error ? error.message : String(error) };
    } finally { await stopHarness(proc, 0).catch(() => {}); }
  },
  recoveryIdentity(session) {
    const identity = session.writerIdentity;
    if (!identity || identity.type !== "opencode-session") return undefined;
    const value = identity.value as { processGroupId?: number };
    if (!value.processGroupId) return identity;
    const processIdentity = processGroupIdentity(value.processGroupId);
    return processIdentity ? { type: identity.type, value: { ...value, processIdentity } } : identity;
  },
  fence: fenceOpenCode,
  async create(input) {
    const config = input.config;
    const adapter = new OpenCodeProviderAdapter(input.instanceId, { ...(config.bin ? { bin: opencodeBin(config.bin) ?? config.bin } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.extraArgs ? { extraArgs: config.extraArgs } : {}),
      ...(config.model ? { model: config.model } : {}), ...(config.agent ? { agent: config.agent } : {}),
      ...(config.pollMs ? { pollMs: config.pollMs } : {}), ...(config.turnTimeoutMs ? { turnTimeoutMs: config.turnTimeoutMs } : {}) });
    return localInstance(opencodeDriver as never, input as never, adapter);
  },
};

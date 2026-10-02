import type { ProviderDriver } from "../driver.js";
import { nativeConfigSchema, continuity, localChecks, localInstance, localRecoveryIdentity, fenceLocal, type NativeConfig } from "./local.js";
import { CodexProviderAdapter, codexBin } from "../codex/adapter.js";
import { codexCapabilities } from "./capabilities.js";
import { cliOutput, firstLine } from "../../adapters/base.js";
import type { Json } from "../codex/rpc.js";
import { CODEX_MODELS, codexModelCatalog } from "./models.js";
import { probeCodex } from "../probe.js";
const checks = localChecks("codex", codexBin, "codex-app-server-v2", "codex", " or open Codex.app once");
export const codexDriver: ProviderDriver<NativeConfig> = {
  kind: "codex", metadata: { displayName: "Codex", supportsMultipleInstances: true },
  presentation: { vendor: "openai", aliases: ["chatgpt", "gpt", "openai"], memoryFiles: ["AGENTS.md", ".codex/AGENTS.md", "codex.md"],
    blurb: "Codex (OpenAI / ChatGPT): strong at implementation and running tests",
    installHint: "install Codex.app, or npm i -g @openai/codex", loginHint: "codex login" },
  configSchema: nativeConfigSchema, defaultConfig: () => ({}), capabilities: codexCapabilities,
  permissions: {
    default: "auto",
    modes: {
      bypass: { flags: "sandbox: danger-full-access, approvalPolicy: never", label: "Bypass — no sandbox, no approvals" },
      auto: { flags: "sandbox: workspace-write, approvalPolicy: never", label: "Auto — writes inside the project, sandboxed" },
      ask: { flags: "sandbox: read-only, approvalPolicy: untrusted", label: "Always ask — commands and edits wait for your approval in Loom", ask: "approvals" },
    },
  },
  continuity: continuity("codex", 272_000), limits: { provider: "codex", reachedScope: "account" },
  continuationIdentity: (id, config) => ({ driverKind: "codex", continuationKey: config.continuationKey ?? (config.accountKey ? `codex:account:${config.accountKey}:instance:${id}` : `codex:instance:${id}`) }),
  accountKey: config => config.accountKey ?? "codex", available: checks.available,
  async health(config) { const health = await checks.health(config); return { ...health, tested: health.version === "0.153.4" }; },
  async selfCheck(config) {
    const result = await checks.selfCheck(config), bin = codexBin(config.bin);
    if (bin) { const out = await cliOutput(bin, ["login", "status"]);
      result.push({ name: "signed in", ok: out?.code === 0, detail: out ? firstLine(out.out) || (out.code === 0 ? "signed in" : "not signed in — run: codex login") : "couldn't ask codex" }); }
    return result;
  },
  async models(config) { const models = await codexModelCatalog(codexBin(config.bin) ?? "codex");
    return models.length ? { models, source: "cli" } : { models: CODEX_MODELS, source: "builtin" }; },
  async probe(config, cwd) {
    const bin = codexBin(config.bin);
    if (!bin) return { auth: { status: "unknown" }, models: [], modelSource: "none", error: "codex CLI not found" };
    return probeCodex(bin, { cwd, ...(config.extraArgs ? { extraArgs: config.extraArgs } : {}) });
  },
  recoveryIdentity: localRecoveryIdentity, fence: fenceLocal,
  async create(input) {
    const config = input.config;
    const adapter = new CodexProviderAdapter(input.instanceId, { bin: config.bin, extraArgs: config.extraArgs, sandbox: config.sandbox,
      mcpConfig: () => Object.fromEntries(input.environment.mcpServers().map(({ key, entry }) => [`mcp_servers.${key}`,
        (entry.type === "stdio" ? { command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) } : { url: entry.url }) as Json])) });
    return localInstance(codexDriver, input, adapter);
  },
};

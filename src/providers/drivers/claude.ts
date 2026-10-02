import type { ProviderDriver } from "../driver.js";
import { nativeConfigSchema, continuity, localChecks, localInstance, localRecoveryIdentity, fenceLocal, type NativeConfig } from "./local.js";
import { ClaudeProviderAdapter, claudeBin, type ClaudeHistory } from "../claude/adapter.js";
import { claudeCapabilities } from "./capabilities.js";
import { cliOutput } from "../../adapters/base.js";
import { CLAUDE_MODELS } from "./models.js";
const checks = localChecks("claude-code", claudeBin, "claude-agent-sdk-stream-json-v1", "claude");
export const claudeDriver: ProviderDriver<NativeConfig> = {
  kind: "claude-code", metadata: { displayName: "Claude Code", supportsMultipleInstances: true },
  configSchema: nativeConfigSchema, defaultConfig: () => ({}), capabilities: claudeCapabilities,
  permissions: {
    default: "auto",
    modes: {
      bypass: { flags: "permissionMode: bypassPermissions", label: "Bypass — runs any tool, never asks" },
      auto: { flags: "permissionMode: acceptEdits", label: "Auto — edits files; other tools only if pre-allowed" },
      ask: {
        flags: "permissionMode: default, canUseTool → Loom approvals",
        label: "Always ask — every tool call waits for your approval in Loom",
        ask: "approvals",
      },
    },
  },
  continuity: continuity("claude-code", 200_000), limits: { provider: "claude", reachedScope: "window" },
  continuationIdentity: (id, config) => ({ driverKind: "claude-code", continuationKey: config.continuationKey ?? (config.accountKey ? `claude-code:account:${config.accountKey}:instance:${id}` : `claude-code:instance:${id}`) }),
  accountKey: config => config.accountKey ?? "claude", available: checks.available,
  async health(config) { const health = await checks.health(config); return { ...health, tested: health.version === "2.1.278" }; },
  models: async () => ({ models: CLAUDE_MODELS, source: "builtin" }),
  async selfCheck(config) {
    const result = await checks.selfCheck(config), bin = claudeBin(config.bin);
    if (bin) {
      const out = await cliOutput(bin, ["auth", "status", "--json"]);
      let loggedIn: boolean | undefined;
      try { loggedIn = JSON.parse(out?.out ?? "").loggedIn; } catch { /* unknown */ }
      if (typeof loggedIn === "boolean") result.push({ name: "signed in", ok: loggedIn,
        detail: loggedIn ? "signed in" : "not signed in — run: claude /login" });
    }
    return result;
  }, recoveryIdentity: localRecoveryIdentity, fence: fenceLocal,
  async create(input) {
    const config = input.config;
    const adapter = new ClaudeProviderAdapter(input.instanceId, { bin: config.bin, extraArgs: config.extraArgs, permissionMode: config.permissionMode,
      ...(config.claudeHistory ? { history: config.claudeHistory as ClaudeHistory } : {}), canAsk: input.environment.canAsk,
      mcpServers: () => Object.fromEntries(input.environment.mcpServers().map(({ key, entry }) => [key,
        entry.type === "stdio" ? { type: "stdio" as const, command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) }
          : { type: entry.type, url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) }])) });
    return localInstance(claudeDriver, input, adapter);
  },
};

/**
 * What a provider says about itself right now: version, who is signed in, and
 * the models it offers. Asked of the harness, never remembered, the way t3code
 * builds its provider snapshots (provider/Layers/CodexProvider.ts,
 * ClaudeProvider.ts):
 *
 * - Codex: a short-lived `codex app-server`, `initialize`, `account/read` and
 *   every page of `model/list`.
 * - Claude Code: an Agent SDK query whose prompt never yields, so nothing
 *   reaches the API; `initializationResult()` carries the models and account.
 *   No session file, hooks or MCP servers, since this runs every few minutes.
 *
 * A probe never throws. What it couldn't learn is reported as such.
 */

import { query, type Options, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { CodexRpc, type Json } from "./codex/rpc.js";
import { launched, spawnHarness, stopHarness } from "./process.js";
import { agentEnv } from "../adapters/base.js";
import { VERSION } from "../version.js";

export interface ProviderModel { id: string; name?: string; isDefault?: boolean; resolvedModel?: string }
export interface ProviderAuth {
  status: "signed-in" | "signed-out" | "unknown";
  /** Email or account name, when the harness says. */
  account?: string;
  /** Plan or credential type, for example "ChatGPT Plus" or "API key". */
  plan?: string;
}
export interface ProviderProbe {
  auth: ProviderAuth;
  models: ProviderModel[];
  /** "native": the harness reported them; anything else is a fallback. */
  modelSource: "native" | "cli" | "builtin" | "none";
  error?: string;
}

const PROBE_TIMEOUT_MS = 20_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref();
  })]).finally(() => clearTimeout(timer));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Plan labels Codex reports in `account.planType` (t3code's codexPlanLabel). */
function codexPlan(planType: unknown): string | undefined {
  switch (planType) {
    case "free": return "ChatGPT Free";
    case "go": return "ChatGPT Go";
    case "plus": return "ChatGPT Plus";
    case "pro": return "ChatGPT Pro 20x";
    case "prolite": return "ChatGPT Pro 5x";
    case "team": return "ChatGPT Team";
    case "business": case "self_serve_business_prolite": case "self_serve_business_usage_based": return "ChatGPT Business";
    case "enterprise": case "ent26": case "enterprise_cbp_automation": case "enterprise_cbp_usage_based": return "ChatGPT Enterprise";
    case "edu": case "edu_plus": case "edu_pro": return "ChatGPT Edu";
    case "unknown": return "ChatGPT";
    default: return undefined;
  }
}

export function codexAuth(response: Json): ProviderAuth {
  const account = response.account as Json | null | undefined;
  if (!account) return { status: response.requiresOpenaiAuth === false ? "signed-in" : "signed-out" };
  if (account.type === "apiKey") return { status: "signed-in", plan: "OpenAI API key" };
  if (account.type === "amazonBedrock") return { status: "signed-in", plan: "Amazon Bedrock" };
  const plan = codexPlan(account.planType);
  return { status: "signed-in", ...(typeof account.email === "string" ? { account: account.email } : {}), ...(plan ? { plan } : {}) };
}

export function codexModels(pages: Json[]): ProviderModel[] {
  const models: ProviderModel[] = [];
  for (const page of pages) for (const entry of Array.isArray(page.data) ? page.data as Json[] : []) {
    if (typeof entry.model !== "string" || !entry.model) continue;
    models.push({ id: entry.model, ...(typeof entry.displayName === "string" ? { name: entry.displayName } : {}),
      ...(entry.isDefault === true ? { isDefault: true } : {}) });
  }
  return models;
}

export async function probeCodex(bin: string, options: { cwd: string; extraArgs?: string[] }): Promise<ProviderProbe> {
  let proc: ReturnType<typeof spawnHarness> | undefined;
  let rpc: CodexRpc | undefined;
  try {
    proc = spawnHarness(bin, ["app-server", ...(options.extraArgs ?? [])], { cwd: options.cwd });
    await launched(proc.child);
    const live = proc;
    rpc = new CodexRpc(live.child, {
      notification: () => {},
      // A probe takes no turns, so nothing it is asked can be granted.
      request: async () => { throw new Error("loom's provider probe answers no requests"); },
    });
    void live.closed.then(() => rpc?.close(new Error("codex app-server exited")));
    const client = rpc;
    return await within((async () => {
      await client.request("initialize", { clientInfo: { name: "loom", title: "Loom", version: VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false } });
      client.notify("initialized");
      const auth = await client.request("account/read", {}).then(codexAuth, () => ({ status: "unknown" } as ProviderAuth));
      const pages: Json[] = [];
      let cursor: unknown;
      do {
        const page = await client.request("model/list", typeof cursor === "string" ? { cursor } : {});
        pages.push(page);
        cursor = page.nextCursor;
      } while (typeof cursor === "string" && cursor && pages.length < 50);
      const models = codexModels(pages);
      return { auth, models, modelSource: models.length ? "native" : "none" } as ProviderProbe;
    })(), PROBE_TIMEOUT_MS, "codex app-server");
  } catch (error) {
    return { auth: { status: "unknown" }, models: [], modelSource: "none", error: message(error) };
  } finally {
    rpc?.close(new Error("probe finished"));
    if (proc) await stopHarness(proc, 1000).catch(() => {});
  }
}

export function claudeAuth(account: unknown): ProviderAuth {
  const a = (account ?? {}) as Record<string, unknown>;
  const name = typeof a.email === "string" ? a.email : typeof a.organization === "string" ? a.organization : undefined;
  // Third-party backends (Bedrock, Vertex, a gateway) authenticate outside Claude's login.
  const external = typeof a.apiProvider === "string" && a.apiProvider !== "firstParty" ? a.apiProvider : undefined;
  const plan = typeof a.subscriptionType === "string" ? a.subscriptionType
    : typeof a.apiKeySource === "string" || a.tokenSource === "apiKey" ? "API key" : external;
  if (!name && !plan && typeof a.tokenSource !== "string") return { status: "signed-out" };
  return { status: "signed-in", ...(name ? { account: name } : {}), ...(plan ? { plan } : {}) };
}

export function claudeModels(models: unknown): ProviderModel[] {
  return (Array.isArray(models) ? models : []).flatMap((m: Record<string, unknown>) =>
    // "default" is the picker's own Default row, not a model to list twice.
    typeof m?.value === "string" && m.value && m.value !== "default" ? [{ id: m.value,
      ...(typeof m.displayName === "string" ? { name: m.displayName } : {}),
      ...(typeof m.resolvedModel === "string" ? { resolvedModel: m.resolvedModel } : {}) }] : []);
}

export async function probeClaude(bin: string, options: { cwd: string }): Promise<ProviderProbe> {
  const abort = new AbortController();
  let proc: ReturnType<typeof spawnHarness> | undefined;
  // Never yields: only initialization is wanted, and no prompt may reach the API.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>(resolve => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
  })();
  const sdkOptions: Options = {
    cwd: options.cwd,
    pathToClaudeCodeExecutable: bin,
    abortController: abort,
    persistSession: false,
    settingSources: ["user", "project", "local"],
    // Runs every few minutes: the user's hooks and MCP servers must not.
    settings: { disableAllHooks: true },
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    env: { ...agentEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    spawnClaudeCodeProcess: spawnOptions => {
      proc = spawnHarness(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd ?? options.cwd, env: spawnOptions.env as NodeJS.ProcessEnv });
      const live = proc;
      spawnOptions.signal.addEventListener("abort", () => { void stopHarness(live, 0).catch(() => {}); }, { once: true });
      return live.child as unknown as SpawnedProcess;
    },
  } as Options;
  try {
    const q = query({ prompt, options: sdkOptions });
    const init = await within(q.initializationResult(), PROBE_TIMEOUT_MS, "claude");
    const models = claudeModels(init.models);
    return { auth: claudeAuth(init.account), models, modelSource: models.length ? "native" : "none" };
  } catch (error) {
    return { auth: { status: "unknown" }, models: [], modelSource: "none", error: message(error) };
  } finally {
    abort.abort();
    if (proc) await stopHarness(proc, 1000).catch(() => {});
  }
}

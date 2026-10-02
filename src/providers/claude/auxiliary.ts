import { spawn } from "node:child_process";
import os from "node:os";

const decisionModel = process.env.LOOM_DECISION_CLAUDE_MODEL || "haiku";
export function parseCliOutput(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { result?: unknown; is_error?: boolean };
    if (j.is_error) return null;
    const r = typeof j.result === "string" ? j.result.trim() : "";
    return r || null;
  } catch {
    return text; // not JSON — treat as plain text
  }
}
export function parseAnthropicText(json: unknown): string | null {
  const j = json as { content?: Array<{ type?: string; text?: string }> };
  const text = (j?.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("").trim();
  return text || null;
}
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || /^CLAUDE_CODE/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}
function claudeCli(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("claude", ["-p", prompt, "--output-format", "json"], {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: os.tmpdir(),
        env: cliEnv(),
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const kill = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 30_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => { clearTimeout(kill); resolve(parseCliOutput(out)); });
  });
}

export const claudeAuxiliary = {
  command(job: "ask" | "decision", options: { mcpConfigPath?: string } = {}) {
    return { bin: "claude", label: "claude", args(prompt: string) {
      if (job === "decision") return ["-p", prompt, "--output-format", "json", "--model", decisionModel];
      return ["-p", prompt, "--output-format", "text", ...(options.mcpConfigPath ? ["--mcp-config", options.mcpConfigPath] : [])];
    } };
  },
  async apiText(prompt: string, options: { apiKey: string; model: string; maxTokens: number }): Promise<string | null> {
    if (typeof globalThis.fetch !== "function") return null;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: options.model, max_tokens: options.maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      return res.ok ? parseAnthropicText(await res.json()) : null;
    } catch { return null; }
  },
  triageText: claudeCli,
};
